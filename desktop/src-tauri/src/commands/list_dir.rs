// Trylo Desktop — list_dir Tauri command. See the architecture doc §2.6
// (WorkspaceWatcher) + §9 (file system as a service).
//
// One Tauri command per file per §10.2. This file owns `list_dir`.
//
// Phase 1.0 workaround: returns a `String` (JSON-encoded array of
// DirEntry) instead of `Vec<DirEntry>` directly. Tauri 2's IPC
// codec was hanging on the `Vec<struct>` return in our webview
// build (read_file / stat_file with simple returns worked, but
// list_dir with a multi-field struct never resolved). String +
// JSON.parse on the JS side bypasses the codec entirely.

use crate::commands::error::CommandError;
use serde::Serialize;
use std::path::Path;

#[derive(Debug, Serialize)]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_directory: bool,
}

#[tauri::command]
pub async fn list_dir(path: String) -> Result<String, CommandError> {
    let p = Path::new(&path);
    if !p.exists() {
        return Err(CommandError::Io {
            path: p.to_path_buf(),
            source: std::io::Error::new(std::io::ErrorKind::NotFound, "directory not found"),
        });
    }
    if !p.is_dir() {
        return Err(CommandError::NotADirectory {
            path: p.to_path_buf(),
        });
    }
    let read = std::fs::read_dir(p).map_err(|e| CommandError::Io {
        path: p.to_path_buf(),
        source: e,
    })?;
    let mut out: Vec<DirEntry> = Vec::new();
    for entry in read {
        let Ok(entry) = entry else { continue };
        let ft = entry.file_type();
        let is_directory = ft.is_ok_and(|t| t.is_dir());
        out.push(DirEntry {
            name: entry.file_name().to_string_lossy().to_string(),
            path: entry.path().to_string_lossy().to_string(),
            is_directory,
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    // Serialize to JSON manually so the IPC payload is a plain
    // string. The JS side `JSON.parse`s it.
    let json = serde_json::to_string(&out).map_err(|e| CommandError::Io {
        path: p.to_path_buf(),
        source: std::io::Error::other(e.to_string()),
    })?;
    Ok(json)
}
