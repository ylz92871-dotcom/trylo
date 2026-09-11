use std::path::{Path, PathBuf};

use crate::commands::error::{io_error, CommandError};

const HISTORY_FILE: &str = ".trylo/conversations.v1.json";

fn history_path(workspace_root: &str) -> PathBuf {
    Path::new(workspace_root).join(HISTORY_FILE)
}

#[tauri::command]
pub async fn conversation_history_load(
    workspace_root: String,
) -> Result<Option<String>, CommandError> {
    let path = history_path(&workspace_root);
    if !path.exists() {
        return Ok(None);
    }
    let path_label = path.to_string_lossy().into_owned();
    std::fs::read_to_string(&path)
        .map(Some)
        .map_err(|error| io_error(&path_label, error))
}

#[tauri::command]
pub async fn conversation_history_save(
    workspace_root: String,
    json: String,
) -> Result<(), CommandError> {
    // Parse before touching disk so malformed renderer data can
    // never replace the last valid history file.
    serde_json::from_str::<serde_json::Value>(&json).map_err(|error| {
        io_error(
            "(conversation history)",
            std::io::Error::new(std::io::ErrorKind::InvalidInput, error.to_string()),
        )
    })?;

    let path = history_path(&workspace_root);
    let parent = path.parent().ok_or_else(|| {
        io_error(
            "(conversation history)",
            std::io::Error::other("invalid history path"),
        )
    })?;
    let parent_label = parent.to_string_lossy().into_owned();
    std::fs::create_dir_all(parent).map_err(|error| io_error(&parent_label, error))?;

    // Write-then-rename avoids leaving a half-written history when
    // the app or machine exits during serialization.
    let temp = path.with_extension("json.tmp");
    let temp_label = temp.to_string_lossy().into_owned();
    let path_label = path.to_string_lossy().into_owned();
    std::fs::write(&temp, json).map_err(|error| io_error(&temp_label, error))?;
    let backup = path.with_extension("json.bak");
    if backup.exists() {
        std::fs::remove_file(&backup).map_err(|error| io_error(&path_label, error))?;
    }
    if path.exists() {
        std::fs::rename(&path, &backup).map_err(|error| io_error(&path_label, error))?;
    }
    match std::fs::rename(&temp, &path) {
        Ok(()) => {
            if backup.exists() {
                let _ = std::fs::remove_file(backup);
            }
            Ok(())
        }
        Err(error) => {
            if backup.exists() {
                let _ = std::fs::rename(&backup, &path);
            }
            Err(io_error(&path_label, error))
        }
    }
}
