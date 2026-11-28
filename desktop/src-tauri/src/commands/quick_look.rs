#[cfg(target_os = "macos")]
use std::{process::Stdio, sync::Mutex};
#[cfg(target_os = "macos")]
use tauri::Manager;
#[cfg(target_os = "macos")]
use tokio::sync::oneshot;

#[derive(Default)]
pub struct QuickLookState {
    #[cfg(target_os = "macos")]
    active: Mutex<Option<oneshot::Sender<()>>>,
}

#[cfg(target_os = "macos")]
impl QuickLookState {
    pub fn close(&self) {
        if let Ok(mut active) = self.active.lock() {
            active.take();
        }
    }
}

#[tauri::command]
pub async fn quick_look_open(
    app: tauri::AppHandle,
    window: tauri::Webview,
    state: tauri::State<'_, QuickLookState>,
    file_path: String,
    allowed_root: String,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        if window.label() != "main" {
            return Err("快速预览只能从主窗口打开".to_owned());
        }
        let target = super::work_host::validate_target(&file_path, &allowed_root)
            .map_err(|error| error.to_string())?;
        if !target.is_file() {
            return Err("快速预览需要一个本地文件".to_owned());
        }
        let relative = "desktop-services/macos-mcp/bin/trylo-macos-mcp";
        let helper = app.path().resource_dir().map_err(|error| error.to_string())?.join(relative);
        #[cfg(debug_assertions)]
        let helper = if helper.is_file() {
            helper
        } else {
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("resources").join(relative)
        };
        let mut active = state.active.lock().map_err(|error| error.to_string())?;
        let (cancel, closed) = oneshot::channel();
        let mut child = tokio::process::Command::new(helper)
            .kill_on_drop(true)
            .arg("--quick-look")
            .arg(target)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .spawn()
            .map_err(|error| format!("无法打开快速预览：{error}"))?;
        *active = Some(cancel);
        tauri::async_runtime::spawn(async move {
            // Move ownership of the child to the async runtime so replacing
            // the preview or quitting Desktop can cancel and reap it.
            tokio::select! {
                _ = child.wait() => {},
                _ = closed => { let _ = child.kill().await; }
            }
        });
        Ok(())
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, window, state, file_path, allowed_root);
        Err("快速预览需要 macOS".to_owned())
    }
}
