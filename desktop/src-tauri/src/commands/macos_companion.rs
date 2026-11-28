#![allow(clippy::needless_pass_by_value)] // Tauri supplies command extractors by value.

use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{ipc::Channel, Manager, State, Webview};

pub(crate) const LABEL: &str = "macos-companion";

#[derive(Clone, Copy, Default, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CompanionDisplay {
    #[default]
    Idle,
    Running,
    Waiting,
    Done,
    Failed,
    Stopped,
}

#[derive(Default)]
pub struct CompanionWindowState {
    view: Mutex<(CompanionDisplay, Option<Channel<CompanionDisplay>>)>,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CompanionWindowAction {
    Show,
    Hide,
    Status,
}

pub(crate) fn allows_command(label: &str, command: &str) -> bool {
    label != LABEL || matches!(command, "macos_companion_subscribe" | "macos_companion_return")
}

#[tauri::command]
pub async fn macos_companion_window(
    webview: Webview,
    action: CompanionWindowAction,
) -> Result<bool, String> {
    if webview.label() != "main" || !cfg!(target_os = "macos") {
        return Err("桌面伙伴窗口由 Trylo 主窗口管理".into());
    }

    let app = webview.app_handle().clone();
    let window = app.get_webview_window(LABEL);
    match action {
        CompanionWindowAction::Status => window.map_or(Ok(false), |window| {
            window.is_visible().map_err(|error| error.to_string())
        }),
        CompanionWindowAction::Hide => {
            if let Some(window) = window { window.close().map_err(|error| error.to_string())?; }
            Ok(false)
        }
        CompanionWindowAction::Show => {
            if let Some(window) = window {
                window.show().map_err(|error| error.to_string())?;
                return Ok(true);
            }
            let window = tauri::WebviewWindowBuilder::new(
                &app, LABEL, tauri::WebviewUrl::App("macos-companion.html".into()),
            )
            .title("Trylo 桌面伙伴")
            .inner_size(284.0, 86.0)
            .decorations(false)
            .resizable(false)
            .always_on_top(true)
            .visible_on_all_workspaces(true)
            .skip_taskbar(true)
            .focused(false)
            .visible(false)
            .build()
            .map_err(|error| error.to_string())?;
            if let Ok(Some(monitor)) = webview.window().current_monitor() {
                let area = monitor.work_area();
                let footprint = tauri::LogicalSize::new(304.0, 106.0)
                    .to_physical::<u32>(monitor.scale_factor());
                let x = i32::try_from(area.size.width.saturating_sub(footprint.width)).unwrap_or(i32::MAX);
                let y = i32::try_from(area.size.height.saturating_sub(footprint.height)).unwrap_or(i32::MAX);
                window.set_position(tauri::PhysicalPosition::new(
                    area.position.x.saturating_add(x), area.position.y.saturating_add(y),
                )).map_err(|error| error.to_string())?;
            }
            window.show().map_err(|error| error.to_string())?;
            Ok(true)
        }
    }
}

#[tauri::command]
pub fn macos_companion_publish(
    webview: Webview, state: State<'_, CompanionWindowState>, display: CompanionDisplay,
) -> Result<(), String> {
    if webview.label() != "main" { return Err("桌面伙伴只接受主窗口状态".into()); }
    let mut view = state.view.lock().map_err(|error| error.to_string())?;
    view.0 = display;
    if view.1.as_ref().is_some_and(|channel| channel.send(display).is_err()) { view.1 = None; }
    Ok(())
}

#[tauri::command]
pub fn macos_companion_subscribe(
    webview: Webview,
    state: State<'_, CompanionWindowState>,
    on_display: Channel<CompanionDisplay>,
) -> Result<(), String> {
    if webview.label() != LABEL { return Err("桌面伙伴窗口才能订阅".into()); }
    let mut view = state.view.lock().map_err(|error| error.to_string())?;
    on_display.send(view.0).map_err(|error| error.to_string())?;
    view.1 = Some(on_display);
    Ok(())
}

#[tauri::command]
pub fn macos_companion_return(webview: Webview) -> Result<(), String> {
    if webview.label() != LABEL && webview.label() != "main" {
        return Err("桌面伙伴无法打开主窗口".into());
    }
    #[cfg(target_os = "macos")]
    crate::macos_shell::restore_main_window(webview.app_handle());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{allows_command, LABEL};

    #[test]
    fn the_companion_can_only_receive_state_and_open_the_main_window() {
        assert!(allows_command(LABEL, "macos_companion_subscribe"));
        assert!(allows_command(LABEL, "macos_companion_return"));
        assert!(!allows_command(LABEL, "process_spawn"));
        assert!(!allows_command(LABEL, "macos_companion_publish"));
        assert!(allows_command("main", "macos_companion_publish"));
    }
}
