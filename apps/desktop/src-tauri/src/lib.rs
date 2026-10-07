mod bridge;
mod platform;

use serde_json::{json, Value};
use std::{
    fs,
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};
use tauri::{Manager, State};
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
        .manage(BridgeState {
            activity_tx: activity_tx.clone(),
            dump_tx: dump_tx.clone(),
            pending_requests: pending_requests.clone(),
            next_request_id: AtomicU64::new(1),
        })
        .setup(move |app| {
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
        .invoke_handler(tauri::generate_handler![
            get_active_window_transparency,
            get_agent_activity,
            submit_dump,
            hold_queue_request
        ])
        .run(tauri::generate_context!())
        .expect("error running OJJIPA");
}
