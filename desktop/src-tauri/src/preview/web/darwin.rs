use std::cell::RefCell;

use tauri::{Emitter, Manager};
use wry::dpi::{LogicalPosition, LogicalSize};
use wry::{NewWindowResponse, PageLoadEvent, Rect, WebView, WebViewBuilder};

use super::{WebBounds, WebPreviewState};

const SCHEME: &str = "trylo-preview";

struct Preview {
    token: String,
    view: WebView,
}

thread_local! {
    // AppKit views must be created, moved, and dropped on the main thread.
    static ACTIVE: RefCell<Option<Preview>> = const { RefCell::new(None) };
}

async fn on_main(
    app: &tauri::AppHandle,
    work: impl FnOnce(&tauri::AppHandle) -> Result<(), String> + Send + 'static,
) -> Result<(), String> {
    let (send, receive) = tokio::sync::oneshot::channel();
    let owner = app.clone();
    app.run_on_main_thread(move || {
        let _ = send.send(work(&owner));
    })
    .map_err(|error| error.to_string())?;
    receive.await.map_err(|_| "网页预览窗口已关闭")?
}

fn is_preview_url(url: &str) -> bool {
    url.parse::<tauri::http::Uri>().is_ok_and(|uri| {
        uri.scheme_str() == Some(SCHEME)
            && uri
                .authority()
                .is_some_and(|authority| authority.as_str() == "localhost")
    })
}

fn create_view(
    app: &tauri::AppHandle,
    token: &str,
    url: &str,
    bounds: Rect,
) -> Result<WebView, String> {
    let parent = app.get_window("main").ok_or("主窗口已关闭")?;
    let asset_app = app.clone();
    let asset_token = token.to_owned();
    let navigation_app = app.clone();
    let navigation_token = token.to_owned();
    let event_app = app.clone();
    let event_token = token.to_owned();

    // Standalone Wry owns the configuration, so the only installed scheme
    // handler is this view's preview grant. Tauri's IPC and asset schemes are absent.
    WebViewBuilder::new()
        .with_incognito(true)
        .with_bounds(bounds)
        .with_asynchronous_custom_protocol(SCHEME.into(), move |_, request, responder| {
            let app = asset_app.clone();
            let token = asset_token.clone();
            tauri::async_runtime::spawn_blocking(move || {
                let response = if request.uri().scheme_str() == Some(SCHEME)
                    && request
                        .uri()
                        .authority()
                        .is_some_and(|authority| authority.as_str() == "localhost")
                {
                    app.state::<WebPreviewState>()
                        .assets
                        .serve(&request, Some(&token))
                } else {
                    tauri::http::Response::builder()
                        .status(403)
                        .body(Vec::new())
                        .expect("static response")
                };
                responder.respond(response);
            });
        })
        .with_navigation_handler(move |url| {
            let allowed = is_preview_url(&url);
            if !allowed && url != "about:blank" {
                navigation_app
                    .state::<WebPreviewState>()
                    .assets
                    .warn(&navigation_token, "外部页面链接请使用外部应用打开".into());
            }
            allowed || url == "about:blank"
        })
        .with_new_window_req_handler(|_, _| NewWindowResponse::Deny)
        .with_on_page_load_handler(move |event, url| {
            if matches!(event, PageLoadEvent::Finished) && is_preview_url(&url) {
                let _ = event_app.emit_to(
                    "main",
                    "preview-web-ready",
                    serde_json::json!({ "token": event_token }),
                );
            }
        })
        .with_url(url)
        .build_as_child(&parent)
        .map_err(|error| error.to_string())
}

fn retire(state: &WebPreviewState, preview: Preview) {
    state.assets.close(&preview.token);
    // Stop the untrusted document before Wry detaches the native view.
    let _ = preview.view.load_url("about:blank");
    drop(preview);
}

pub(super) async fn layout(
    app: &tauri::AppHandle,
    token: &str,
    bounds: WebBounds,
    visible: bool,
) -> Result<(), String> {
    let token = token.to_owned();
    on_main(app, move |app| {
        let state = app.state::<WebPreviewState>();
        let url = state.assets.url(&token)?;
        let rect = Rect {
            position: LogicalPosition::new(bounds.x, bounds.y).into(),
            size: LogicalSize::new(bounds.width, bounds.height).into(),
        };
        ACTIVE.with_borrow_mut(|active| {
            if let Some(current) = active.as_ref().filter(|view| view.token == token) {
                current
                    .view
                    .set_bounds(rect)
                    .map_err(|error| error.to_string())?;
                return current
                    .view
                    .set_visible(visible)
                    .map_err(|error| error.to_string());
            }
            if visible {
                let view = create_view(app, &token, &url, rect)?;
                if let Some(previous) = active.replace(Preview { token, view }) {
                    retire(&state, previous);
                }
            }
            Ok(())
        })
    })
    .await
}

pub(super) async fn close(app: &tauri::AppHandle, token: &str) -> Result<(), String> {
    let token = token.to_owned();
    on_main(app, move |app| {
        let state = app.state::<WebPreviewState>();
        ACTIVE.with_borrow_mut(|active| {
            if active.as_ref().is_some_and(|view| view.token == token) {
                if let Some(preview) = active.take() {
                    retire(&state, preview);
                }
            } else {
                state.assets.close(&token);
            }
        });
        Ok(())
    })
    .await
}
