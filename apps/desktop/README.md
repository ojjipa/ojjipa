# OJJIPA desktop

Run `npm run tauri dev` from this folder after installing the frontend and Python engine dependencies.

## Capture without opening Home

- Press **Ctrl+Shift+Space** on Windows, or **Cmd+Shift+Space** on macOS, while OJJIPA is running.
- A small window opens over your current application. It uses the same `src/components/dump_box.tsx` component as Home.
- **Ctrl/Cmd+Enter** saves through the Python engine's `DumpsRepository`. The window closes only after the engine acknowledges the save.
- The popup contains only the dump box. **Escape** or the shortcut again closes capture. On Windows, explicit closing restores the previously focused window. Clicking another application hides capture without stealing focus back.
- Unsent text is stored locally and shared between Home and capture. Failed saves retain the draft.
- Closing the main window keeps OJJIPA in the tray. Use the tray menu to open Home, capture a thought, or quit. Shortcuts stop working after Quit.
- If another app owns the shortcut, Home displays a notice; the capture button and tray menu remain available.

## Main window

Home is intentionally sparse: a reading Grandpa mark, the shared dump box, and a collapsed list of recent captures. Notifications shows surfaced reports and the number still held. MiniPas shows database records with pause, resume, and retire controls; retired agents cannot resume.

These views display actual local database records. Saving a dump currently persists it; this checkout does not yet connect saving to model judgment or a MiniPa execution scheduler. Lifecycle controls update stored status, and will need scheduler integration when execution is added.

The Grandpa logo is the supplied image, bundled locally in `src/assets/grandpa.jpeg`. CSS frames its white margins and blends it into the cream background; no remote image or font is loaded. The Windows app and global shortcut popup have been inspected in the desktop. macOS needs a native verification pass.

Migration `0004_ensure_attention_preferences.sql` adds the attention table to older development databases whose version 3 belonged to another branch. Existing captures and agent records are preserved.
