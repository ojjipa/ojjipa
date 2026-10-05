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
`dump.submit` messages whose payload contains only the user's `content`. Each
request receives a `bridge.ack` or `bridge.error` response carrying its
`requestId`. Dump submission persists the raw text; model classification is a
separate step. Raw window titles and app names are not part of this protocol.
The session token and loopback listener are created for each app run.

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
