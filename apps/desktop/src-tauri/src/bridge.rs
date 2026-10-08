use crate::platform::AgentActivity;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashMap,
    path::PathBuf,
    process::Stdio,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::net::TcpListener;
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot};
use tokio::time::timeout;
use tokio_tungstenite::{accept_async, tungstenite::Message};
use tauri_plugin_notification::NotificationExt;
use tauri::Manager;

const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const PROTOCOL_VERSION: u8 = 1;

pub type PendingRequests = Arc<Mutex<HashMap<String, oneshot::Sender<Result<Value, String>>>>>;

pub struct DumpRequest {
    pub request_id: String,
    pub message_type: String,
    pub payload: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HelloMessage {
    message_type: String,
    protocol_version: u8,
    token: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ActivityMessage<'a> {
    protocol_version: u8,
    message_type: &'static str,
    payload: &'a AgentActivity,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DumpSubmitMessage<'a> {
    protocol_version: u8,
    message_type: &'a str,
    request_id: &'a str,
    payload: &'a Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EngineResponse {
    protocol_version: u8,
    message_type: String,
    request_id: Option<String>,
    result: Option<Value>,
    error: Option<String>,
}

pub async fn run(
    mut activity_rx: mpsc::Receiver<AgentActivity>,
    mut dump_rx: mpsc::Receiver<DumpRequest>,
    pending_requests: PendingRequests,
    database_path: PathBuf,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|error| format!("Could not open the local engine socket: {error}"))?;
    let address = listener
        .local_addr()
        .map_err(|error| format!("Could not read the local engine socket address: {error}"))?;
    let token = create_token()?;
    let mut child = launch_engine(&app, address.port(), &token, &database_path)?;

    let (stream, _) = tokio::select! {
        accepted = listener.accept() => accepted
            .map_err(|error| format!("Could not accept the engine connection: {error}"))?,
        status = child.wait() => {
            return Err(format!("Python engine exited before connecting: {status:?}"));
        }
    };
    let mut socket = timeout(HANDSHAKE_TIMEOUT, accept_async(stream))
        .await
        .map_err(|_| "Timed out waiting for the Python engine handshake".to_owned())?
        .map_err(|error| format!("WebSocket handshake failed: {error}"))?;

    let hello = timeout(HANDSHAKE_TIMEOUT, socket.next())
        .await
        .map_err(|_| "Timed out waiting for the Python engine hello".to_owned())?
        .ok_or_else(|| "Python engine disconnected before hello".to_owned())?
        .map_err(|error| format!("Could not read Python engine hello: {error}"))?;
    let hello_text = hello
        .to_text()
        .map_err(|_| "Python engine hello must be a text message".to_owned())?;
    let hello: HelloMessage = serde_json::from_str(hello_text)
        .map_err(|error| format!("Invalid Python engine hello: {error}"))?;
    if hello.message_type != "hello"
        || hello.protocol_version != PROTOCOL_VERSION
        || hello.token != token
    {
        return Err("Python engine handshake was rejected".into());
    }

    socket
        .send(Message::Text(
            r#"{"messageType":"ready","protocolVersion":1}"#.into(),
        ))
        .await
        .map_err(|error| format!("Could not acknowledge the Python engine: {error}"))?;

    loop {
        tokio::select! {
            activity = activity_rx.recv() => {
                let Some(activity) = activity else { break };
                let message = ActivityMessage {
                    protocol_version: PROTOCOL_VERSION,
                    message_type: "activity",
                    payload: &activity,
                };
                let json = serde_json::to_string(&message)
                    .map_err(|error| format!("Could not encode activity category: {error}"))?;
                socket.send(Message::Text(json.into())).await
                    .map_err(|error| format!("Could not send activity to Python: {error}"))?;
            }
            dump = dump_rx.recv() => {
                let Some(dump) = dump else { break };
                if !pending_requests.lock().map_err(|_| "Pending map unavailable")?.contains_key(&dump.request_id) {
                    continue;
                }
                let message = DumpSubmitMessage {
                    protocol_version: PROTOCOL_VERSION,
                    message_type: &dump.message_type,
                    request_id: &dump.request_id,
                    payload: &dump.payload,
                };
                let json = serde_json::to_string(&message)
                    .map_err(|error| format!("Could not encode dump submission: {error}"))?;
                socket.send(Message::Text(json.into())).await
                    .map_err(|error| format!("Could not send dump to Python: {error}"))?;
            }
            incoming = socket.next() => {
                match incoming {
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(Message::Ping(payload))) => {
                        socket.send(Message::Pong(payload)).await
                            .map_err(|error| format!("WebSocket ping response failed: {error}"))?;
                    }
                    Some(Ok(Message::Text(text))) => {
                        match serde_json::from_str::<EngineResponse>(&text) {
                            Ok(response) if response.message_type == "engine.event" && response.protocol_version == PROTOCOL_VERSION => {
                                if let Some(event) = response.result {
                                    let category = event["category"].as_str().unwrap_or("problems");
                                    if let Ok(preferences) = super::get_notification_preferences(app.clone()) {
                                        if preferences["enabled"] == true && preferences[category] == true {
                                            if let Some(message) = event["message"].as_str() {
                                                let preview = super::notification::preview(message);
                                                let _ = app.notification().builder().title("OJJIPA").body(preview).show();
                                            }
                                        }
                                    }
                                }
                            },
                            Ok(response) => complete_request(&pending_requests, response),
                            Err(error) => eprintln!("Ignoring invalid engine response: {error}"),
                        }
                    }
                    Some(Ok(_)) => {},
                    Some(Err(error)) => return Err(format!("WebSocket connection failed: {error}")),
                }
            }
            status = child.wait() => {
                return Err(format!("Python engine exited: {status:?}"));
            }
        }
    }

    let _ = socket.close(None).await;
    if timeout(Duration::from_secs(2), child.wait()).await.is_err() {
        let _ = child.kill().await;
    }
    Ok(())
}

fn complete_request(pending_requests: &PendingRequests, response: EngineResponse) {
    if response.protocol_version != PROTOCOL_VERSION {
        eprintln!("Ignoring engine response with an unsupported protocol version");
        return;
    }

    let Some(request_id) = response.request_id else {
        return;
    };
    let result = match response.message_type.as_str() {
        "bridge.ack" => response
            .result
            .ok_or_else(|| "Python engine acknowledgement did not include a result".to_owned()),
        "bridge.error" => Err(response
            .error
            .unwrap_or_else(|| "Python engine returned an unspecified error".to_owned())),
        _ => return,
    };

    let sender = match pending_requests.lock() {
        Ok(mut requests) => requests.remove(&request_id),
        Err(_) => {
            eprintln!("Pending request map is unavailable because its mutex was poisoned");
            return;
        }
    };
    if let Some(sender) = sender {
        let _ = sender.send(result);
    }
}

fn launch_engine(app: &tauri::AppHandle, port: u16, token: &str, database_path: &std::path::Path) -> Result<Child, String> {
    let (script, python) = if cfg!(debug_assertions) {
        let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
        let script = std::env::var_os("OJJIPA_ENGINE_SCRIPT")
        .map(Into::into)
        .unwrap_or_else(|| root.join("engine/python/bridge.py"));
        let prepared = root.join(if cfg!(target_os = "windows") { ".venv-hermes/Scripts/python.exe" } else { ".venv-hermes/bin/python" });
        let python = std::env::var_os("OJJIPA_PYTHON").map(PathBuf::from)
            .unwrap_or_else(|| if prepared.is_file() { prepared } else {
                PathBuf::from(if cfg!(target_os = "windows") { "python" } else { "python3" })
            });
        (script, python)
    } else {
        let runtime = app.path().resource_dir().map_err(|e| e.to_string())?.join("runtime");
        let python = runtime.join("python/python.exe");
        if !python.is_file() {
            return Err("The bundled Python runtime is missing. Repair or reinstall OJJIPA.".into());
        }
        (runtime.join("app/engine/python/bridge.py"), python)
    };
    if !script.is_file() {
        return Err(format!("Python engine script was not found at {}", script.display()));
    }

    let mut command = Command::new(&python);
    // Installed builds use their own Python for both engine and Hermes workers.
    // Ignore machine-global interpreter paths that could redirect this runtime.
    if !cfg!(debug_assertions) {
        command.env("OJJIPA_HERMES_PYTHON", &python)
            .env("PYTHONNOUSERSITE", "1")
            .env_remove("PYTHONHOME").env_remove("PYTHONPATH").env_remove("VIRTUAL_ENV");
        let mut paths = vec![python.parent().ok_or("Invalid bundled Python path")?.to_path_buf()];
        if let Some(existing) = std::env::var_os("PATH") { paths.extend(std::env::split_paths(&existing)); }
        command.env("PATH", std::env::join_paths(paths).map_err(|e| e.to_string())?);
    }
    #[cfg(target_os = "windows")]
    command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    command
        .arg(script)
        .env("OJJIPA_BRIDGE_URL", format!("ws://127.0.0.1:{port}"))
        .env("OJJIPA_BRIDGE_TOKEN", token)
        .env("OJJIPA_DATABASE_PATH", database_path)
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .env("PYTHONUTF8", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| format!("Could not start the Python engine: {error}"))
}

fn create_token() -> Result<String, String> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes)
        .map_err(|error| format!("Could not create the engine session token: {error}"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}
