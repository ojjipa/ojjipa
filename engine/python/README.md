# OJJIPA Python engine bridge

The Tauri Rust process starts `bridge.py` and hosts a WebSocket listener bound
to loopback on an ephemeral port. For local development, install the Python
dependency with:

```text
python -m pip install -r engine/python/requirements.txt
```

On macOS, use `python3` in place of `python`. The desktop app starts the script
automatically. `OJJIPA_PYTHON` and `OJJIPA_ENGINE_SCRIPT` can override the
interpreter and script paths for development.

Protocol version 1 accepts activity messages whose payload contains only a
category (`coding`, `meeting`, `messaging`, `reading`, or `unknown`), and
`dump.submit` messages with the user's `content` and a `maxThinkingSeconds`
limit (5-120 seconds). Each request receives a `bridge.ack` or `bridge.error`
response carrying its `requestId`. Grandpa classifies a thought through the
Nebius Token Factory OpenAI-compatible chat-completions API and records its
decision and any resulting MiniPa draft with the dump. MiniPa execution is not
yet connected. If inference is not configured or fails, the raw thought is
still saved and returned as pending, with an explicit error.

In the desktop app, open **Settings** to enter the Nebius API key, Grandpa
model ID, and MiniPa model ID. OJJIPA stores the API key in the operating
system credential manager and the model IDs in its private app settings; the
API key is never returned to or stored by the webview. OJJIPA does not check
the credential manager until a key has been configured. Quit and reopen OJJIPA
after saving so the Python engine starts with the updated settings. Grandpa's
model ID must be enabled in your Nebius Token Factory project.
`NEBIUS_API_KEY`, `OJJIPA_GRANDPA_MODEL`, and
`OJJIPA_MINIPA_MODEL` remain available as environment-variable fallbacks when
no saved setting exists, for development. MiniPa execution is not yet connected,
so its model ID is saved for later use only.

The selected duration is a maximum API request time; a completed inference
returns immediately. Raw window titles and app names are not part of the
bridge protocol. The session token and loopback listener are created for each
app run.

The desktop shell, rather than this Python bridge, owns the system-wide
quick-capture shortcut and native notifications. Capture-save updates and
capture failures currently generate notifications according to the user's
settings. Task-completion, scheduled-reminder, and surfaced-item notification
preferences are present in the desktop UI, but their background event sources
are not connected until the corresponding worker and reminder flows are
implemented.

The Python engine is currently a source script that requires a Python runtime
and the listed dependency on the host. Packaging a self-contained Python
sidecar for Windows and macOS is a separate release step.

## Control database

The desktop process passes the platform's application-data path to the Python
engine as `OJJIPA_DATABASE_PATH`. The engine creates `ojjipa.sqlite` there,
enables SQLite foreign-key checks and WAL mode, and applies numbered SQL files
from `migrations/` using SQLite's `user_version`. A migration is applied only
once; the engine stops if the database was created by a newer schema version.

The desktop samples the active window category every three seconds and sends
only category changes over the local bridge. The Python engine stores those
changes in `user_activity`, closing the previous interval when a new category
arrives. Synchronous message work runs in a worker thread so the event loop can
keep processing WebSocket control frames. It stores categories only; window
titles and application names are not sent to Python or written to the database.
