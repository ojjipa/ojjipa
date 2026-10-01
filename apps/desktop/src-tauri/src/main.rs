#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
/// Rust executable entry point
fn main() {
    desktop_lib::run()
}
