mod bridge;
mod platform;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    env, fs,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};
use tauri::{Manager, State};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tauri_plugin_notification::NotificationExt;
use tokio::sync::{mpsc, oneshot};
use tokio::time::timeout;

struct AppLifecycle {
    allow_exit: Arc<AtomicBool>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelConfiguration {
    api_key_configured: bool,
    grandpa_model_configured: bool,
    grandpa_model: Option<String>,
    minipa_model_configured: bool,
    minipa_model: Option<String>,
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SavedModelSettings {
    api_key_configured: bool,
    grandpa_model: Option<String>,
    minipa_model: Option<String>,
}

const DEFAULT_CAPTURE_SHORTCUT: &str = "CommandOrControl+Alt+Shift+Space";

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CaptureShortcutSettings {
    shortcut: String,
}

impl Default for CaptureShortcutSettings {
    fn default() -> Self {
        Self {
            shortcut: DEFAULT_CAPTURE_SHORTCUT.to_owned(),
        }
    }
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct NotificationPreferences {
    enabled: bool,
    task_completions: bool,
    reminders: bool,
    resurfaced_items: bool,
    problems: bool,
    updates: bool,
}

impl Default for NotificationPreferences {
    fn default() -> Self {
        Self {
            enabled: true,
            task_completions: true,
            reminders: true,
            resurfaced_items: true,
            problems: true,
            updates: true,
        }
    }
}

#[derive(Clone, Copy)]
enum NotificationCategory {
    Problems,
    Updates,
}

struct BridgeState {
    activity_tx: mpsc::Sender<platform::AgentActivity>,
    dump_tx: mpsc::Sender<bridge::DumpRequest>,
    pending_requests: bridge::PendingRequests,
    next_request_id: Arc<AtomicU64>,
    activity_paused: Arc<AtomicBool>,
}

/// Tauri commands to get the active window transparency and agent activity
#[tauri::command]
fn get_active_window_transparency() -> Result<Option<platform::ActiveWindowTransparency>, String> {
    // Get the active window info fully like this is say "lib.rs - Rust - Visual Studio Code"
    platform::active_window().map(|window| window.map(|window| window.transparency()))
}

#[tauri::command]
async fn get_agent_activity(
    state: State<'_, BridgeState>,
) -> Result<Option<platform::AgentActivity>, String> {
    if state.activity_paused.load(Ordering::Acquire) {
        return Ok(None);
    }

    // It catagorizes the activity of the agent based on the active window title and process name. For example, if the active window is "lib.rs - Rust - Visual Studio Code", it will categorize it as "Coding" activity.
    let activity = platform::active_window()?.map(|window| window.agent_activity());
    if let Some(activity) = activity.as_ref() {
        // A disconnected engine should not prevent React from receiving the category.
        if let Err(error) = state.activity_tx.try_send(activity.clone()) {
            eprintln!("Could not queue activity for the engine: {error}");
        }
    }
    Ok(activity)
}

#[tauri::command]
fn get_attention_monitoring_paused(state: State<'_, BridgeState>) -> bool {
    state.activity_paused.load(Ordering::Acquire)
}

#[tauri::command]
fn hide_capture_window(app: tauri::AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("capture")
        .ok_or_else(|| "The quick capture window is unavailable".to_owned())?;
    window
        .hide()
        .map_err(|error| format!("Could not hide the quick capture window: {error}"))
}

#[tauri::command]
fn get_capture_shortcut(app: tauri::AppHandle) -> Result<String, String> {
    Ok(load_capture_shortcut(&app)?.shortcut)
}

#[tauri::command]
fn save_capture_shortcut(app: tauri::AppHandle, shortcut: String) -> Result<String, String> {
    let shortcut = shortcut.trim();
    if shortcut.is_empty() || shortcut.len() > 128 || !shortcut.contains('+') {
        return Err("Choose a shortcut with at least one modifier and a key.".to_owned());
    }

    let previous = load_capture_shortcut(&app)?.shortcut;
    if previous == shortcut {
        return Ok(previous);
    }

    let shortcuts = app.global_shortcut();
    shortcuts
        .unregister(previous.as_str())
        .map_err(|error| format!("Could not replace the current shortcut: {error}"))?;
    if let Err(error) = shortcuts.on_shortcut(shortcut, |app, _, event| {
        if event.state == ShortcutState::Pressed {
            show_capture_window(app);
        }
    }) {
        if let Err(restore_error) = shortcuts.on_shortcut(previous.as_str(), |app, _, event| {
            if event.state == ShortcutState::Pressed {
                show_capture_window(app);
            }
        }) {
            return Err(format!(
                "Shortcut unavailable ({error}), and restoring the previous shortcut failed ({restore_error})."
            ));
        }
        return Err(format!(
            "That shortcut is unavailable or already in use. Choose another combination. ({error})"
        ));
    }

    let settings = CaptureShortcutSettings {
        shortcut: shortcut.to_owned(),
    };
    if let Err(error) = save_capture_shortcut_settings(&app, &settings) {
        if let Err(restore_error) = shortcuts.unregister(shortcut) {
            eprintln!("Could not unregister the unsaved shortcut: {restore_error}");
        }
        if let Err(restore_error) = shortcuts.on_shortcut(previous.as_str(), |app, _, event| {
            if event.state == ShortcutState::Pressed {
                show_capture_window(app);
            }
        }) {
            return Err(format!(
                "{error}; restoring the previous shortcut failed: {restore_error}"
            ));
        }
        return Err(error);
    }

    Ok(shortcut.to_owned())
}

#[tauri::command]
fn get_notification_preferences(app: tauri::AppHandle) -> Result<NotificationPreferences, String> {
    load_notification_preferences(&app)
}

#[tauri::command]
fn save_notification_preferences(
    app: tauri::AppHandle,
    preferences: NotificationPreferences,
) -> Result<NotificationPreferences, String> {
    let settings_path = notification_settings_path(&app)?;
    let parent = settings_path
        .parent()
        .ok_or_else(|| "Could not determine the settings directory".to_owned())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create the settings directory: {error}"))?;
    let settings = serde_json::to_vec_pretty(&preferences)
        .map_err(|error| format!("Could not encode notification settings: {error}"))?;
    fs::write(settings_path, settings)
        .map_err(|error| format!("Could not save notification settings: {error}"))?;
    Ok(preferences)
}

#[tauri::command]
fn test_desktop_notification(app: tauri::AppHandle) -> Result<(), String> {
    app.notification()
        .builder()
        .title("OJJIPA notifications are on")
        .body("Desktop notifications are working on this device.")
        .show()
        .map_err(|error| format!("Could not show a desktop notification: {error}"))
}

#[tauri::command]
fn get_model_configuration(app: tauri::AppHandle) -> Result<ModelConfiguration, String> {
    let saved = load_model_settings(&app)?;
    let grandpa_model = saved
        .grandpa_model
        .or_else(|| env::var("OJJIPA_GRANDPA_MODEL").ok());
    let minipa_model = saved
        .minipa_model
        .or_else(|| env::var("OJJIPA_MINIPA_MODEL").ok());
    Ok(model_configuration(
        saved.api_key_configured || env::var("NEBIUS_API_KEY").is_ok(),
        grandpa_model,
        minipa_model,
    ))
}

#[tauri::command]
fn save_model_configuration(
    app: tauri::AppHandle,
    api_key: String,
    grandpa_model: String,
    minipa_model: String,
) -> Result<ModelConfiguration, String> {
    let grandpa_model = grandpa_model.trim();
    let minipa_model = minipa_model.trim();
    if grandpa_model.is_empty() || grandpa_model.len() > 200 {
        return Err("Enter a valid Grandpa model ID (1-200 characters).".to_owned());
    }
    if minipa_model.is_empty() || minipa_model.len() > 200 {
        return Err("Enter a valid MiniPa model ID (1-200 characters).".to_owned());
    }

    let api_key = api_key.trim();
    if !api_key.is_empty() {
        write_secure_setting("nebius-api-key", api_key)?;
    }

    let previous = load_model_settings(&app)?;
    let saved = SavedModelSettings {
        api_key_configured: !api_key.is_empty() || previous.api_key_configured,
        grandpa_model: Some(grandpa_model.to_owned()),
        minipa_model: Some(minipa_model.to_owned()),
    };
    save_model_settings(&app, &saved)?;
    Ok(model_configuration(
        saved.api_key_configured || env::var("NEBIUS_API_KEY").is_ok(),
        saved.grandpa_model,
        saved.minipa_model,
    ))
}

fn read_secure_setting(name: &str) -> Result<Option<String>, String> {
    let entry = keyring::Entry::new("com.admin.desktop", name)
        .map_err(|error| format!("Could not access the system credential store: {error}"))?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(format!("Could not read a saved setting securely: {error}")),
    }
}

fn write_secure_setting(name: &str, value: &str) -> Result<(), String> {
    let entry = keyring::Entry::new("com.admin.desktop", name)
        .map_err(|error| format!("Could not access the system credential store: {error}"))?;
    entry
        .set_password(value)
        .map_err(|error| format!("Could not save the setting securely: {error}"))
}

pub(crate) fn engine_model_environment(
    database_path: &std::path::Path,
) -> [(&'static str, String); 3] {
    let settings_path = database_path.with_file_name("model-settings.json");
    let saved = fs::read(settings_path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<SavedModelSettings>(&bytes).ok())
        .unwrap_or_default();

    let api_key = if saved.api_key_configured {
        match read_secure_setting("nebius-api-key") {
            Ok(api_key) => api_key,
            Err(error) => {
                eprintln!("Could not access the saved Nebius API key; starting without model credentials: {error}");
                None
            }
        }
    } else {
        None
    };

    [
        (
            "NEBIUS_API_KEY",
            api_key
                .or_else(|| env::var("NEBIUS_API_KEY").ok())
                .unwrap_or_default(),
        ),
        (
            "OJJIPA_GRANDPA_MODEL",
            saved
                .grandpa_model
                .or_else(|| env::var("OJJIPA_GRANDPA_MODEL").ok())
                .unwrap_or_default(),
        ),
        (
            "OJJIPA_MINIPA_MODEL",
            saved
                .minipa_model
                .or_else(|| env::var("OJJIPA_MINIPA_MODEL").ok())
                .unwrap_or_default(),
        ),
    ]
}

fn model_configuration(
    api_key_configured: bool,
    grandpa_model: Option<String>,
    minipa_model: Option<String>,
) -> ModelConfiguration {
    ModelConfiguration {
        api_key_configured,
        grandpa_model_configured: grandpa_model
            .as_ref()
            .is_some_and(|model| !model.trim().is_empty()),
        grandpa_model,
        minipa_model_configured: minipa_model
            .as_ref()
            .is_some_and(|model| !model.trim().is_empty()),
        minipa_model,
    }
}

fn model_settings_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|directory| directory.join("model-settings.json"))
        .map_err(|error| format!("Could not locate the model settings directory: {error}"))
}

fn load_model_settings(app: &tauri::AppHandle) -> Result<SavedModelSettings, String> {
    let path = model_settings_path(app)?;
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|error| format!("Could not read model settings: {error}")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(SavedModelSettings::default())
        }
        Err(error) => Err(format!("Could not read model settings: {error}")),
    }
}

fn save_model_settings(
    app: &tauri::AppHandle,
    settings: &SavedModelSettings,
) -> Result<(), String> {
    let path = model_settings_path(app)?;
    let parent = path
        .parent()
        .ok_or_else(|| "Could not determine the model settings directory".to_owned())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create the model settings directory: {error}"))?;
    let bytes = serde_json::to_vec_pretty(settings)
        .map_err(|error| format!("Could not encode model settings: {error}"))?;
    fs::write(path, bytes).map_err(|error| format!("Could not save model settings: {error}"))
}

fn capture_shortcut_settings_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|directory| directory.join("capture-shortcut.json"))
        .map_err(|error| format!("Could not locate the shortcut settings directory: {error}"))
}

fn load_capture_shortcut(app: &tauri::AppHandle) -> Result<CaptureShortcutSettings, String> {
    let path = capture_shortcut_settings_path(app)?;
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|error| format!("Could not read the quick capture shortcut: {error}")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(CaptureShortcutSettings::default())
        }
        Err(error) => Err(format!(
            "Could not read the quick capture shortcut: {error}"
        )),
    }
}

fn save_capture_shortcut_settings(
    app: &tauri::AppHandle,
    settings: &CaptureShortcutSettings,
) -> Result<(), String> {
    let path = capture_shortcut_settings_path(app)?;
    let parent = path
        .parent()
        .ok_or_else(|| "Could not determine the shortcut settings directory".to_owned())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create the shortcut settings directory: {error}"))?;
    let bytes = serde_json::to_vec_pretty(settings)
        .map_err(|error| format!("Could not encode the quick capture shortcut: {error}"))?;
    fs::write(path, bytes)
        .map_err(|error| format!("Could not save the quick capture shortcut: {error}"))
}

/// Persist a user-created dump through the Python engine and return its result.
#[tauri::command]
async fn submit_dump(
    app: tauri::AppHandle,
    state: State<'_, BridgeState>,
    content: String,
    max_thinking_seconds: u64,
) -> Result<Value, String> {
    let result = submit_dump_request(
        state.dump_tx.clone(),
        state.pending_requests.clone(),
        state.next_request_id.clone(),
        content,
        max_thinking_seconds,
    )
    .await;

    match &result {
        Ok(response) => match load_notification_preferences(&app) {
            Ok(preferences) => {
                let analysis_error = response.get("analysisError").and_then(Value::as_str);
                let body = analysis_error.map_or_else(
                    || {
                        response
                            .get("dumpId")
                            .and_then(Value::as_i64)
                            .map(|id| format!("Thought #{id} was saved to your inbox."))
                            .unwrap_or_else(|| "Your thought was saved to your inbox.".to_owned())
                    },
                    ToOwned::to_owned,
                );
                show_desktop_notification(
                    &app,
                    preferences,
                    if analysis_error.is_some() {
                        NotificationCategory::Problems
                    } else {
                        NotificationCategory::Updates
                    },
                    if analysis_error.is_some() {
                        "Thought saved, but Grandpa could not review it"
                    } else {
                        "Thought captured"
                    },
                    &body,
                );
            }
            Err(error) => eprintln!("Could not load notification settings: {error}"),
        },
        Err(error) => {
            if let Ok(preferences) = load_notification_preferences(&app) {
                show_desktop_notification(
                    &app,
                    preferences,
                    NotificationCategory::Problems,
                    "OJJIPA could not finish that thought",
                    error,
                );
            }
        }
    }
    result
}

async fn submit_dump_request(
    dump_tx: mpsc::Sender<bridge::DumpRequest>,
    pending_requests: bridge::PendingRequests,
    next_request_id: Arc<AtomicU64>,
    content: String,
    max_thinking_seconds: u64,
) -> Result<Value, String> {
    if content.trim().is_empty() {
        return Err("Dump content cannot be empty".to_owned());
    }
    if !(5..=120).contains(&max_thinking_seconds) {
        return Err("Thinking time must be between 5 and 120 seconds".to_owned());
    }

    let request_id = format!("dump-{}", next_request_id.fetch_add(1, Ordering::Relaxed));
    let (reply_tx, reply_rx) = oneshot::channel();
    pending_requests
        .lock()
        .map_err(|_| "Pending request map is unavailable".to_owned())?
        .insert(request_id.clone(), reply_tx);

    if let Err(error) = dump_tx
        .send(bridge::DumpRequest {
            request_id: request_id.clone(),
            content,
            max_thinking_seconds,
        })
        .await
    {
        if let Ok(mut requests) = pending_requests.lock() {
            requests.remove(&request_id);
        }
        return Err(format!("Could not queue dump for the engine: {error}"));
    }

    match timeout(Duration::from_secs(max_thinking_seconds + 5), reply_rx).await {
        Ok(Ok(Ok(result))) => Ok(result),
        Ok(Ok(Err(error))) => Err(error),
        Ok(Err(_)) => Err("The engine closed the dump response channel".to_owned()),
        Err(_) => {
            if let Ok(mut requests) = pending_requests.lock() {
                requests.remove(&request_id);
            }
            Err("Timed out waiting for Grandpa's model decision".to_owned())
        }
    }
}

//// Run the Tauri application
pub fn run() {
    let (activity_tx, activity_rx) = mpsc::channel(32);
    let (dump_tx, dump_rx) = mpsc::channel(32);
    let pending_requests: bridge::PendingRequests = Default::default();
    let next_request_id = Arc::new(AtomicU64::new(1));
    let allow_exit = Arc::new(AtomicBool::new(false));
    let activity_paused = Arc::new(AtomicBool::new(false));
    let lifecycle = AppLifecycle {
        allow_exit: allow_exit.clone(),
    };

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_shortcut(DEFAULT_CAPTURE_SHORTCUT)
                .expect("the quick capture shortcut must be valid")
                .with_handler(|app, _shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        show_capture_window(app);
                    }
                })
                .build(),
        )
        .manage(lifecycle)
        .manage(BridgeState {
            activity_tx: activity_tx.clone(),
            dump_tx: dump_tx.clone(),
            pending_requests: pending_requests.clone(),
            next_request_id: next_request_id.clone(),
            activity_paused: activity_paused.clone(),
        })
        .setup(move |app| {
            let app_data_dir = app.path().app_data_dir()?;
            fs::create_dir_all(&app_data_dir)?;
            let database_path = app_data_dir.join("ojjipa.sqlite");
            let shortcut_settings =
                load_capture_shortcut(app.handle()).map_err(std::io::Error::other)?;
            if shortcut_settings.shortcut != DEFAULT_CAPTURE_SHORTCUT {
                let global_shortcut = app.global_shortcut();
                global_shortcut.unregister(DEFAULT_CAPTURE_SHORTCUT)?;
                if let Err(error) = global_shortcut.on_shortcut(
                    shortcut_settings.shortcut.as_str(),
                    |app, _, event| {
                        if event.state == ShortcutState::Pressed {
                            show_capture_window(app);
                        }
                    },
                ) {
                    eprintln!(
                        "Could not register saved quick capture shortcut: {error}; restoring the default shortcut"
                    );
                    global_shortcut.on_shortcut(DEFAULT_CAPTURE_SHORTCUT, |app, _, event| {
                        if event.state == ShortcutState::Pressed {
                            show_capture_window(app);
                        }
                    })?;
                    if let Err(error) = save_capture_shortcut_settings(
                        app.handle(),
                        &CaptureShortcutSettings::default(),
                    ) {
                        eprintln!("Could not reset the unavailable quick capture shortcut: {error}");
                    }
                }
            }

            let bridge_pending_requests = pending_requests.clone();
            let bridge_activity_paused = activity_paused.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(error) = bridge::run(
                    activity_rx,
                    dump_rx,
                    bridge_pending_requests,
                    database_path,
                    bridge_activity_paused,
                )
                .await
                {
                    eprintln!("OJJIPA engine bridge stopped: {error}");
                }
            });

            let activity_tx = activity_tx.clone();
            let monitor_activity_paused = activity_paused.clone();
            tauri::async_runtime::spawn(async move {
                let mut interval = tokio::time::interval(Duration::from_secs(3));
                let mut previous_category = None;

                loop {
                    interval.tick().await;
                    if monitor_activity_paused.load(Ordering::Acquire) {
                        previous_category = None;
                        continue;
                    }

                    let category = match platform::active_window() {
                        Ok(Some(window)) => window.category(),
                        Ok(None) => platform::ActivityCategory::Unknown,
                        Err(_) => continue,
                    };

                    if monitor_activity_paused.load(Ordering::Acquire) {
                        previous_category = None;
                        continue;
                    }

                    if previous_category != Some(category) {
                        previous_category = Some(category);
                        if let Err(error) =
                            activity_tx.send(platform::AgentActivity { category }).await
                        {
                            eprintln!("Could not send activity category to the engine: {error}");
                            break;
                        }
                    }
                }
            });

            let show_item =
                tauri::menu::MenuItem::with_id(app, "show", "Open OJJIPA", true, None::<&str>)?;
            let capture_item = tauri::menu::MenuItem::with_id(
                app,
                "capture",
                "Capture a thought",
                true,
                None::<&str>,
            )?;
            let pause_item = tauri::menu::CheckMenuItem::with_id(
                app,
                "pause-attention",
                "Pause attention monitoring",
                true,
                false,
                None::<&str>,
            )?;
            let quit_item =
                tauri::menu::MenuItem::with_id(app, "quit", "Quit OJJIPA", true, None::<&str>)?;
            let separator = tauri::menu::PredefinedMenuItem::separator(app)?;
            let menu = tauri::menu::Menu::with_items(
                app,
                &[
                    &show_item,
                    &capture_item,
                    &pause_item,
                    &separator,
                    &quit_item,
                ],
            )?;
            let tray = app.tray_by_id("main").ok_or_else(|| {
                std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    "OJJIPA system tray icon was not initialized",
                )
            })?;
            tray.set_menu(Some(menu))?;
            tray.set_show_menu_on_left_click(true)?;

            let tray_activity_paused = activity_paused.clone();
            let tray_allow_exit = allow_exit.clone();
            let tray_pause_item = pause_item.clone();
            tray.on_menu_event(move |app, event| match event.id().as_ref() {
                "show" => show_main_window(app),
                "capture" => show_capture_window(app),
                "pause-attention" => {
                    let paused = !tray_activity_paused.fetch_xor(true, Ordering::AcqRel);
                    if let Err(error) = tray_pause_item.set_checked(paused) {
                        eprintln!("Could not update system tray monitoring state: {error}");
                    }
                    if let Err(error) = tray_pause_item.set_text(if paused {
                        "Resume attention monitoring"
                    } else {
                        "Pause attention monitoring"
                    }) {
                        eprintln!("Could not update system tray menu label: {error}");
                    }
                }
                "quit" => {
                    tray_allow_exit.store(true, Ordering::Release);
                    app.exit(0);
                }
                _ => {}
            });

            let main_window = app.get_webview_window("main").ok_or_else(|| {
                std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    "OJJIPA main window was not initialized",
                )
            })?;
            let close_window = main_window.clone();
            main_window.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    if let Err(error) = close_window.hide() {
                        eprintln!("Could not hide OJJIPA to the system tray: {error}");
                    }
                }
            });

            let capture_window = app.get_webview_window("capture").ok_or_else(|| {
                std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    "OJJIPA quick capture window was not initialized",
                )
            })?;
            let close_capture_window = capture_window.clone();
            capture_window.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    if let Err(error) = close_capture_window.hide() {
                        eprintln!("Could not hide the quick capture window: {error}");
                    }
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_active_window_transparency,
            get_agent_activity,
            get_attention_monitoring_paused,
            hide_capture_window,
            get_capture_shortcut,
            save_capture_shortcut,
            get_notification_preferences,
            get_model_configuration,
            save_model_configuration,
            save_notification_preferences,
            submit_dump,
            test_desktop_notification
        ])
        .build(tauri::generate_context!())
        .expect("error running OJJIPA");
    app.run(|app, event| {
        if let tauri::RunEvent::ExitRequested { api, .. } = event {
            if !app
                .state::<AppLifecycle>()
                .allow_exit
                .load(Ordering::Acquire)
            {
                api.prevent_exit();
                if let Some(window) = app.get_webview_window("main") {
                    if let Err(error) = window.hide() {
                        eprintln!("Could not hide OJJIPA after an exit request: {error}");
                    }
                }
            }
        }
    });
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if let Err(error) = window.show() {
            eprintln!("Could not show OJJIPA from the system tray: {error}");
        }
        if let Err(error) = window.set_focus() {
            eprintln!("Could not focus OJJIPA from the system tray: {error}");
        }
    }
}

fn show_capture_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("capture") {
        if let Err(error) = window.show() {
            eprintln!("Could not show the quick capture window: {error}");
        }
        if let Err(error) = window.set_focus() {
            eprintln!("Could not focus the quick capture window: {error}");
        }
    } else {
        eprintln!("OJJIPA quick capture window is unavailable");
    }
}

fn notification_settings_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|directory| directory.join("notification-preferences.json"))
        .map_err(|error| format!("Could not locate the settings directory: {error}"))
}

fn load_notification_preferences(
    app: &tauri::AppHandle,
) -> Result<NotificationPreferences, String> {
    let path = notification_settings_path(app)?;
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|error| format!("Could not read notification settings: {error}")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(NotificationPreferences::default())
        }
        Err(error) => Err(format!("Could not read notification settings: {error}")),
    }
}

fn show_desktop_notification(
    app: &tauri::AppHandle,
    preferences: NotificationPreferences,
    category: NotificationCategory,
    title: &str,
    body: &str,
) {
    let category_enabled = match category {
        NotificationCategory::Problems => preferences.problems,
        NotificationCategory::Updates => preferences.updates,
    };
    if !preferences.enabled || !category_enabled {
        return;
    }

    if let Err(error) = app.notification().builder().title(title).body(body).show() {
        eprintln!("Could not show a desktop notification: {error}");
    }
}
