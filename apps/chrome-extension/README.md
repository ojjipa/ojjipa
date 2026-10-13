# Use an already-open Chrome tab

1. Restart OJJIPA after updating its source. In development use `npm run tauri dev`
   from `apps/desktop`. Existing installers must be rebuilt to include this feature.
2. In Settings → AI models & API → Your Chrome tab, choose **Open extension folder**.
3. Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and
   select this folder (`apps/chrome-extension`, or the installed runtime's copy).
4. In OJJIPA, choose **Show pairing code**. Copy it locally into the extension popup.
5. Open the Chrome page you want to use, click the extension, then **Use this tab**.
6. Submit an instruction in OJJIPA, such as “Read this page and explain its main
   claim”, “Scroll down”, or “Fill the search field with fusion reactors.”

The popup can also be opened using Ctrl+Shift+Y (adjust in Chrome's extension
shortcut settings if that shortcut is already taken). Pairing is stored locally;
subsequent connections only need **Use this tab**. Never share the pairing code.
The extension attaches using Chrome's debugger API and shows Chrome's debugger
banner. Existing login/session state stays in that Chrome tab.

## Scope

- Supports main-page snapshots with element references, clicks, text-field
  replacement, scrolling, navigation, back, and common keys/keyboard shortcuts.
- A MiniPa uses the approved tab at execution start. Browser executions are
  serialized. Replacing or disconnecting the tab invalidates that execution's
  connection; commands never adopt a different tab automatically.
- Use **Stop tab access** in Chrome or OJJIPA, close the tab, or cancel the debugger
  banner to stop access. An extension reload/restart requires fresh tab approval.
- Protected Chrome pages, native PDF viewers, cross-origin frames, and shadow-DOM
  controls are outside this first implementation. New tabs opened by websites
  are not automatically adopted. Password field values are not included in snapshots.
- Chrome extension installation is manual for this development version. The
  Windows installer includes the extension folder, not an automatic Chrome install.

## Integration

OJJIPA's loopback WebSocket relay runs on `127.0.0.1:8766`. It requires a paired
extension and issues temporary worker credentials bound to that controller.
Pairing data is stored in the app-data directory, separate from provider keys.
Models never receive these credentials. Browser commands use the actual Hermes
`BrowserControlBroker`, `ControllerScope`, and extension router. OJJIPA pins that
router inside each isolated MiniPa process, including delegated calls, to the
approved controller. Hermes retains its own reasoning loop, tools, and provider
handling. No generic agent loop or replacement Hermes runtime is added.

Chrome APIs: [debugger](https://developer.chrome.com/docs/extensions/reference/api/debugger)
and [service-worker WebSockets](https://developer.chrome.com/docs/extensions/how-to/web-platform/websockets).
