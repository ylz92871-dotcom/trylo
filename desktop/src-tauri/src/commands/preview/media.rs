//! Transport only; jobs, cache, protocol and engine supply live in preview/media.
pub use crate::preview::media::MediaState;

#[tauri::command]
pub async fn preview_media_open(
    webview: tauri::Webview, token: String, file_path: String, allowed_root: String,
    state: tauri::State<'_, MediaState>,
) -> Result<crate::preview::media::MediaOpenResult, String> {
    let owner = webview.label().to_string(); let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || state.open(token, file_path, allowed_root, &owner)).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn preview_media_close(webview: tauri::Webview, token: String, state: tauri::State<'_, MediaState>) -> Result<(), String> {
    let owner = webview.label().to_string(); let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || state.close(&token, &owner)).await.map_err(|e| e.to_string())
}
