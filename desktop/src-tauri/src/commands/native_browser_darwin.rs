//! Main-thread ownership of standalone browser tabs in the Trylo sidebar.
use std::{cell::RefCell, collections::HashMap, ptr::NonNull};

use block2::RcBlock;
use objc2::{rc::Retained, runtime::AnyObject, MainThreadMarker};
use objc2_app_kit::{NSEvent, NSEventMask, NSView};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, Url};
use wry::dpi::{LogicalPosition, LogicalSize};
use wry::{
    NewWindowResponse, Rect, WebView, WebViewBuilder, WebViewBuilderExtDarwin, WebViewExtMacOS,
};

use super::{
    presentation_update, scope_digest, Bounds, NativeCommand, NativeSession, NativeTab, PageEvent,
};

struct Session {
    record: NativeSession,
    views: HashMap<String, WebView>,
}

#[derive(Default)]
struct Browser {
    sessions: HashMap<String, Session>,
    key_monitor: Option<Retained<AnyObject>>,
}

thread_local! {
    static BROWSER: RefCell<Browser> = RefCell::new(Browser::default());
}

fn url_for_browser(value: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|error| error.to_string())?;
    if matches!(url.scheme(), "http" | "https") || value == "about:blank" {
        return Ok(url);
    }
    Err("内置浏览器支持 HTTP 和 HTTPS 网页".into())
}

fn bounds_rect(bounds: Bounds) -> Rect {
    Rect {
        position: LogicalPosition::new(bounds.x, bounds.y).into(),
        size: LogicalSize::new(bounds.width, bounds.height).into(),
    }
}

fn page_event(
    app: &AppHandle,
    scope: &str,
    label: &str,
    url: Option<String>,
    title: Option<String>,
) {
    let _ = app.emit_to(
        "main",
        "trylo-native-browser-page",
        PageEvent {
            scope: scope.into(),
            label: label.into(),
            url,
            title,
        },
    );
}

impl Session {
    fn new(scope: &str) -> Self {
        Self {
            record: NativeSession {
                scope: scope.into(),
                cdp_available: false,
                cdp_port: None,
                tabs: Vec::new(),
                active_label: String::new(),
                bounds: Bounds::default(),
                visible: false,
                zoom: 1.0,
                next_tab: 1,
            },
            views: HashMap::new(),
        }
    }

    fn create_tab(&mut self, app: &AppHandle, url: Option<&str>) -> Result<(), String> {
        if self.record.tabs.len() >= 32 {
            return Err("浏览器标签页已达到 32 页".into());
        }
        let initial = url_for_browser(url.unwrap_or("about:blank"))?.to_string();
        let window = app.get_window("main").ok_or("主窗口已关闭")?;
        let scope = &self.record.scope;
        let digest = Sha256::digest(scope.as_bytes());
        let profile = digest[..16].try_into().expect("16-byte WebKit profile ID");
        let label = format!("browser-{}-{}", scope_digest(scope), self.record.next_tab);
        let (load_app, load_scope, load_label) = (app.clone(), scope.clone(), label.clone());
        let (title_app, title_scope, title_label) = (app.clone(), scope.clone(), label.clone());

        // Remote content receives its own WKWebView configuration and no Tauri bridge.
        let view = WebViewBuilder::new()
            .with_data_store_identifier(profile)
            .with_visible(false)
            .with_bounds(bounds_rect(self.record.bounds))
            .with_navigation_handler(|url| url_for_browser(&url).is_ok())
            .with_new_window_req_handler(|_, _| NewWindowResponse::Deny)
            .with_on_page_load_handler(move |_, url| {
                page_event(&load_app, &load_scope, &load_label, Some(url), None);
            })
            .with_document_title_changed_handler(move |title| {
                page_event(&title_app, &title_scope, &title_label, None, Some(title));
            })
            .with_url(&initial)
            .build_as_child(&window)
            .map_err(|error| error.to_string())?;
        view.zoom(self.record.zoom)
            .map_err(|error| error.to_string())?;

        self.record.next_tab += 1;
        self.record.active_label.clone_from(&label);
        self.record.tabs.push(NativeTab {
            label: label.clone(),
            marker: "about:blank".into(),
            popup: false,
            url: initial,
            title: String::new(),
        });
        self.views.insert(label, view);
        Ok(())
    }

    fn close_tab(&mut self, app: &AppHandle, label: &str) -> Result<(), String> {
        if self.record.tabs.len() == 1 {
            self.create_tab(app, None)?;
        }
        if let Some(view) = self.views.remove(label) {
            let _ = view.load_url("about:blank");
        }
        self.record.tabs.retain(|tab| tab.label != label);
        if self.record.active_label == label {
            self.record
                .active_label
                .clone_from(&self.record.tabs[0].label);
        }
        Ok(())
    }

    fn present(&self, previous: &NativeSession) -> Result<(), String> {
        for tab in &self.record.tabs {
            let (bounds_changed, visible) = presentation_update(&self.record, tab, Some(previous));
            let view = &self.views[&tab.label];
            if bounds_changed {
                view.set_bounds(bounds_rect(self.record.bounds))
                    .map_err(|error| error.to_string())?;
            }
            if let Some(visible) = visible {
                view.set_visible(visible)
                    .map_err(|error| error.to_string())?;
            }
        }
        Ok(())
    }

    fn snapshot(&self) -> NativeSession {
        let mut snapshot = self.record.clone();
        for tab in &mut snapshot.tabs {
            let view = &self.views[&tab.label];
            if let Ok(url) = view.url() {
                tab.url = url;
            }
            // The WKWebView handle lives on this AppKit thread.
            let title = unsafe { view.webview().title() };
            tab.title = title.map_or_else(String::new, |title| title.to_string());
        }
        snapshot
    }

    fn apply(&mut self, app: &AppHandle, command: &NativeCommand) -> Result<(), String> {
        let previous = self.record.clone();
        match command.operation.as_str() {
            "ensure" => return Ok(()),
            "create" => self.create_tab(app, command.url.as_deref())?,
            operation @ ("activate" | "close") => {
                let label = command.label.as_deref().ok_or("缺少页面标识")?;
                if !self.views.contains_key(label) {
                    return Err("页面不属于当前会话".into());
                }
                if operation == "activate" {
                    self.views[label]
                        .zoom(self.record.zoom)
                        .map_err(|error| error.to_string())?;
                    self.record.active_label = label.into();
                } else {
                    self.close_tab(app, label)?;
                }
            }
            "layout" => {
                if let Some(bounds) = command.bounds {
                    self.record.bounds = bounds.validate()?;
                }
                self.record.visible = command.visible.unwrap_or(self.record.visible);
            }
            operation => return self.page_command(command, operation),
        }
        self.present(&previous)
    }

    fn page_command(&mut self, command: &NativeCommand, operation: &str) -> Result<(), String> {
        let view = &self.views[&self.record.active_label];
        match operation {
            "navigate" => {
                let url = url_for_browser(command.url.as_deref().ok_or("缺少网页地址")?)?;
                view.load_url(url.as_str())
            }
            "back" | "forward" => {
                let native = view.webview();
                // Navigation stays on the AppKit main thread and uses WebKit history.
                unsafe {
                    if operation == "back" {
                        native.goBack();
                    } else {
                        native.goForward();
                    }
                }
                Ok(())
            }
            "reload" => view.reload(),
            "focus" => view.focus(),
            "zoom" => {
                let zoom = command.zoom.ok_or("缺少缩放比例")?;
                if !(0.25..=5.0).contains(&zoom) {
                    return Err("网页缩放比例无效".into());
                }
                view.zoom(zoom).map_err(|error| error.to_string())?;
                self.record.zoom = zoom;
                Ok(())
            }
            _ => return Err("未知原生浏览器操作".into()),
        }
        .map_err(|error| error.to_string())
    }
}

fn monitor_escape(app: AppHandle) -> Option<Retained<AnyObject>> {
    let handler = RcBlock::new(move |event: NonNull<NSEvent>| {
        // AppKit supplies a borrowed event for the lifetime of this callback.
        let pressed = unsafe { event.as_ref() };
        if pressed.keyCode() == 0x35 {
            let responder = MainThreadMarker::new()
                .and_then(|marker| pressed.window(marker))
                .and_then(|window| window.firstResponder())
                .and_then(|responder| responder.downcast::<NSView>().ok());
            if let (Some(responder), Ok(Some((scope, label, view)))) = (
                responder,
                BROWSER.try_with(|browser| {
                    browser.try_borrow().ok().and_then(|browser| {
                        let session = browser
                            .sessions
                            .values()
                            .find(|session| session.record.visible)?;
                        let label = &session.record.active_label;
                        Some((
                            session.record.scope.clone(),
                            label.clone(),
                            session.views[label].webview(),
                        ))
                    })
                }),
            ) {
                if responder.isDescendantOf(&view) {
                    let _ = app.emit_to(
                        "main",
                        "trylo-native-browser-controls",
                        serde_json::json!({"scope": scope, "label": label, "key": "Escape"}),
                    );
                }
            }
        }
        event.as_ptr()
    });
    // The monitor only observes local events and always returns the same valid pointer.
    unsafe { NSEvent::addLocalMonitorForEventsMatchingMask_handler(NSEventMask::KeyDown, &handler) }
}

fn execute(app: &AppHandle, command: &NativeCommand) -> Result<NativeSession, String> {
    let scope = &command.scope;
    if scope.is_empty() || scope.len() > 4096 {
        return Err("浏览器会话无效".into());
    }
    BROWSER.with_borrow_mut(|browser| {
        if !browser.sessions.contains_key(scope) {
            if command.operation != "ensure" {
                return Err("原生浏览器尚未创建".into());
            }
            let mut session = Session::new(scope);
            session.create_tab(app, None)?;
            browser.sessions.insert(scope.clone(), session);
            if browser.key_monitor.is_none() {
                browser.key_monitor = monitor_escape(app.clone());
            }
        }
        let session = browser.sessions.get_mut(scope).ok_or("浏览器会话不存在")?;
        session.apply(app, command)?;
        let snapshot = session.snapshot();
        if command.operation == "layout" && snapshot.visible {
            for (other_scope, other) in &mut browser.sessions {
                if other_scope != scope && other.record.visible {
                    let previous = other.record.clone();
                    other.record.visible = false;
                    other.present(&previous)?;
                }
            }
        }
        Ok(snapshot)
    })
}

pub(super) async fn command(
    app: &AppHandle,
    command: NativeCommand,
) -> Result<NativeSession, String> {
    let (send, receive) = tokio::sync::oneshot::channel();
    let owner = app.clone();
    app.run_on_main_thread(move || {
        let _ = send.send(execute(&owner, &command));
    })
    .map_err(|error| error.to_string())?;
    receive.await.map_err(|_| "浏览器窗口已关闭")?
}

pub(super) fn close_all(app: &AppHandle) {
    let _ = app.run_on_main_thread(|| {
        BROWSER.with_borrow_mut(|browser| {
            if let Some(monitor) = browser.key_monitor.take() {
                // This token was returned by AppKit for our local keyboard monitor.
                unsafe { NSEvent::removeMonitor(&monitor) };
            }
            for session in browser.sessions.values() {
                for view in session.views.values() {
                    let _ = view.load_url("about:blank");
                }
            }
            browser.sessions.clear();
        });
    });
}
