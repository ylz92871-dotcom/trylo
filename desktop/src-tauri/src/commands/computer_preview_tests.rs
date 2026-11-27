use super::*;
use tauri::test::{
    get_ipc_response, mock_builder, mock_context, noop_assets, MockRuntime, INVOKE_KEY,
};

// This deliberately keeps the old argument type to reproduce Tauri's rejection.
#[tauri::command]
fn legacy_window_argument(_window: tauri::WebviewWindow<MockRuntime>) {}

struct CallingView<'a>(&'a tauri::Webview<MockRuntime>);
impl AsRef<tauri::Webview<MockRuntime>> for CallingView<'_> {
    fn as_ref(&self) -> &tauri::Webview<MockRuntime> { self.0 }
}

fn invoke(
    webview: &tauri::Webview<MockRuntime>,
    command: &str,
    body: serde_json::Value,
) -> Result<tauri::ipc::InvokeResponseBody, serde_json::Value> {
    get_ipc_response(
        &CallingView(webview),
        tauri::webview::InvokeRequest {
            cmd: command.into(),
            callback: tauri::ipc::CallbackFn(0),
            error: tauri::ipc::CallbackFn(1),
            url: webview.url().expect("test webview URL"),
            body: body.into(),
            headers: tauri::http::HeaderMap::default(),
            invoke_key: INVOKE_KEY.into(),
        },
    )
}

#[test]
fn main_with_browser_child_can_publish_and_browser_child_cannot_control_observer() {
    let app = mock_builder()
        .manage(PreviewState::default())
        .invoke_handler(tauri::generate_handler![
            legacy_window_argument,
            computer_preview_open,
            computer_preview_publish,
            computer_preview_subscribe
        ])
        .build(mock_context(noop_assets()))
        .expect("mock application");
    let main = tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::default())
        .build()
        .expect("main view");
    let child = main
        .as_ref()
        .window()
        .add_child(
            tauri::WebviewBuilder::new("browser-tab", tauri::WebviewUrl::default()),
            tauri::LogicalPosition::new(0, 0),
            tauri::LogicalSize::new(320, 240),
        )
        .expect("browser child");
    let main_view = app.get_webview("main").expect("main webview");
    assert!(app.get_webview_window("main").is_none());
    let legacy = invoke(&main_view, "legacy_window_argument", serde_json::json!({}));
    assert_eq!(
        legacy.err(),
        Some(serde_json::json!("current webview is not a WebviewWindow"))
    );

    let snapshot = serde_json::json!({"title":"点击","status":"执行中","detail":"","scope":"test"});
    assert!(invoke(
        &main_view,
        "computer_preview_publish",
        serde_json::json!({"snapshot":snapshot})
    )
    .is_ok());
    assert_eq!(
        app.state::<PreviewState>()
            .0
            .lock()
            .expect("snapshot lock")
            .title,
        "点击"
    );
    assert_eq!(
        invoke(
            &child,
            "computer_preview_publish",
            serde_json::json!({"snapshot":snapshot})
        )
        .err(),
        Some(serde_json::json!("Only the main window can publish"))
    );
    assert_eq!(
        invoke(
            &child,
            "computer_preview_open",
            serde_json::json!({"automatic":true})
        )
        .err(),
        Some(serde_json::json!(
            "Only the main window can open the observer"
        ))
    );
    assert_eq!(
        invoke(
            &main_view,
            "computer_preview_subscribe",
            serde_json::json!({"onSnapshot":"__CHANNEL__:1"})
        )
        .err(),
        Some(serde_json::json!("Observer window required"))
    );

    let observer = tauri::WebviewWindowBuilder::new(&app, LABEL, tauri::WebviewUrl::default())
        .build()
        .expect("observer view");
    assert!(invoke(
        observer.as_ref(),
        "computer_preview_subscribe",
        serde_json::json!({"onSnapshot":"__CHANNEL__:2"})
    )
    .is_ok());
    assert!(app
        .state::<PreviewState>()
        .1
        .lock()
        .expect("channel lock")
        .is_some());
}
