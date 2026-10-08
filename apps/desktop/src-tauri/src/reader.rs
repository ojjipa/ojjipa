//! Floating reader: trusted app chrome and an unprivileged external webview.
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{Manager, WebviewUrl};
use tauri::webview::{NewWindowResponse, PageLoadEvent, WebviewBuilder};
use tokio::sync::oneshot;

const TOP: f64 = 72.0;
const BOTTOM: f64 = 210.0;

#[derive(Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Snapshot {
    pub url: String,
    pub title: String,
    pub width: f64,
    pub height: f64,
    pub x: Option<i32>,
    pub y: Option<i32>,
    pub pinned: bool,
}

impl Default for Snapshot {
    fn default() -> Self {
        Self { url: "https://arxiv.org/".into(), title: "OJJIPA Reader".into(),
            width: 760.0, height: 840.0, x: None, y: None, pinned: true }
    }
}

#[derive(Default)]
pub struct ReaderState(pub Mutex<Snapshot>);

fn browser_url(value: &str) -> Result<tauri::Url, String> {
    let url = tauri::Url::parse(value).map_err(|_| "Enter a full HTTP(S) page URL")?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none()
        || !url.username().is_empty() || url.password().is_some() {
        return Err("Reader URLs must use HTTP(S), without embedded credentials".into());
    }
    Ok(url)
}

fn persist(app: &tauri::AppHandle) -> Result<(), String> {
    // Read native window properties before locking state: these calls can wait
    // for the UI thread, whose window callbacks also update this state.
    let geometry = if let Some(window) = app.get_window("reader") {
        let scale = window.scale_factor().map_err(|e| e.to_string())?;
        Some((scale, window.inner_size().ok(), window.outer_position().ok()))
    } else { None };
    let state = app.state::<ReaderState>();
    let mut snapshot = state.0.lock().map_err(|_| "Reader state unavailable")?;
    if let Some((scale, size, position)) = geometry {
        if let Some(size) = size {
            snapshot.width = size.width as f64 / scale;
            snapshot.height = size.height as f64 / scale;
        }
        if let Some(position) = position {
            snapshot.x = Some(position.x); snapshot.y = Some(position.y);
        }
    }
    let directory = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let temporary = directory.join("reader-state.tmp");
    std::fs::write(&temporary, serde_json::to_vec(&*snapshot).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    std::fs::rename(temporary, directory.join("reader-state.json")).map_err(|e| e.to_string())
}

pub fn window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    if window.label() != "reader" { return; }
    match event {
        tauri::WindowEvent::Resized(size) => {
            if let Ok(scale) = window.scale_factor() {
                let width = size.width as f64 / scale;
                let height = size.height as f64 / scale;
                if let Some(page) = window.app_handle().get_webview("reader-page") {
                    let _ = page.set_position(tauri::LogicalPosition::new(0.0, TOP));
                    let _ = page.set_size(tauri::LogicalSize::new(width, (height-TOP-BOTTOM).max(1.0)));
                }
            }
            let _ = persist(window.app_handle());
        },
        tauri::WindowEvent::Moved(_) | tauri::WindowEvent::CloseRequested { .. } => {
            let _ = persist(window.app_handle());
        },
        _ => {},
    }
}

#[tauri::command]
pub async fn reader_open(app: tauri::AppHandle, url: Option<String>) -> Result<Snapshot, String> {
    let requested = url.as_deref().map(browser_url).transpose()?;
    if let Some(window) = app.get_window("reader") {
        if let Some(url) = requested {
            app.get_webview("reader-page").ok_or("Reader page unavailable")?
                .navigate(url).map_err(|e| e.to_string())?;
        }
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
        return reader_get(app);
    }
    let path = app.path().app_data_dir().map_err(|e| e.to_string())?.join("reader-state.json");
    let mut saved: Snapshot = std::fs::read(path).ok()
        .and_then(|data| serde_json::from_slice(&data).ok()).unwrap_or_default();
    if let Some(url) = requested { saved.url = url.to_string(); }
    let page_url = browser_url(&saved.url).unwrap_or(browser_url("https://arxiv.org/")?);
    saved.url = page_url.to_string();
    *app.state::<ReaderState>().0.lock().map_err(|_| "Reader state unavailable")? = saved.clone();
    let window = tauri::window::WindowBuilder::new(&app, "reader")
        .title("OJJIPA Reader").inner_size(saved.width.clamp(480.0,1800.0), saved.height.clamp(520.0,1600.0))
        .min_inner_size(480.0,520.0).always_on_top(saved.pinned).visible(false)
        .build().map_err(|e| e.to_string())?;
    let built = (|| -> Result<(), String> {
        window.add_child(WebviewBuilder::new("reader-controls", WebviewUrl::App("index.html".into())).auto_resize(),
            tauri::LogicalPosition::new(0.0,0.0),
            tauri::LogicalSize::new(saved.width.clamp(480.0,1800.0),saved.height.clamp(520.0,1600.0)))
            .map_err(|e| e.to_string())?;
        let nav_app = app.clone();
        let popup_app = app.clone();
        let load_app = app.clone();
        let title_app = app.clone();
        let builder = WebviewBuilder::new("reader-page",WebviewUrl::External(page_url))
            .initialization_script("document.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); location.href = 'ojjipa-reader-close://hide'; } });")
            .on_navigation(move |url| {
                if url.scheme() == "ojjipa-reader-close" {
                    let _ = reader_hide(nav_app.clone());
                    return false;
                }
                if browser_url(url.as_str()).is_err() { return false; }
                if let Ok(mut state) = nav_app.state::<ReaderState>().0.lock() {
                    state.url = url.to_string();
                }
                true
            })
            .on_new_window(move |url, _| {
                if browser_url(url.as_str()).is_ok() {
                    if let Some(page) = popup_app.get_webview("reader-page") {
                        let _ = page.navigate(url);
                    }
                }
                NewWindowResponse::Deny
            })
            .on_document_title_changed(move |_, title| {
                if let Ok(mut state) = title_app.state::<ReaderState>().0.lock() {
                    state.title = title.chars().take(300).collect();
                }
            })
            .on_page_load(move |_, payload| {
                if payload.event() == PageLoadEvent::Finished { let _ = persist(&load_app); }
            });
        let size = window.inner_size().map_err(|e| e.to_string())?;
        let scale = window.scale_factor().map_err(|e| e.to_string())?;
        window.add_child(builder, tauri::LogicalPosition::new(0.0,TOP),
            tauri::LogicalSize::new(size.width as f64/scale, (size.height as f64/scale-TOP-BOTTOM).max(1.0)))
            .map_err(|e| e.to_string())?;
        if let (Some(x),Some(y)) = (saved.x,saved.y) {
            // Ignore stale positions when the user has disconnected a monitor.
            let monitors = window.available_monitors().map_err(|e| e.to_string())?;
            if monitors.iter().any(|m| x >= m.position().x && y >= m.position().y
                && x < m.position().x + m.size().width as i32 && y < m.position().y + m.size().height as i32) {
                window.set_position(tauri::PhysicalPosition::new(x,y)).map_err(|e| e.to_string())?;
            }
        }
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
        Ok(())
    })();
    if let Err(error) = built { let _ = window.destroy(); return Err(error); }
    reader_get(app)
}

#[tauri::command]
pub fn reader_get(app: tauri::AppHandle) -> Result<Snapshot,String> {
    let current_url = app.get_webview("reader-page").and_then(|page| page.url().ok());
    let state = app.state::<ReaderState>();
    let mut snapshot = state.0.lock().map_err(|_| "Reader state unavailable")?;
    if let Some(url) = current_url { snapshot.url = url.to_string(); }
    Ok(snapshot.clone())
}

#[tauri::command]
pub async fn reader_navigate(app: tauri::AppHandle, action: String, url: Option<String>) -> Result<(),String> {
    let page = app.get_webview("reader-page").ok_or("Reader page unavailable")?;
    match action.as_str() {
        "back" => page.eval("history.back()"),
        "forward" => page.eval("history.forward()"),
        "reload" => page.eval("location.reload()"),
        "url" => page.navigate(browser_url(url.as_deref().ok_or("A URL is required")?)?),
        _ => return Err("Unknown reader navigation".into()),
    }.map_err(|e| e.to_string())
}

#[tauri::command]
pub fn reader_hide(app: tauri::AppHandle) -> Result<(),String> {
    persist(&app)?;
    app.get_window("reader").ok_or("Reader unavailable")?.hide().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn reader_pin(app: tauri::AppHandle, pinned: bool) -> Result<(),String> {
    app.get_window("reader").ok_or("Reader unavailable")?.set_always_on_top(pinned).map_err(|e| e.to_string())?;
    app.state::<ReaderState>().0.lock().map_err(|_| "Reader state unavailable")?.pinned = pinned;
    persist(&app)
}

#[tauri::command]
pub async fn reader_selection(app: tauri::AppHandle) -> Result<serde_json::Value,String> {
    let page = app.get_webview("reader-page").ok_or("Reader page unavailable")?;
    let (tx,rx) = oneshot::channel();
    let sender = Mutex::new(Some(tx));
    page.eval_with_callback("(() => ({ title: document.title, selection: String(window.getSelection() || '').slice(0,12000) }))()", move |value| {
        if let Ok(mut slot) = sender.lock() {
            if let Some(tx) = slot.take() { let _ = tx.send(value); }
        }
    }).map_err(|e| e.to_string())?;
    let value = tokio::time::timeout(std::time::Duration::from_secs(3),rx).await
        .map_err(|_| "This page cannot expose selected text; paste it into the reader question instead")?
        .map_err(|_| "The reader page closed")?;
    let result: serde_json::Value = serde_json::from_str(&value).map_err(|_| "Selected text unavailable")?;
    Ok(result)
}
