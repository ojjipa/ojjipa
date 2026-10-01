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

Protocol version 1 sends activity messages whose payload contains only a
category (`coding`, `meeting`, `messaging`, `reading`, or `unknown`). Raw window
titles and app names are not part of this protocol. The session token and
loopback listener are created for each app run.

The Python engine is currently a source script that requires a Python runtime
and the listed dependency on the host. Packaging a self-contained Python
sidecar for Windows and macOS is a separate release step.
