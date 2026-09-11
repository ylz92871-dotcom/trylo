// Trylo Desktop — write_file Tauri command. See the architecture doc §2.3
// (Project State as source of truth) + §9 (file system as a service).
//
// One Tauri command per file per §10.2. This file owns `write_file`.
//
// Writes are whole-file. Partial writes (edits inside a buffer) are
// Day 5 work — EditorBridge owns the dirty-buffer + change-conflict
// rules per §2.5.

use crate::commands::error::CommandError;
use std::path::PathBuf;

#[tauri::command]
pub async fn write_file(path: String, content: String) -> Result<(), CommandError> {
    let p = PathBuf::from(&path);
    if let Some(parent) = p.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .map_err(|e| CommandError::Io { path: parent.to_path_buf(), source: e })?;
        }
    }
    std::fs::write(&p, content).map_err(|e| CommandError::Io { path: p, source: e })
}
