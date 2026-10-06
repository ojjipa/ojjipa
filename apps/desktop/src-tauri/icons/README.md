# Grandpa app icon

`grandpa-source.png` is the square application-icon master, derived from the supplied Grandpa logo using the built-in image-generation tool. The original home-page logo remains in `src/assets/grandpa.jpeg`.

Preparation prompt: preserve the black ink Grandpa wearing glasses and reading, remove the large margins, center the whole artwork on a pale cream square with a small safety margin, and add no text, decorations, or shadows.

The Tauri icon command generates the Windows ICO, macOS ICNS, and PNG sizes. `tauri.conf.json` references these files; the tray uses the app's default icon as well. Rebuild and restart the native app to see the new icon.

To regenerate from the desktop folder:

```powershell
& ./node_modules/.bin/tauri.cmd icon src-tauri/icons/grandpa-source.png --output src-tauri/target/grandpa-icons
```

Copy the desktop ICO, ICNS, and PNG files from that generated folder into this folder.
