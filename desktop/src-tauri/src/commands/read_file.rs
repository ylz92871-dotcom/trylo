// Trylo Desktop — read_file Tauri command. See the architecture doc §2.3
// (Project State as source of truth) + §9 (file system as a service).
//
// One Tauri command per file per §10.2. This file owns `read_file`.

use crate::commands::error::CommandError;
use std::path::PathBuf;

#[tauri::command]
pub async fn read_file(path: String) -> Result<String, CommandError> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err(CommandError::Io {
            path: p,
            source: std::io::Error::new(std::io::ErrorKind::NotFound, "file not found"),
        });
    }
    if !p.is_file() {
        return Err(CommandError::NotAFile { path: p });
    }
    std::fs::read_to_string(&p).map_err(|e| CommandError::Io { path: p, source: e })
}
