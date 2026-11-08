use std::path::Path;
use crate::commands::{error::CommandError, remote_artifact_policy};

#[tauri::command]
pub async fn read_remote_artifact(workspace_root: String, relative_path: String) -> Result<Vec<u8>, CommandError> {
    tokio::task::spawn_blocking(move || remote_artifact_policy::read_remote_artifact(Path::new(&workspace_root), &relative_path))
        .await.map_err(|_| CommandError::Validation { reason: "Remote file read could not complete".to_owned() })?
        .map_err(|_| CommandError::Validation { reason: "Remote file is unavailable, outside .trylo/out, linked, or larger than 12 MiB".to_owned() })
}
