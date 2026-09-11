// Trylo Desktop — read_file_bytes Tauri command. v1.16.2.6.
//
// Returns a file as a Vec<u8> so the JS side can build
// image previews via `URL.createObjectURL(new Blob([...]))`
// or Tauri asset protocol. We use number[] (which is what
// Tauri's IPC serialises) rather than a base64 string to
// keep the wire format cheap for large images.
//
// One Tauri command per file per §10.2. This file owns
// `read_file_bytes`.

use crate::commands::error::CommandError;
use std::path::PathBuf;

#[tauri::command]
pub async fn read_file_bytes(path: String) -> Result<Vec<u8>, CommandError> {
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
    std::fs::read(&p).map_err(|e| CommandError::Io { path: p, source: e })
}
