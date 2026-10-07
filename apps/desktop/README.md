# OJJIPA Desktop

OJJIPA Desktop is a Tauri 2 application with a React, TypeScript, and Vite
frontend. It keeps the Python engine in the background and provides a
cross-platform system tray or menu bar entry.

## Quick capture

Press **Command+Option+Shift+Space** on macOS or
**Ctrl+Alt+Shift+Space** on Windows and Linux to open the always-on-top quick
capture bar over any app. Change this combination from **Settings → Appearance
→ Quick capture**. Type a thought and press **Command/Ctrl+Enter** to save it,
or press **Escape** (or click the ESC button) to dismiss it. The tray menu has
the same quick-capture action.

## Settings

Settings are grouped into Appearance, Notifications, and AI Models & API.
Notification preferences are saved in the platform app config directory.
Notification delivery uses the operating system's native notification
service; capture updates and capture failures are currently connected.
Completion, scheduled-reminder, and resurfacing alerts are exposed as
preferences for the corresponding background workflows.

The Nebius API key is stored in the platform credential manager; model IDs are
stored in OJJIPA's private app settings. OJJIPA does not access the credential
manager until a key is configured, and the Python engine reads it at startup.
Restart OJJIPA after changing model settings. A Nebius API key is optional for
local capture: without one, thoughts are still saved and remain pending
Grandpa's review.

## Development

Install frontend dependencies and the Python engine requirements, then run:

```text
npm install
npm run tauri dev
```

Build the production desktop app with:

```text
npm run tauri build
```
