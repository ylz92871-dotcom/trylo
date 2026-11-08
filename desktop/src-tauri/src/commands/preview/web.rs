use tauri::Manager;
use crate::preview::web::{WebBounds, WebOpenResult, WebPreviewState};

#[tauri::command]
pub fn preview_web_open(file_path: String, allowed_root: String, token: String, state: tauri::State<'_, WebPreviewState>) -> Result<WebOpenResult, String> {
    let target = crate::commands::work_host::validate_target(&file_path, &allowed_root).map_err(|e| e.to_string())?;
    state.assets.open(token, &target)
}
#[tauri::command]
pub async fn preview_web_layout(app: tauri::AppHandle, token: String, bounds: WebBounds, visible: bool, state: tauri::State<'_, WebPreviewState>) -> Result<(), String> {
    crate::preview::web::layout(&app, &state, &token, bounds, visible)
}
#[tauri::command]
pub async fn preview_web_close(app: tauri::AppHandle, token: String, state: tauri::State<'_, WebPreviewState>) -> Result<(), String> {
    crate::preview::web::close(&app, &state, &token)
}
#[tauri::command]
pub fn preview_web_status(app: tauri::AppHandle, token: String) -> Vec<String> { app.state::<WebPreviewState>().assets.warnings(&token) }
