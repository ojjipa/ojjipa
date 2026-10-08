mod bridge;
mod platform;
mod reader;
mod notification;

use serde_json::{json, Value};
use std::{
    fs,
    sync::{Arc, Mutex},
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};
use tauri::{Manager, State};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tauri_plugin_notification::NotificationExt;
use tokio::sync::{mpsc, oneshot};
use tokio::time::timeout;

struct BridgeState {
    activity_tx: mpsc::Sender<platform::AgentActivity>,
    dump_tx: mpsc::Sender<bridge::DumpRequest>,
    pending_requests: bridge::PendingRequests,
    next_request_id: AtomicU64,
    engine_error: Arc<Mutex<Option<String>>>,
}

const DEFAULT_SHORTCUT: &str = "CommandOrControl+Alt+Shift+Space";

fn load_preferences(app: &tauri::AppHandle) -> Result<Value, String> {
    let path = app.path().app_data_dir().map_err(|e| e.to_string())?.join("ui-preferences.json");
    if !path.exists() { return Ok(json!({})); }
    serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

fn save_preference(app: &tauri::AppHandle, key: &str, value: Value) -> Result<(), String> {
    let mut preferences = load_preferences(app)?;
    preferences[key] = value;
    let directory = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    fs::write(directory.join("ui-preferences.json"), serde_json::to_vec_pretty(&preferences).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn get_capture_shortcut(app: tauri::AppHandle) -> Result<String, String> {
    Ok(load_preferences(&app)?["captureShortcut"].as_str().unwrap_or(DEFAULT_SHORTCUT).to_owned())
}

fn register_capture(app: &tauri::AppHandle, shortcut: &str) -> Result<(), String> {
    app.global_shortcut().on_shortcut(shortcut, |app, _, event| {
        if event.state == ShortcutState::Pressed {
            if let Some(window) = app.get_webview_window("capture") {
                let _ = window.show(); let _ = window.set_focus();
            }
        }
    }).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_capture_shortcut(app: tauri::AppHandle, shortcut: String) -> Result<String, String> {
    if !shortcut.contains("Control") && !shortcut.contains("Command") && !shortcut.contains("Alt") && !shortcut.contains("Shift") {
        return Err("Include a modifier key".into());
    }
    let previous = get_capture_shortcut(app.clone())?;
    if previous == shortcut { return Ok(shortcut); }
    register_capture(&app, &shortcut)?;
    if let Err(error) = save_preference(&app, "captureShortcut", json!(shortcut)) {
        let _ = app.global_shortcut().unregister(shortcut.as_str()); return Err(error);
    }
    let _ = app.global_shortcut().unregister(previous.as_str());
    Ok(shortcut)
}

#[tauri::command]
fn hide_capture_window(app: tauri::AppHandle) -> Result<(), String> {
    app.get_webview_window("capture").ok_or("Capture window unavailable")?.hide().map_err(|e| e.to_string())
}

#[tauri::command]
fn get_notification_preferences(app: tauri::AppHandle) -> Result<Value, String> {
    let stored = load_preferences(&app)?;
    Ok(stored.get("notifications").cloned().unwrap_or(json!({"enabled":true,"taskCompletions":true,"reminders":true,"resurfacedItems":true,"problems":true,"updates":true})))
}

#[tauri::command]
fn save_notification_preferences(app: tauri::AppHandle, preferences: Value) -> Result<Value, String> {
    let keys = ["enabled","taskCompletions","reminders","resurfacedItems","problems","updates"];
    let object = preferences.as_object().ok_or("Invalid notification settings")?;
    if object.len() != keys.len() || keys.iter().any(|key| !preferences[*key].is_boolean()) {
        return Err("Invalid notification settings".into());
    }
    save_preference(&app, "notifications", preferences.clone())?;
    Ok(preferences)
}

#[tauri::command]
fn test_desktop_notification(app: tauri::AppHandle) -> Result<(), String> {
    if get_notification_preferences(app.clone())?["enabled"] != true {
        return Err("Enable desktop notifications first".into());
    }
    app.notification().builder().title("OJJIPA").body("Your desktop notifications are connected.").show().map_err(|e| e.to_string())
}

#[tauri::command]
async fn workspace_request(state: State<'_, BridgeState>, operation: String, payload: Value) -> Result<Value, String> {
    if !["workspace.get", "minipa.status", "ai.settings.get", "ai.settings.save", "ai.check", "ai.retry", "ai.memory.forget", "ai.analyze", "ai.run"].contains(&operation.as_str()) || !payload.is_object() {
        return Err("Unsupported workspace request".into());
    }
    send_engine_request(&state, operation, payload).await
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

/// Persist a user-created dump through the Python engine and return its result.
#[tauri::command]
async fn submit_dump(app: tauri::AppHandle, state: State<'_, BridgeState>, content: String) -> Result<Value, String> {
    if content.trim().is_empty() {
        return Err("Dump content cannot be empty".to_owned());
    }

    let result = send_engine_request(&state, "dump.submit".into(), json!({"content": content})).await;
    if let Ok(preferences) = get_notification_preferences(app.clone()) {
        let category = if result.is_ok() { "updates" } else { "problems" };
        if preferences["enabled"] == true && preferences[category] == true {
            let body = if result.is_ok() { "Your thought was saved to your private inbox." } else { "Your thought could not be saved. Open OJJIPA to try again." };
            let _ = app.notification().builder().title("OJJIPA").body(body).show();
        }
    }
    result
}

struct PendingGuard {
    id: String,
    pending: bridge::PendingRequests,
}

impl Drop for PendingGuard {
    fn drop(&mut self) {
        if let Ok(mut requests) = self.pending.lock() {
            requests.remove(&self.id);
        }
    }
}

/// Attention controls use the same correlated request/reply transport as dumps.
#[tauri::command]
async fn hold_queue_request(state: State<'_, BridgeState>, operation: String, payload: Value) -> Result<Value, String> {
    if !["attention.get", "attention.settings", "attention.surface", "attention.dismiss"].contains(&operation.as_str()) {
        return Err("Unsupported attention operation".into());
    }
    if !payload.is_object() { return Err("Payload must be an object".into()); }
    send_engine_request(&state, operation, payload).await
}

async fn send_engine_request(state: &BridgeState, operation: String, payload: Value) -> Result<Value, String> {
    let request_timeout = if operation == "ai.check" { Duration::from_secs(130) } else { bridge::REQUEST_TIMEOUT };
    if let Some(error) = state.engine_error.lock().map_err(|_| "Engine status unavailable")?.as_ref() {
        return Err(format!("Engine unavailable: {error}. Restart OJJIPA after correcting the problem."));
    }

    let request_id = format!(
        "dump-{}",
        state.next_request_id.fetch_add(1, Ordering::Relaxed)
    );
    let (reply_tx, reply_rx) = oneshot::channel();
    state
        .pending_requests
        .lock()
        .map_err(|_| "Pending request map is unavailable".to_owned())?
        .insert(request_id.clone(), reply_tx);

    let _guard = PendingGuard { id: request_id.clone(), pending: state.pending_requests.clone() };

    timeout(request_timeout, async {
    if let Err(error) = state
        .dump_tx
        .send(bridge::DumpRequest {
            request_id: request_id.clone(),
            message_type: operation,
            payload,
        })
        .await
    {
        if let Ok(mut requests) = state.pending_requests.lock() {
            requests.remove(&request_id);
        }
        let reason = state.engine_error.lock().ok().and_then(|value| value.clone())
            .unwrap_or_else(|| error.to_string());
        return Err(format!("Engine unavailable: {reason}. Restart OJJIPA after correcting the problem."));
    }

    reply_rx.await.map_err(|_| "The engine closed the response channel".to_owned())?
    }).await.map_err(|_| "Timed out waiting for the Python engine".to_owned())?
}

//// Run the Tauri application
pub fn run() {
    let (activity_tx, activity_rx) = mpsc::channel(32);
    let (dump_tx, dump_rx) = mpsc::channel(32);
    let pending_requests: bridge::PendingRequests = Default::default();
    let engine_error: Arc<Mutex<Option<String>>> = Default::default();
    let task_engine_error = engine_error.clone();
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .on_window_event(|window, event| {
            reader::window_event(window, event);
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open-workspace" => { if let Some(window) = app.get_webview_window("main") { let _ = window.show(); let _ = window.set_focus(); } },
            "quick-capture" => { if let Some(window) = app.get_webview_window("capture") { let _ = window.show(); let _ = window.set_focus(); } },
            "open-reader" => { let app = app.clone(); tauri::async_runtime::spawn(async move { if let Err(error) = reader::reader_open(app,None).await { eprintln!("Reader unavailable: {error}"); } }); },
            "quit-ojjipa" => app.exit(0),
            _ => {},
        })
        .manage(BridgeState {
            activity_tx: activity_tx.clone(),
            dump_tx: dump_tx.clone(),
            pending_requests: pending_requests.clone(),
            next_request_id: AtomicU64::new(1),
            engine_error,
        })
        .manage(reader::ReaderState::default())
        .setup(move |app| {
            let app_data_dir = app.path().app_data_dir()?;
            fs::create_dir_all(&app_data_dir)?;
            tauri::WebviewWindowBuilder::new(app, "capture", tauri::WebviewUrl::App("index.html".into()))
                .title("OJJIPA Quick Capture").inner_size(640.0, 210.0)
                .decorations(false).always_on_top(true).visible(false).build()?;
            let shortcut = get_capture_shortcut(app.handle().clone()).unwrap_or(DEFAULT_SHORTCUT.to_owned());
            if let Err(error) = register_capture(app.handle(), &shortcut) { eprintln!("Capture shortcut unavailable: {error}"); }
            let menu = tauri::menu::Menu::with_items(app, &[
                &tauri::menu::MenuItem::with_id(app, "open-workspace", "Open OJJIPA", true, None::<&str>)?,
                &tauri::menu::MenuItem::with_id(app, "quick-capture", "Quick capture", true, None::<&str>)?,
                &tauri::menu::MenuItem::with_id(app, "open-reader", "Open reader", true, None::<&str>)?,
                &tauri::menu::MenuItem::with_id(app, "quit-ojjipa", "Quit OJJIPA", true, None::<&str>)?,
            ])?;
            if let Some(tray) = app.tray_by_id("main") { tray.set_menu(Some(menu))?; }
            let database_path = app_data_dir.join("ojjipa.sqlite");

            let pending_requests = pending_requests.clone();
            let bridge_app = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let result = bridge::run(
                    activity_rx,
                    dump_rx,
                    pending_requests.clone(),
                    database_path,
                    bridge_app,
                )
                .await;
                let error = result.err().unwrap_or_else(|| "The Python engine disconnected".to_owned());
                eprintln!("OJJIPA engine bridge stopped: {error}");
                if let Ok(mut status) = task_engine_error.lock() {
                    *status = Some(error.clone());
                }
                if let Ok(mut requests) = pending_requests.lock() {
                    for (_, sender) in requests.drain() {
                        let _ = sender.send(Err(format!("Engine unavailable: {error}")));
                    }
                }
            });

            let activity_tx = activity_tx.clone();
            tauri::async_runtime::spawn(async move {
                let mut interval = tokio::time::interval(Duration::from_secs(3));

                loop {
                    interval.tick().await;
                    let category = match platform::active_window() {
                        Ok(Some(window)) => window.category(),
                        Ok(None) => platform::ActivityCategory::Unknown,
                        Err(_) => platform::ActivityCategory::Unknown,
                    };

                        if let Err(error) = activity_tx
                            .send(platform::AgentActivity { category })
                            .await
                        {
                            eprintln!("Could not send activity category to the engine: {error}");
                            break;
                        }
                }
            });

            Ok(())
        })
        .invoke_handler(|invoke| {
            // Remote reader pages cannot call app commands, even if they attempt
            // to construct Tauri IPC manually. Only our local UI may invoke them.
            let view = invoke.message.webview_ref();
            let trusted_label = ["main","capture","reader-controls"].contains(&view.label());
            let trusted_origin = view.url().map(|url| {
                url.scheme() == "tauri" ||
                (matches!(url.scheme(),"http"|"https") && url.host_str() == Some("tauri.localhost")) ||
                (cfg!(debug_assertions) && url.scheme() == "http" &&
                 matches!(url.host_str(),Some("localhost"|"127.0.0.1")) && url.port() == Some(1420))
            }).unwrap_or(false);
            if !trusted_label || !trusted_origin {
                invoke.resolver.reject("External pages cannot invoke OJJIPA commands");
                return true;
            }
            let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
            get_active_window_transparency,
            get_agent_activity,
            submit_dump,
            hold_queue_request,
            workspace_request,
            get_capture_shortcut,
            save_capture_shortcut,
            hide_capture_window,
            get_notification_preferences,
            save_notification_preferences,
            test_desktop_notification,
            reader::reader_open,
            reader::reader_get,
            reader::reader_navigate,
            reader::reader_hide,
            reader::reader_pin,
            reader::reader_selection
        ];
            handler(invoke)
        })
        .run(tauri::generate_context!())
        .expect("error running OJJIPA");
}
