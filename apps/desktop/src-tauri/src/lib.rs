mod bridge;
mod platform;

use serde_json::{json, Value};
use std::{
    fs,
    sync::Mutex,
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};
use tauri::{Manager, State, Emitter, PhysicalPosition, menu::{Menu, MenuItem}, tray::{TrayIconBuilder, TrayIconEvent}};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tokio::sync::{mpsc, oneshot};
use tokio::time::timeout;

struct BridgeState {
    activity_tx: mpsc::Sender<platform::AgentActivity>,
    dump_tx: mpsc::Sender<bridge::DumpRequest>,
    pending_requests: bridge::PendingRequests,
    next_request_id: AtomicU64,
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
async fn submit_dump(state: State<'_, BridgeState>, content: String) -> Result<Value, String> {
    if content.trim().is_empty() {
        return Err("Dump content cannot be empty".to_owned());
    }

    send_engine_request(&state, "dump.submit".into(), json!({"content": content})).await
}

#[derive(Default)]
struct PopupState {
    previous_window: Mutex<Option<isize>>,
    shortcut_error: Mutex<Option<String>>,
}

fn show_dump(app: &tauri::AppHandle) -> Result<(), String> {
    let window = app.get_webview_window("dump").ok_or("Dump window is unavailable")?;
    if !window.is_visible().map_err(|e| e.to_string())? {
        #[cfg(target_os = "windows")]
        {
            use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
            *app.state::<PopupState>().previous_window.lock().map_err(|_| "Popup state unavailable")? =
                Some(unsafe { GetForegroundWindow() }.0 as isize);
        }
        if let (Ok(cursor), Ok(monitors), Ok(size)) = (app.cursor_position(), app.available_monitors(), window.outer_size()) {
            if let Some(monitor) = monitors.iter().find(|m| {
                let p = m.position(); let s = m.size();
                cursor.x >= p.x as f64 && cursor.x < p.x as f64 + s.width as f64 &&
                cursor.y >= p.y as f64 && cursor.y < p.y as f64 + s.height as f64
            }) {
                let p = monitor.position(); let s = monitor.size();
                let x = p.x + (s.width.saturating_sub(size.width) / 2) as i32;
                let y = p.y + (s.height.saturating_sub(size.height) / 3) as i32;
                let _ = window.set_position(PhysicalPosition::new(x, y));
            }
        }
    }
    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())?;
    window.emit("dump-focus", ()).map_err(|e| e.to_string())
}

#[tauri::command]
fn open_dump(app: tauri::AppHandle) -> Result<(), String> { show_dump(&app) }

#[tauri::command]
fn close_dump(app: tauri::AppHandle) -> Result<(), String> {
    app.get_webview_window("dump").ok_or("Dump window unavailable")?.hide().map_err(|e| e.to_string())?;
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::{Foundation::HWND, UI::WindowsAndMessaging::{IsWindow, SetForegroundWindow}};
        if let Some(previous) = app.state::<PopupState>().previous_window.lock().map_err(|_| "Popup state unavailable")?.take() {
            let hwnd = HWND(previous as *mut std::ffi::c_void);
            unsafe { if IsWindow(hwnd).as_bool() { let _ = SetForegroundWindow(hwnd); } }
        }
    }
    Ok(())
}

#[tauri::command]
fn shortcut_status(state: State<'_, PopupState>) -> Result<Option<String>, String> {
    state.shortcut_error.lock().map(|value| value.clone()).map_err(|_| "Shortcut state unavailable".into())
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
    if !["attention.get", "attention.settings", "attention.surface", "attention.dismiss", "workspace.get", "minipa.update"].contains(&operation.as_str()) {
        return Err("Unsupported attention operation".into());
    }
    if !payload.is_object() { return Err("Payload must be an object".into()); }
    send_engine_request(&state, operation, payload).await
}

async fn send_engine_request(state: &BridgeState, operation: String, payload: Value) -> Result<Value, String> {

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

    timeout(bridge::REQUEST_TIMEOUT, async {
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
        return Err(format!("Could not queue request for the engine: {error}"));
    }

    reply_rx.await.map_err(|_| "The engine closed the response channel".to_owned())?
    }).await.map_err(|_| "Timed out waiting for the Python engine".to_owned())?
}

//// Run the Tauri application
pub fn run() {
    let (activity_tx, activity_rx) = mpsc::channel(32);
    let (dump_tx, dump_rx) = mpsc::channel(32);
    let pending_requests: bridge::PendingRequests = Default::default();
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") { let _ = window.show(); let _ = window.set_focus(); }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().with_handler(|app, _, event| {
            if event.state == ShortcutState::Pressed {
                let visible = app.get_webview_window("dump").and_then(|w| w.is_visible().ok()).unwrap_or(false);
                if visible { let _ = close_dump(app.clone()); } else { let _ = show_dump(app); }
            }
        }).build())
        .manage(PopupState::default())
        .manage(BridgeState {
            activity_tx: activity_tx.clone(),
            dump_tx: dump_tx.clone(),
            pending_requests: pending_requests.clone(),
            next_request_id: AtomicU64::new(1),
        })
        .setup(move |app| {
            if let Err(error) = app.global_shortcut().register("CommandOrControl+Shift+Space") {
                *app.state::<PopupState>().shortcut_error.lock().unwrap() = Some(error.to_string());
            }
            let open = MenuItem::with_id(app, "open", "Open OJJIPA", true, None::<&str>)?;
            let dump = MenuItem::with_id(app, "dump", "Capture a thought", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &dump, &quit])?;
            TrayIconBuilder::new().icon(app.default_window_icon().unwrap().clone()).menu(&menu).tooltip("OJJIPA")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => if let Some(w) = app.get_webview_window("main") { let _ = w.show(); let _ = w.set_focus(); },
                    "dump" => { let _ = show_dump(app); },
                    "quit" => app.exit(0),
                    _ => {}
                }).on_tray_icon_event(|tray, event| if let TrayIconEvent::DoubleClick { .. } = event {
                    if let Some(w) = tray.app_handle().get_webview_window("main") { let _ = w.show(); let _ = w.set_focus(); }
                }).build(app)?;
            let app_data_dir = app.path().app_data_dir()?;
            fs::create_dir_all(&app_data_dir)?;
            let database_path = app_data_dir.join("ojjipa.sqlite");

            let pending_requests = pending_requests.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(error) = bridge::run(
                    activity_rx,
                    dump_rx,
                    pending_requests,
                    database_path,
                )
                .await
                {
                    eprintln!("OJJIPA engine bridge stopped: {error}");
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
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } => { api.prevent_close(); let _ = window.hide(); },
            tauri::WindowEvent::Focused(false) if window.label() == "dump" => { let _ = window.hide(); },
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            get_active_window_transparency,
            get_agent_activity,
            submit_dump,
            hold_queue_request,
            open_dump,
            close_dump,
            shortcut_status
        ])
        .run(tauri::generate_context!())
        .expect("error running OJJIPA");
}
