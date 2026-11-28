//! Thin IPC adapter for the independently owned preview engine service.
pub use crate::preview::office::{shutdown_office_previews, OfficePreviewState};

#[tauri::command]
pub async fn preview_office(
    file_path: String,
    allowed_root: String,
    job_id: Option<String>,
    state: tauri::State<'_, OfficePreviewState>,
) -> Result<tauri::ipc::Response, String> {
    crate::preview::office::render_office(file_path, allowed_root, job_id, &state)
        .await.map(tauri::ipc::Response::new)
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)] // Owned values from Tauri IPC.
pub fn preview_office_cancel(job_id: String, state: tauri::State<'_, OfficePreviewState>) -> Result<bool, String> {
    state.cancel(&job_id)
}
