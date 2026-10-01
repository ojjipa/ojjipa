mod platform;

/// Tauri commands to get the active window transparency and agent activity
#[tauri::command]
fn get_active_window_transparency() -> Result<Option<platform::ActiveWindowTransparency>, String> {
    // Get the active window info fully like this is say "lib.rs - Rust - Visual Studio Code"
    platform::active_window().map(|window| window.map(|window| window.transparency()))
}

#[tauri::command]
fn get_agent_activity() -> Result<Option<platform::AgentActivity>, String> {
    // It catagorizes the activity of the agent based on the active window title and process name. For example, if the active window is "lib.rs - Rust - Visual Studio Code", it will categorize it as "Coding" activity.
    platform::active_window().map(|window| window.map(|window| window.agent_activity()))
}

//// Run the Tauri application
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            get_active_window_transparency,
            get_agent_activity
        ])
        .run(tauri::generate_context!())
        .expect("error running OJJIPA");
}
