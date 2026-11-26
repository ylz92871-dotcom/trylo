#[cfg(not(target_os = "macos"))]
use std::{path::PathBuf, sync::{Mutex, atomic::{AtomicU64, Ordering}}};
use serde::Deserialize;
#[cfg(not(target_os = "macos"))]
use tauri::{Emitter, Manager, WebviewBuilder, WebviewUrl};
use super::WebAssets;

#[cfg(not(target_os = "macos"))]
static NEXT_VIEW: AtomicU64 = AtomicU64::new(0);
#[cfg(not(target_os = "macos"))]
#[derive(Clone)]
pub(super) struct ActiveView { pub token: String, pub label: String, pub profile_root: PathBuf, pub profile: PathBuf }
#[derive(Default)]
pub struct WebPreviewState {
    pub assets: WebAssets,
    #[cfg(not(target_os = "macos"))]
    pub(super) active: Mutex<Option<ActiveView>>,
}
#[cfg(not(target_os = "macos"))]
impl WebPreviewState {
    pub fn serve(&self, request: &tauri::http::Request<Vec<u8>>, label: &str) -> tauri::http::Response<Vec<u8>> {
        let active = self.active.lock().ok().and_then(|active| active.clone()).filter(|active| active.label == label);
        let Some(active) = active else { return tauri::http::Response::builder().status(403).body(vec![]).expect("static response"); };
        self.assets.serve(request, Some(&active.token))
    }
}

#[cfg(not(target_os = "macos"))]
fn retire(app: &tauri::AppHandle, state: &WebPreviewState, active: &mut Option<ActiveView>) -> Result<(), String> {
    if let Some(owned) = active.as_ref() {
        if let Some(view) = app.get_webview(&owned.label) { view.close().map_err(|e| e.to_string())?; }
    }
    if let Some(owned) = active.take() {
        state.assets.close(&owned.token);
        super::profiles::retire(owned.profile_root, owned.profile);
    }
    Ok(())
}
#[derive(Clone, Copy, Deserialize)]
pub struct WebBounds { pub x: f64, pub y: f64, pub width: f64, pub height: f64 }

#[cfg_attr(not(target_os = "macos"), allow(clippy::unused_async))] // Same IPC contract for both native views.
pub async fn layout(app: &tauri::AppHandle, token: &str, bounds: WebBounds, visible: bool) -> Result<(), String> {
    if [bounds.x, bounds.y, bounds.width, bounds.height].iter().any(|value| !value.is_finite()) || bounds.x < 0.0 || bounds.y < 0.0 || bounds.width < 1.0 || bounds.height < 1.0 || bounds.width > 16384.0 || bounds.height > 16384.0 { return Err("网页预览区域无效".into()); }
    #[cfg(target_os = "macos")]
    {
        super::darwin::layout(app, token, bounds, visible).await
    }
    #[cfg(not(target_os = "macos"))]
    layout_tauri(app, &app.state::<WebPreviewState>(), token, bounds, visible)
}

#[cfg(not(target_os = "macos"))]
fn layout_tauri(app: &tauri::AppHandle, state: &WebPreviewState, token: &str, bounds: WebBounds, visible: bool) -> Result<(), String> {
    let url = state.assets.url(token)?;
    let mut active = state.active.lock().map_err(|_| "网页预览窗口状态不可用")?;
    let current = active.as_ref().is_some_and(|owned| owned.token == token);
    if !visible && !current { return Ok(()); }
    if !current {
        retire(app, state, &mut active)?;
        let window = app.get_window("main").ok_or("主窗口已关闭")?;
        let label = format!("browser-artifact-preview-{}-{}", std::process::id(), NEXT_VIEW.fetch_add(1, Ordering::Relaxed));
        let profile_root = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("preview/web");
        std::fs::create_dir_all(&profile_root).map_err(|e| e.to_string())?;
        let profile = profile_root.join(&label);
        // A leftover from an earlier process must never become this view's
        // storage/service-worker profile, even if a process id is reused.
        std::fs::create_dir(&profile).map_err(|e| e.to_string())?;
        let profile_root = std::fs::canonicalize(profile_root).map_err(|e| e.to_string())?;
        let initial = url.parse::<tauri::Url>().map_err(|e| e.to_string())?;
        let origin = (initial.scheme().to_string(), initial.host_str().map(str::to_string), initial.port());
        let loaded_origin = origin.clone();
        let navigation_app = app.clone(); let navigation_token = token.to_string();
        let loaded_token = token.to_string();
        // Never load untrusted content before the native host filters are detached.
        let builder = WebviewBuilder::new(&label, WebviewUrl::External(tauri::Url::parse("about:blank").expect("static URL")))
            .data_directory(profile.clone()).incognito(true).disable_drag_drop_handler().use_https_scheme(false)
            .on_page_load(move |webview, payload| {
                let url = payload.url();
                if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) && url.scheme() == loaded_origin.0 && url.host_str() == loaded_origin.1.as_deref() && url.port() == loaded_origin.2 {
                    let _ = webview.app_handle().emit_to("main", "preview-web-ready", serde_json::json!({ "token": loaded_token }));
                }
            })
            .on_navigation(move |url| {
                let allowed = url.scheme() == origin.0 && url.host_str() == origin.1.as_deref() && url.port() == origin.2;
                if !allowed && url.as_str() != "about:blank" { navigation_app.state::<WebPreviewState>().assets.warn(&navigation_token, "外部页面链接请使用外部应用打开".into()); }
                allowed
            })
            .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny);
        let view = match window.add_child(builder, tauri::LogicalPosition::new(bounds.x, bounds.y), tauri::LogicalSize::new(bounds.width, bounds.height)) {
            Ok(view) => view,
            Err(error) => { super::profiles::retire(profile_root, profile); return Err(error.to_string()); }
        };
        *active = Some(ActiveView { token: token.to_string(), label, profile_root, profile });
        if let Err(error) = super::host_protocols::detach(&view).and_then(|()| view.navigate(initial).map_err(|e| e.to_string())) {
            let _ = retire(app, state, &mut active);
            return Err(error);
        }
    }
    let label = &active.as_ref().ok_or("网页预览窗口已关闭")?.label;
    let view = app.get_webview(label).ok_or("网页预览窗口已关闭")?;
    view.set_position(tauri::LogicalPosition::new(bounds.x, bounds.y)).map_err(|e| e.to_string())?;
    view.set_size(tauri::LogicalSize::new(bounds.width, bounds.height)).map_err(|e| e.to_string())?;
    if visible { view.show() } else { view.hide() }.map_err(|e| e.to_string())
}

#[cfg_attr(not(target_os = "macos"), allow(clippy::unused_async))] // Same IPC contract for both native views.
pub async fn close(app: &tauri::AppHandle, token: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        super::darwin::close(app, token).await
    }
    #[cfg(not(target_os = "macos"))]
    close_tauri(app, &app.state::<WebPreviewState>(), token)
}

#[cfg(not(target_os = "macos"))]
fn close_tauri(app: &tauri::AppHandle, state: &WebPreviewState, token: &str) -> Result<(), String> {
    let mut active = state.active.lock().map_err(|_| "网页预览窗口状态不可用")?;
    let result = if active.as_ref().is_some_and(|owned| owned.token == token) { retire(app, state, &mut active) } else { Ok(()) };
    state.assets.close(token);
    result
}
