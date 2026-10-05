mod bridge;
mod platform;

use std::{fs, time::Duration};
use tauri::{Manager, State};
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
        .manage(BridgeState {
            activity_tx: activity_tx.clone(),
        })
        .setup(move |app| {
            let app_data_dir = app.path().app_data_dir()?;
            fs::create_dir_all(&app_data_dir)?;
            let database_path = app_data_dir.join("ojjipa.sqlite");

            tauri::async_runtime::spawn(async move {
                if let Err(error) = bridge::run(activity_rx, database_path).await {
                    eprintln!("OJJIPA engine bridge stopped: {error}");
                }
            });

            let activity_tx = activity_tx.clone();
            tauri::async_runtime::spawn(async move {
                let mut interval = tokio::time::interval(Duration::from_secs(3));
                let mut previous_category = None;

                loop {
                    interval.tick().await;
                    let category = match platform::active_window() {
                        Ok(Some(window)) => window.category(),
                        Ok(None) => platform::ActivityCategory::Unknown,
                        Err(_) => continue,
                    };

                    if previous_category != Some(category) {
                        previous_category = Some(category);
                        if let Err(error) = activity_tx
                            .send(platform::AgentActivity { category })
                            .await
                        {
                            eprintln!("Could not send activity category to the engine: {error}");
                            break;
                        }
                    }
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
