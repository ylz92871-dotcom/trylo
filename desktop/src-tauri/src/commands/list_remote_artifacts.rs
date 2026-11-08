use std::path::Path;
use serde::Serialize;
use crate::commands::{error::CommandError, remote_artifact_policy};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteArtifactFile {
    relative_path: String,
    size: u64,
    modified_ms: u128,
}

#[tauri::command]
pub async fn list_remote_artifacts(workspace_root: String) -> Result<Vec<RemoteArtifactFile>, CommandError> {
    tokio::task::spawn_blocking(move || remote_artifact_policy::list_remote_artifacts(Path::new(&workspace_root)))
        .await.map_err(|_| CommandError::Validation { reason: "Remote output listing could not complete".to_owned() })?
        .map(|files| files.into_iter().map(|file| RemoteArtifactFile {
            relative_path: file.relative_path, size: file.size, modified_ms: file.modified_ms,
        }).collect())
        .map_err(|_| CommandError::Validation { reason: "Remote output directory is unavailable or linked".to_owned() })
}
