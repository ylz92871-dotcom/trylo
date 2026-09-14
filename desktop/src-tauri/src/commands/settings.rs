// Trylo Desktop — settings Tauri commands. See ARCHITECTURE.md
// §3 Phase 1 #8 (Settings UI).
//
// The user's settings live in a single JSON file at
// `<workspaceRoot>/.trylo/settings.json`. Reads are forgiving
// (a missing or malformed file returns the defaults). Writes
// are atomic-ish: we write the file directly. Concurrent
// writes are not handled — the spike's user count is 1.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::error::{io_error, CommandError};

pub mod path {
    /// Where the settings file lives, relative to the
    /// workspace root. Single source of truth; keep this
    /// in sync with the TS side (.trylo/settings.json).
    pub const SETTINGS_FILE: &str = ".trylo/settings.json";
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
#[derive(Default)]
pub enum Theme {
    #[default]
    Auto,
    Light,
    Dark,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub theme: Theme,
    pub font_size: u32,
    pub tab_size: u32,
    pub word_wrap: bool,
    pub show_line_numbers: bool,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            theme: Theme::Auto,
            font_size: 13,
            tab_size: 4,
            word_wrap: false,
            show_line_numbers: true,
        }
    }
}

#[derive(Default)]
pub struct SettingsState {
    /// Last-written settings per workspace. Used as a write-through
    /// cache so we don't read the file on every `get_settings`
    /// call. The spike doesn't need this but it's small and
    /// helpful for hot-reload.
    pub cache: std::sync::Mutex<std::collections::HashMap<String, AppSettings>>,
}

/// Read the settings file at `<workspace>/.trylo/settings.json`.
/// Returns the defaults if the file is missing, malformed, or
/// the .trylo directory doesn't exist yet.
#[tauri::command]
pub async fn get_settings(workspace_root: String) -> Result<String, CommandError> {
    let settings = read_settings(&PathBuf::from(&workspace_root));
    // Return as a JSON string. Returning the struct directly
    // would also work; the JSON-string round-trip avoids the
    // Tauri 2 IPC codec hang on custom struct returns that
    // bit us on Day 1 of the spike (see lsp_list.rs for the
    // same pattern).
    serde_json::to_string(&settings).map_err(|e| io_error("(settings)", std::io::Error::other(e)))
}

/// Persist the settings JSON. Caller writes the full
/// (camelCase) shape; we deserialize + write atomically.
#[tauri::command]
pub async fn set_settings(
    workspace_root: String,
    json: String,
    state: State<'_, SettingsState>,
) -> Result<(), CommandError> {
    let settings: AppSettings = serde_json::from_str(&json).map_err(|e| {
        io_error(
            "(settings)",
            std::io::Error::new(std::io::ErrorKind::InvalidInput, e.to_string()),
        )
    })?;
    let p = std::path::Path::new(&workspace_root).join(path::SETTINGS_FILE);
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| io_error("(settings)", e))?;
    }
    let body = serde_json::to_string_pretty(&settings)
        .map_err(|e| io_error("(settings)", std::io::Error::other(e)))?;
    std::fs::write(&p, body).map_err(|e| io_error("(settings)", e))?;
    state
        .cache
        .lock()
        .map_err(|_| {
            io_error(
                "(settings)",
                std::io::Error::other("settings cache poisoned".to_string()),
            )
        })?
        .insert(workspace_root, settings);
    Ok(())
}

fn read_settings(workspace_root: &std::path::Path) -> AppSettings {
    let p = workspace_root.join(path::SETTINGS_FILE);
    let Ok(body) = std::fs::read_to_string(&p) else {
        return AppSettings::default();
    };
    serde_json::from_str(&body).unwrap_or_default()
}
