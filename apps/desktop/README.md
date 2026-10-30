# Tauri + React + Typescript

## Floating reader

Start the desktop app with `npm run tauri dev`. Click a paper URL in Findings,
or use the tray's **Open reader** menu item. The reader is a resizable, pinned
window with back, forward, reload, and an address bar. **Pin** toggles whether
it stays above other apps.

Select text on the page, click **Use selected text**, then ask Grandpa using
the shared dump box. Questions go through the existing `submit_dump` flow,
with the current page title, URL, and selected text (up to 12,000 characters).
The URL alone does not guarantee Grandpa can retrieve a restricted page.
Responses use the existing notifications and Findings flow.

Escape or the close button hides the window without unloading its page.
Reopening from the tray resumes it. After an app restart, the saved URL,
window size, position, and pin setting are restored from `reader-state.json`
in the app-data directory; navigation history and form state are not restored.

External pages use a separate native WebView without OJJIPA command permissions.
The local controls have their own WebView, and the Rust command handler rejects
external-page app commands. This follows Tauri's [capability boundaries](https://v2.tauri.app/security/capabilities/).

PDF rendering and text selection depend on the system WebView. Use **Open
externally** for incompatible pages, and paste text into the question when
selection cannot be read. Desktop notification clicks are not connected to the
reader; use the paper link in Findings instead.

This template should help get you started developing with Tauri, React and Typescript in Vite.

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
