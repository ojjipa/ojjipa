mod bridge;
mod platform;

use tauri::State;
use tokio::sync::mpsc;

struct BridgeState {
    activity_tx: mpsc::Sender<platform::AgentActivity>,
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

//// Run the Tauri application
pub fn run() {
    let (activity_tx, activity_rx) = mpsc::channel(32);
    tauri::Builder::default()
        .manage(BridgeState { activity_tx })
        .setup(|_app| {
            tauri::async_runtime::spawn(async move {
                if let Err(error) = bridge::run(activity_rx).await {
                    eprintln!("OJJIPA engine bridge stopped: {error}");
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_active_window_transparency,
            get_agent_activity
        ])
        .run(tauri::generate_context!())
        .expect("error running OJJIPA");
}
