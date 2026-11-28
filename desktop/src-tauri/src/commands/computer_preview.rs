//! A read-only, always-on-top observer. Closing it never stops the agent.
// The main window also hosts browser child webviews, so it is not a WebviewWindow.
#![allow(clippy::needless_pass_by_value)]
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{ipc::Channel, Emitter, Manager};

const LABEL: &str = "computer-preview";

#[cfg(windows)]
#[link(name = "user32")]
extern "system" { fn SetWindowDisplayAffinity(window: *mut std::ffi::c_void, affinity: u32) -> i32; }

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewSnapshot {
    title: String,
    status: String,
    detail: String,
    data_url: Option<String>,
    screenshot_at: Option<u64>,
    actions: Option<Vec<PreviewAction>>,
    action: Option<PreviewAction>,
    stream_state: Option<String>,
    stream_detail: Option<String>,
    frame_geometry: Option<PreviewFrameGeometry>,
    updated_at: Option<u64>,
    scope: Option<String>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewAction {
    id: String,
    title: String,
    target: String,
    status: String,
    started_at: Option<u64>,
    point: Option<PreviewPoint>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewPoint {
    x: f64,
    y: f64,
    space: String,
    end_x: Option<f64>,
    end_y: Option<f64>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewFrameGeometry {
    width: f64,
    height: f64,
    origin_x: Option<f64>,
    origin_y: Option<f64>,
    cursor_x: Option<f64>,
    cursor_y: Option<f64>,
}
#[derive(Default)]
pub struct PreviewState(pub Mutex<PreviewSnapshot>, pub Mutex<Option<Channel<PreviewSnapshot>>>);

#[tauri::command]
pub async fn computer_preview_open<R: tauri::Runtime>(webview: tauri::Webview<R>, automatic: Option<bool>) -> Result<Option<u64>, String> {
    if webview.label() != "main" { return Err("Only the main window can open the observer".into()); }
    let window = webview.window();
    // WebView2 creation deadlocks inside a synchronous IPC callback on Windows.
    tauri::async_runtime::spawn_blocking(move || create_observer(&window, automatic.unwrap_or(false)))
        .await.map_err(|e| e.to_string())?
}

fn create_observer<R: tauri::Runtime>(window: &tauri::Window<R>, automatic: bool) -> Result<Option<u64>, String> {
    let app = window.app_handle();
    if let Some(preview) = app.get_webview_window(LABEL) {
        preview.show().map_err(|e| e.to_string())?;
        preview.unminimize().map_err(|e| e.to_string())?;
        if !automatic { preview.set_focus().map_err(|e| e.to_string())?; }
        return observer_handle(&preview);
    }
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let origin = window.outer_position().map_err(|e| e.to_string())?;
    let size = window.outer_size().map_err(|e| e.to_string())?;
    let preview = tauri::WebviewWindowBuilder::new(app, LABEL, tauri::WebviewUrl::App("computer-preview.html".into()))
        .title("Trylo · 电脑控制")
        .inner_size(760.0, 540.0).min_inner_size(480.0, 360.0)
        .position(f64::from(origin.x) / scale + (f64::from(size.width) / scale - 780.0).max(0.0), f64::from(origin.y) / scale + 80.0)
        .decorations(true).always_on_top(true).skip_taskbar(true)
        .focused(!automatic).resizable(true).build().map_err(|e| e.to_string())?;
    let app_handle = app.clone();
    preview.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            let state = app_handle.state::<PreviewState>();
            let scope = state.0.lock().ok().and_then(|snapshot| snapshot.scope.clone()).unwrap_or_default();
            if let Ok(mut channel) = state.1.lock() { *channel = None; }
            let _ = app_handle.emit_to("main", "computer-preview-closed", scope);
        }
    });
    observer_handle(&preview)
}

#[cfg(windows)]
fn observer_handle<R: tauri::Runtime>(preview: &tauri::WebviewWindow<R>) -> Result<Option<u64>, String> {
    let hwnd = preview.hwnd().map_err(|e| e.to_string())?;
    // Exclude only our observer window; failure is handled by the capture worker's mask.
    unsafe { SetWindowDisplayAffinity(hwnd.0.cast(), 0x0000_0011); }
    Ok(Some(hwnd.0 as usize as u64))
}
#[cfg(target_os = "macos")]
fn observer_handle<R: tauri::Runtime>(preview: &tauri::WebviewWindow<R>) -> Result<Option<u64>, String> {
    let (send, receive) = std::sync::mpsc::sync_channel(1);
    let window = preview.clone();
    preview.run_on_main_thread(move || {
        let id = window.ns_window().ok().filter(|window| !window.is_null()).and_then(|pointer| {
            // Tauri owns this NSWindow and the callback runs on the AppKit thread.
            let window = unsafe { &*pointer.cast::<objc2_app_kit::NSWindow>() };
            u32::try_from(window.windowNumber()).ok().filter(|id| *id > 0)
        });
        let _ = send.send(id.map(u64::from));
    }).map_err(|error| error.to_string())?;
    receive.recv().map_err(|error| error.to_string())
}

#[cfg(not(any(windows, target_os = "macos")))]
// Match the fallible Windows handle lookup at the common call site.
#[allow(clippy::unnecessary_wraps)]
fn observer_handle<R: tauri::Runtime>(_preview: &tauri::WebviewWindow<R>) -> Result<Option<u64>, String> { Ok(None) }

#[tauri::command]
pub fn computer_preview_publish<R: tauri::Runtime>(webview: tauri::Webview<R>, state: tauri::State<'_, PreviewState>, snapshot: PreviewSnapshot) -> Result<(), String> {
    if webview.label() != "main" { return Err("Only the main window can publish".into()); }
    if snapshot.data_url.as_ref().is_some_and(|data| data.len() > 30 * 1024 * 1024 || !["data:image/png;base64,", "data:image/jpeg;base64,", "data:image/webp;base64,", "data:image/gif;base64,"].iter().any(|prefix| data.starts_with(prefix))) {
        return Err("Invalid preview image".into());
    }
    *state.0.lock().map_err(|e| e.to_string())? = snapshot.clone();
    let mut channel = state.1.lock().map_err(|e| e.to_string())?;
    if channel.as_ref().is_some_and(|listener| listener.send(snapshot).is_err()) {
        *channel = None;
        return Err("Preview channel disconnected".into());
    }
    Ok(())
}

#[tauri::command]
pub fn computer_preview_subscribe<R: tauri::Runtime>(webview: tauri::Webview<R>, state: tauri::State<'_, PreviewState>, on_snapshot: Channel<PreviewSnapshot>) -> Result<(), String> {
    if webview.label() != LABEL { return Err("Observer window required".into()); }
    let snapshot = state.0.lock().map_err(|e| e.to_string())?.clone();
    let mut channel = state.1.lock().map_err(|e| e.to_string())?;
    on_snapshot.send(snapshot).map_err(|e| e.to_string())?;
    *channel = Some(on_snapshot);
    Ok(())
}

#[cfg(all(test, feature = "preview-ipc-tests"))]
#[path = "computer_preview_tests.rs"]
mod tests;

#[cfg(test)]
mod snapshot_tests {
    use super::PreviewSnapshot;

    #[test]
    fn live_frame_snapshot_requires_integer_epoch_milliseconds() {
        let valid = serde_json::json!({
            "title": "实时窗口预览",
            "status": "",
            "detail": "从系统面板选择一个窗口。",
            "dataUrl": "data:image/jpeg;base64,aGVsbG8=",
            "streamState": "running",
            "frameGeometry": { "width": 1000, "height": 625, "originX": 0, "originY": 0 },
            "updatedAt": 1_795_766_860_757_u64,
            "scope": "ws:session:code"
        });
        let parsed: PreviewSnapshot = serde_json::from_value(valid).expect("integer updatedAt");
        assert_eq!(parsed.updated_at, Some(1_795_766_860_757));

        let fractional = serde_json::json!({
            "title": "实时窗口预览",
            "status": "",
            "detail": "",
            "updatedAt": 1_795_766_860_757.5_f64
        });
        assert!(serde_json::from_value::<PreviewSnapshot>(fractional).is_err());
    }
}
