// Trylo Desktop — write_file_bytes Tauri command. v1.16.x.
//
// Writes raw bytes to a file. Used by the remote (mobile) attachment pipeline:
// the phone sends an image as a base64 data URL, the renderer decodes it, and
// hands the bytes here so the host can materialise a real file the agent can
// read like any other local file (via its FileRead tool).
//
// One Tauri command per file per §10.2. This file owns `write_file_bytes`.

use crate::commands::error::CommandError;
use std::path::PathBuf;

#[tauri::command]
pub async fn write_file_bytes(path: String, bytes: Vec<u8>) -> Result<(), CommandError> {
    let p = PathBuf::from(&path);
    if let Some(parent) = p.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .map_err(|e| CommandError::Io { path: parent.to_path_buf(), source: e })?;
        }
    }
    std::fs::write(&p, bytes).map_err(|e| CommandError::Io { path: p, source: e })
}
