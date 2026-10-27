//! Native browser contents belong to Desktop, not to the MCP process tree.
//! Every command is main-webview-only; remote pages have no application IPC.
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, net::TcpListener, sync::{Mutex, atomic::{AtomicU64, Ordering}}};
use sha2::{Digest, Sha256};
use tauri::{Emitter, Manager, Webview, WebviewBuilder, WebviewUrl};

#[derive(Clone, Copy, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bounds { pub x: f64, pub y: f64, pub width: f64, pub height: f64 }
impl Default for Bounds {
    fn default() -> Self { Self { x: 0.0, y: 0.0, width: 480.0, height: 640.0 } }
}
impl Bounds {
    fn validate(self) -> Result<Self, String> {
        if [self.x, self.y, self.width, self.height].iter().any(|v| !v.is_finite())
            || self.x < 0.0 || self.y < 0.0 || self.width < 1.0 || self.height < 1.0
            || self.width > 16384.0 || self.height > 16384.0 {
            return Err("浏览器区域尺寸无效".into());
        }
        Ok(self)
    }
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeTab { pub label: String, pub marker: String, pub popup: bool }
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeSession {
    pub scope: String, pub cdp_port: u16, pub tabs: Vec<NativeTab>, pub active_label: String,
    bounds: Bounds,
    #[serde(skip)] visible: bool,
    zoom: f64,
    #[serde(skip)] next_tab: u64,
}
#[derive(Default)]
pub struct NativeBrowserState(pub Mutex<HashMap<String, NativeSession>>);
pub fn allows_application_ipc(label: &str) -> bool { !label.starts_with("browser-") }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeCommand {
    pub scope: String, pub operation: String, pub label: Option<String>,
    pub url: Option<String>, pub bounds: Option<Bounds>, pub visible: Option<bool>, pub zoom: Option<f64>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PageEvent { scope: String, label: String, url: Option<String>, title: Option<String> }
static NEXT_POPUP: AtomicU64 = AtomicU64::new(1);

fn observe_native_controls(webview: &Webview, scope: &str) -> Result<(), String> {
    #[cfg(windows)]
    {
        use webview2_com::{AcceleratorKeyPressedEventHandler, ZoomFactorChangedEventHandler, SourceChangedEventHandler};
        let app = webview.app_handle().clone(); let scope = scope.to_owned(); let label = webview.label().to_owned();
        webview.with_webview(move |platform| unsafe {
            let controller = platform.controller();
            let zoom_app = app.clone(); let zoom_scope = scope.clone(); let zoom_label = label.clone();
            let mut token = 0;
            let source_app = app.clone(); let source_scope = scope.clone(); let source_label = label.clone();
            let source = controller.CoreWebView2().and_then(|page| page.add_SourceChanged(&SourceChangedEventHandler::create(Box::new(move |_, _| {
                let _ = source_app.emit_to("main", "trylo-native-browser-page", PageEvent { scope: source_scope.clone(), label: source_label.clone(), url: None, title: None });
                Ok(())
            })), &mut token));
            let zoom = controller.add_ZoomFactorChanged(&ZoomFactorChangedEventHandler::create(Box::new(move |sender, _| {
                if let Some(sender) = sender {
                    let mut value = 1.0; sender.ZoomFactor(&mut value)?;
                    let _ = zoom_app.emit_to("main", "trylo-native-browser-controls", serde_json::json!({"scope":zoom_scope,"label":zoom_label,"zoom":value}));
                }
                Ok(())
            })), &mut token);
            let key_app = app.clone(); let key_scope = scope.clone(); let key_label = label.clone();
            let key = controller.add_AcceleratorKeyPressed(&AcceleratorKeyPressedEventHandler::create(Box::new(move |_, args| {
                if let Some(args) = args {
                    let mut value = 0; args.VirtualKey(&mut value)?;
                    if value == 27 { let _ = key_app.emit_to("main", "trylo-native-browser-controls", serde_json::json!({"scope":key_scope,"label":key_label,"key":"Escape"})); }
                }
                Ok(())
            })), &mut token);
            if zoom.is_err() || key.is_err() || source.is_err() { let _ = app.emit_to("main", "trylo-native-browser-controls", serde_json::json!({"scope":scope,"label":label,"error":"浏览器状态连接失败"})); }
        }).map_err(|e| e.to_string())?;
    }
    #[cfg(not(windows))]
    { let _ = (webview, scope); }
    Ok(())
}

fn report_native_zoom(webview: &Webview, scope: &str) {
    #[cfg(windows)]
    {
        let app = webview.app_handle().clone(); let scope = scope.to_owned(); let label = webview.label().to_owned();
        let _ = webview.with_webview(move |platform| unsafe {
            let mut zoom = 1.0;
            if platform.controller().ZoomFactor(&mut zoom).is_ok() { let _ = app.emit_to("main", "trylo-native-browser-controls", serde_json::json!({"scope":scope,"label":label,"zoom":zoom})); }
        });
    }
    #[cfg(not(windows))]
    { let _ = (webview, scope); }
}

fn native_navigation(webview: &Webview, operation: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        let (send, receive) = std::sync::mpsc::sync_channel(1);
        webview.with_webview(move |platform| unsafe {
            let result = platform.controller().CoreWebView2().and_then(|page| match operation.as_str() {
                "back" => page.GoBack(), "forward" => page.GoForward(), _ => page.Reload(),
            }).map_err(|e| e.to_string());
            let _ = send.send(result);
        }).map_err(|e| e.to_string())?;
        receive.recv_timeout(std::time::Duration::from_secs(5)).map_err(|e| e.to_string())?
    }
    #[cfg(not(windows))]
    { let _ = (webview, operation); Err("当前平台尚未接入原生浏览器".into()) }
}

fn acknowledge_native_bounds(webview: &Webview) -> Result<(), String> {
    // set_bounds posts to the UI thread. Await the following callback so
    // renderer backpressure tracks application of bounds, not just enqueueing.
    // This does not wait for the page's next rendered frame.
    let (send, receive) = std::sync::mpsc::sync_channel(1);
    webview.with_webview(move |_| { let _ = send.send(()); }).map_err(|e| e.to_string())?;
    receive.recv_timeout(std::time::Duration::from_secs(5)).map_err(|_| "浏览器视口更新超时".to_string())
}

fn scope_digest(scope: &str) -> String {
    // Persistent cookie profiles must keep their identity across Rust upgrades.
    format!("{:x}", Sha256::digest(scope.as_bytes()))
}
fn view(app: &tauri::AppHandle, label: &str) -> Result<Webview, String> {
    app.get_webview(label).ok_or_else(|| "原生浏览器页面已关闭".into())
}
fn create_tab(app: &tauri::AppHandle, session: &mut NativeSession, url: Option<&str>) -> Result<NativeTab, String> {
    if session.tabs.len() >= 32 { return Err("浏览器标签页已达到 32 页".into()); }
    let label = format!("browser-{}-{}", scope_digest(&session.scope), session.next_tab);
    session.next_tab += 1;
    let marker = format!("about:blank#trylo-native-{label}");
    let initial = marker.parse::<tauri::Url>().map_err(|e| e.to_string())?;
    let data = app.path().app_data_dir().map_err(|e| e.to_string())?
        .join("native-browser").join(scope_digest(&session.scope));
    std::fs::create_dir_all(&data).map_err(|e| e.to_string())?;
    let event_scope = session.scope.clone();
    let title_scope = session.scope.clone();
    let popup_scope = session.scope.clone();
    let popup_app = app.clone();
    let popup_data = data.clone();
    let popup_args = format!("--remote-debugging-port={} --remote-debugging-address=127.0.0.1", session.cdp_port);
    let script = format!("Object.defineProperty(globalThis,'__tryloNativeView',{{value:{label:?},configurable:false}});");
    let builder = WebviewBuilder::new(&label, WebviewUrl::External(initial))
        .data_directory(data)
        .additional_browser_args(&format!("--remote-debugging-port={} --remote-debugging-address=127.0.0.1", session.cdp_port))
        .disable_drag_drop_handler()
        .zoom_hotkeys_enabled(true)
        .initialization_script(&script)
        .on_page_load(move |webview, payload| {
            let _ = webview.app_handle().emit_to("main", "trylo-native-browser-page", PageEvent {
                scope: event_scope.clone(), label: webview.label().into(), url: Some(payload.url().to_string()), title: None,
            });
        })
        .on_document_title_changed(move |webview, title| {
            let _ = webview.app_handle().emit_to("main", "trylo-native-browser-page", PageEvent {
                scope: title_scope.clone(), label: webview.label().into(), url: None, title: Some(title),
            });
        })
        .on_new_window(move |_url, features| {
            // WebView2 supplies its environment in window_features: the popup
            // preserves window.opener and the same cookies/CDP endpoint.
            let label = format!("browser-{}-popup-{}", scope_digest(&popup_scope), NEXT_POPUP.fetch_add(1, Ordering::Relaxed));
            let marker = format!("about:blank#trylo-native-{label}");
            let Ok(initial) = marker.parse::<tauri::Url>() else { return tauri::webview::NewWindowResponse::Deny };
            let popup_script = format!("Object.defineProperty(globalThis,'__tryloNativeView',{{value:{label:?},configurable:false}});");
            let load_scope = popup_scope.clone(); let document_scope = popup_scope.clone();
            let popup = tauri::WebviewWindowBuilder::new(&popup_app, &label, WebviewUrl::External(initial))
                .window_features(features).data_directory(popup_data.clone()).additional_browser_args(&popup_args)
                .disable_drag_drop_handler().zoom_hotkeys_enabled(true).initialization_script(&popup_script)
                .on_page_load(move |webview, payload| {
                    let _ = webview.app_handle().emit_to("main", "trylo-native-browser-page", PageEvent {
                        scope: load_scope.clone(), label: webview.label().into(), url: Some(payload.url().to_string()), title: None,
                    });
                })
                .on_document_title_changed(move |webview, title| {
                    let _ = webview.app_handle().emit_to("main", "trylo-native-browser-page", PageEvent {
                        scope: document_scope.clone(), label: webview.label().into(), url: None, title: Some(title),
                    });
                })
                .title("Trylo · 浏览器").visible(false).build();
            match popup {
                Ok(window) => {
                    if let Some(webview) = popup_app.get_webview(&label) { let _ = observe_native_controls(&webview, &popup_scope); }
                    // Never block a native callback behind a command waiting on
                    // that same UI thread. Registration runs outside the callback.
                    let app = popup_app.clone(); let scope = popup_scope.clone();
                    let tab = NativeTab { label, marker, popup: true };
                    tauri::async_runtime::spawn_blocking(move || {
                        if let Ok(mut sessions) = app.state::<NativeBrowserState>().0.lock() {
                            if let Some(session) = sessions.get_mut(&scope) {
                                session.active_label.clone_from(&tab.label); session.tabs.push(tab.clone());
                                let _ = present(&app, session, None);
                            }
                        }
                        let _ = app.emit_to("main", "trylo-native-browser-page", PageEvent { scope, label: tab.label, url: None, title: None });
                    });
                    tauri::webview::NewWindowResponse::Create { window }
                },
                Err(error) => {
                    let _ = popup_app.emit_to("main", "trylo-native-browser-controls", serde_json::json!({"scope":popup_scope,"error":error.to_string()}));
                    tauri::webview::NewWindowResponse::Deny
                },
            }
        });
    let window = app.get_window("main").ok_or("主窗口已关闭")?;
    let tab = window.add_child(builder, tauri::LogicalPosition::new(-16384.0, -16384.0),
        tauri::LogicalSize::new(session.bounds.width, session.bounds.height)).map_err(|e| e.to_string())?;
    tab.hide().map_err(|e| e.to_string())?;
    observe_native_controls(&tab, &session.scope)?;
    tab.set_zoom(session.zoom).map_err(|e| e.to_string())?;
    let record = NativeTab { label: label.clone(), marker, popup: false };
    session.tabs.push(record.clone());
    session.active_label = label;
    if let Some(url) = url {
        tab.navigate(url.parse::<tauri::Url>().map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    }
    Ok(record)
}
fn presentation_update(session: &NativeSession, tab: &NativeTab, previous: Option<&NativeSession>) -> (bool, Option<bool>) {
    let known = previous.is_some_and(|old| old.tabs.iter().any(|old_tab| old_tab.label == tab.label));
    let visible = session.visible && tab.label == session.active_label;
    let was_visible = previous.is_some_and(|old| old.visible && old.active_label == tab.label);
    let bounds_changed = !tab.popup && (!known || previous.map_or(true, |old| old.bounds != session.bounds) || visible && !was_visible);
    (bounds_changed, if !known || visible != was_visible { Some(visible) } else { None })
}
fn present(app: &tauri::AppHandle, session: &NativeSession, previous: Option<&NativeSession>) -> Result<(), String> {
    for tab in &session.tabs {
        let (bounds_changed, visibility) = presentation_update(session, tab, previous);
        if !bounds_changed && visibility.is_none() { continue; }
        let webview = view(app, &tab.label)?;
        if tab.popup {
            if visibility == Some(true) { webview.window().show().map_err(|e| e.to_string())?; }
            else { webview.window().hide().map_err(|e| e.to_string())?; }
            continue;
        }
        // A real browser keeps background tabs at the window's viewport size.
        // Switching to a measured tab must not reflow it between hit testing
        // and the CDP input that uses those coordinates.
        if bounds_changed {
            webview.set_bounds(tauri::Rect {
                position: tauri::LogicalPosition::new(session.bounds.x, session.bounds.y).into(),
                size: tauri::LogicalSize::new(session.bounds.width, session.bounds.height).into(),
            }).map_err(|e| e.to_string())?;
        }
        if visibility.is_none() { continue; }
        if visibility == Some(true) {
            webview.show().map_err(|e| e.to_string())?;
        } else { webview.hide().map_err(|e| e.to_string())?; }
    }
    Ok(())
}

pub fn close_owned_popups(app: &tauri::AppHandle) {
    // A creation command may hold the session lock while waiting on this UI
    // thread. Never acquire that lock inside the native close callback.
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let labels: Vec<String> = app.state::<NativeBrowserState>().0.lock()
            .map(|sessions| sessions.values().flat_map(|session| session.tabs.iter())
                .filter(|tab| tab.popup).map(|tab| tab.label.clone()).collect()).unwrap_or_default();
        for label in labels { if let Some(window) = app.get_webview_window(&label) { let _ = window.close(); } }
    });
}
fn execute(app: &tauri::AppHandle, command: &NativeCommand) -> Result<NativeSession, String> {
    if command.scope.is_empty() || command.scope.len() > 4096 { return Err("浏览器会话无效".into()); }
    let state = app.state::<NativeBrowserState>();
    let mut sessions = state.0.lock().map_err(|e| e.to_string())?;
    if !sessions.contains_key(&command.scope) {
        if command.operation != "ensure" { return Err("原生浏览器尚未创建".into()); }
        let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        drop(listener);
        let mut session = NativeSession { scope: command.scope.clone(), cdp_port: port, tabs: vec![], active_label: String::new(),
            bounds: Bounds::default(), visible: false, zoom: 1.0, next_tab: 1 };
        create_tab(app, &mut session, None)?;
        sessions.insert(command.scope.clone(), session);
    }
    if command.operation == "layout" && command.visible == Some(true) {
        for (scope, other) in sessions.iter_mut() {
            if scope != &command.scope {
                other.visible = false;
                for tab in &other.tabs { if let Ok(webview) = view(app, &tab.label) {
                    if tab.popup { let _ = webview.window().hide(); } else { let _ = webview.hide(); }
                } }
            }
        }
    }
    let session = sessions.get_mut(&command.scope).ok_or("浏览器会话不存在")?;
    let previous = session.clone();
    session.tabs.retain(|tab| app.get_webview(&tab.label).is_some());
    if session.tabs.is_empty() { create_tab(app, session, None)?; }
    if !session.tabs.iter().any(|tab| tab.label == session.active_label) { session.active_label = session.tabs[0].label.clone(); }
    match command.operation.as_str() {
        "ensure" => {},
        "create" => { create_tab(app, session, command.url.as_deref())?; },
        "activate" | "close" => {
            let label = command.label.as_ref().ok_or("缺少页面标识")?;
            if !session.tabs.iter().any(|tab| &tab.label == label) { return Err("页面不属于当前会话".into()); }
            if command.operation == "close" {
                if session.tabs.len() == 1 { create_tab(app, session, None)?; }
                let target = view(app, label)?;
                if target.window().label() == "main" { target.close().map_err(|e| e.to_string())?; }
                else { target.window().close().map_err(|e| e.to_string())?; }
                session.tabs.retain(|tab| &tab.label != label);
                if &session.active_label == label { session.active_label = session.tabs[0].label.clone(); }
            } else { session.active_label.clone_from(label); }
        },
        "layout" => {
            if let Some(bounds) = command.bounds { session.bounds = bounds.validate()?; }
            session.visible = command.visible.unwrap_or(session.visible);
        },
        "zoom" => {
            let zoom = command.zoom.ok_or("缺少缩放比例")?;
            if !zoom.is_finite() || !(0.25..=5.0).contains(&zoom) { return Err("网页缩放比例无效".into()); }
            session.zoom = zoom;
            view(app, &session.active_label)?.set_zoom(zoom).map_err(|e| e.to_string())?;
        },
        "navigate" => {
            let url = command.url.as_ref().ok_or("缺少网页地址")?;
            view(app, &session.active_label)?.navigate(url.parse::<tauri::Url>().map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        },
        "back" | "forward" | "reload" => { native_navigation(&view(app, &session.active_label)?, command.operation.clone())?; },
        "focus" => {
            let target = view(app, &session.active_label)?;
            if target.window().label() != "main" { target.window().set_focus().map_err(|e| e.to_string())?; }
            target.set_focus().map_err(|e| e.to_string())?;
        },
        _ => return Err("未知原生浏览器操作".into()),
    }
    let session = sessions.get(&command.scope).ok_or("浏览器会话不存在")?;
    if command.operation != "ensure" { present(app, session, Some(&previous))?; }
    if command.operation == "layout" && (session.bounds != previous.bounds || session.visible != previous.visible) {
        acknowledge_native_bounds(&view(app, &session.active_label)?)?;
    }
    if command.operation == "activate" || command.operation == "layout" && session.visible && !previous.visible { report_native_zoom(&view(app, &session.active_label)?, &session.scope); }
    Ok(session.clone())
}

#[tauri::command]
pub async fn native_browser_command(webview: Webview, command: NativeCommand) -> Result<NativeSession, String> {
    if webview.label() != "main" { return Err("只有主界面可以控制原生浏览器".into()); }
    #[cfg(not(windows))]
    { let _ = command; return Err("当前平台尚未接入原生浏览器".into()); }
    #[cfg(windows)]
    {
        let app = webview.app_handle().clone();
        tauri::async_runtime::spawn_blocking(move || execute(&app, &command)).await.map_err(|e| e.to_string())?
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn service_host_receives_geometry_and_zoom_but_not_presentation_internals() {
        let session = NativeSession { scope: "one".into(), cdp_port: 9000, tabs: vec![], active_label: "tab".into(),
            bounds: Bounds::default(), visible: true, zoom: 1.5, next_tab: 2 };
        let value = serde_json::to_value(session).unwrap();
        assert_eq!(value["bounds"]["width"], 480.0);
        assert_eq!(value["zoom"], 1.5);
        assert!(value.get("visible").is_none());
        assert!(value.get("nextTab").is_none());
    }
    #[test] fn resizing_only_changes_bounds_and_restoring_a_hidden_view_reapplies_them() {
        let tab = NativeTab { label: "browser-one".into(), marker: "about:blank".into(), popup: false };
        let previous = NativeSession { scope: "one".into(), cdp_port: 9000, tabs: vec![tab.clone()], active_label: tab.label.clone(),
            bounds: Bounds::default(), visible: true, zoom: 1.0, next_tab: 2 };
        let mut current = previous.clone(); current.bounds.width = 640.0;
        assert_eq!(presentation_update(&current, &tab, Some(&previous)), (true, None));
        assert_eq!(presentation_update(&current, &tab, Some(&current)), (false, None));
        let mut hidden = current.clone(); hidden.visible = false;
        assert_eq!(presentation_update(&hidden, &tab, Some(&current)), (false, Some(false)));
        assert_eq!(presentation_update(&current, &tab, Some(&hidden)), (true, Some(true)));
    }
    #[test] fn browser_pages_cannot_invoke_application_commands() {
        assert!(!allows_application_ipc("browser-session-1"));
        assert!(!allows_application_ipc("browser-session-popup-2"));
        assert!(allows_application_ipc("main"));
        assert!(allows_application_ipc("computer-preview"));
    }
    #[test] fn rejects_invalid_native_geometry() {
        assert!(Bounds { width: f64::NAN, ..Bounds::default() }.validate().is_err());
        assert!(Bounds { x: -1.0, ..Bounds::default() }.validate().is_err());
        assert!(Bounds { width: 1920.0, height: 1080.0, ..Bounds::default() }.validate().is_ok());
    }
    #[test] fn scopes_have_distinct_browser_profiles() {
        assert_ne!(scope_digest("project-a:session"), scope_digest("project-b:session"));
        assert_eq!(scope_digest("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }
}
