//! Stable IPC entry; native implementations are selected at compilation.
#[tauri::command]
pub async fn pick_folder() -> Result<Option<String>, String> {
    crate::platform::pick_folder::pick_folder().await
}
