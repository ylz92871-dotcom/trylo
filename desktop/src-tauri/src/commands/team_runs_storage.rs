use std::io::{ErrorKind, Read};
use std::path::{Path, PathBuf};
use std::time::Duration;

use super::error::CommandError;
use super::runtime_sessions::{atomic_write, write_lock::WorkspaceWriteLock, RuntimeSessionsWrite};

const MAX_BYTES: usize = 64 * 1024 * 1024;

fn invalid(reason: &str) -> CommandError {
    CommandError::Validation {
        reason: format!("team history: {reason}"),
    }
}
fn validate(json: &str) -> Result<(), CommandError> {
    if json.len() > MAX_BYTES {
        return Err(invalid("history exceeds size limit; original preserved"));
    }
    let value: serde_json::Value =
        serde_json::from_str(json).map_err(|_| invalid("invalid JSON; original preserved"))?;
    if !matches!(
        value
            .get("schemaVersion")
            .and_then(serde_json::Value::as_u64),
        Some(1 | 2)
    ) || !value
        .get("workspaceId")
        .is_some_and(serde_json::Value::is_string)
        || !value.get("runs").is_some_and(serde_json::Value::is_array)
    {
        return Err(invalid("invalid history header; original preserved"));
    }
    Ok(())
}
fn check_parent(root: &Path, parent: &Path) -> Result<(), CommandError> {
    match std::fs::canonicalize(parent) {
        Ok(actual) if !actual.starts_with(root) => Err(invalid("history parent escapes workspace")),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(source) => Err(CommandError::Io {
            path: parent.into(),
            source,
        }),
    }
}
fn path_for(workspace_root: &str, create: bool) -> Result<PathBuf, CommandError> {
    let root = std::fs::canonicalize(workspace_root).map_err(|source| CommandError::Io {
        path: workspace_root.into(),
        source,
    })?;
    let parent = root.join(".trylo");
    check_parent(&root, &parent)?;
    if create {
        std::fs::create_dir_all(&parent).map_err(|source| CommandError::Io {
            path: parent.clone(),
            source,
        })?;
        check_parent(&root, &parent)?;
    }
    let path = parent.join("team-runs.json");
    match std::fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            return Err(invalid("history is not a regular file"))
        }
        Ok(_) => {}
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(source) => return Err(CommandError::Io { path, source }),
    }
    Ok(path)
}
fn read(path: &Path) -> Result<Option<String>, CommandError> {
    match std::fs::File::open(path) {
        Ok(file) => {
            let mut json = String::new();
            file.take((MAX_BYTES + 1) as u64)
                .read_to_string(&mut json)
                .map_err(|source| CommandError::Io {
                    path: path.into(),
                    source,
                })?;
            if json.len() > MAX_BYTES {
                return Err(invalid("history exceeds size limit; original preserved"));
            }
            Ok(Some(json))
        }
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(source) => Err(CommandError::Io {
            path: path.into(),
            source,
        }),
    }
}
fn save(
    root: &str,
    expected: Option<&str>,
    json: &str,
) -> Result<RuntimeSessionsWrite, CommandError> {
    validate(json)?;
    let path = path_for(root, true)?;
    let lock_path = path.with_file_name("team-runs.v1.lock");
    let _guard =
        WorkspaceWriteLock::acquire(&lock_path, Duration::from_secs(2)).map_err(|source| {
            CommandError::Io {
                path: lock_path,
                source,
            }
        })?;
    let path = path_for(root, false)?;
    let current = read(&path)?;
    // Load returns malformed text for the existing frontend corruption hint;
    // save must independently refuse to replace such an original.
    if let Some(raw) = &current {
        validate(raw)?;
    }
    if current.as_deref() != expected {
        return Ok(RuntimeSessionsWrite::Conflict { current });
    }
    atomic_write(&path, json)?;
    Ok(RuntimeSessionsWrite::Written)
}

#[tauri::command]
pub async fn team_runs_load<R: tauri::Runtime>(
    webview: tauri::Webview<R>,
    workspace_root: String,
) -> Result<Option<String>, CommandError> {
    if webview.label() != "main" {
        return Err(invalid("only the main webview may read history"));
    }
    tauri::async_runtime::spawn_blocking(move || read(&path_for(&workspace_root, false)?))
        .await
        .map_err(|error| invalid(&format!("history read worker failed: {error}")))?
}
#[tauri::command]
pub async fn team_runs_save<R: tauri::Runtime>(
    webview: tauri::Webview<R>,
    workspace_root: String,
    expected: Option<String>,
    json: String,
) -> Result<RuntimeSessionsWrite, CommandError> {
    if webview.label() != "main" {
        return Err(invalid("only the main webview may save history"));
    }
    tauri::async_runtime::spawn_blocking(move || save(&workspace_root, expected.as_deref(), &json))
        .await
        .map_err(|error| invalid(&format!("history write worker failed: {error}")))?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stale_owner_cannot_replace_another_writers_history_or_corrupt_original() {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root =
            std::env::temp_dir().join(format!("trylo-team-cas-{}-{nonce}", std::process::id()));
        std::fs::create_dir(&root).unwrap();
        let root_text = root.to_str().unwrap();
        let first = r#"{"schemaVersion":2,"workspaceId":"w","runs":[]}"#;
        let second = r#"{"schemaVersion":2,"workspaceId":"peer-view","runs":[]}"#;
        assert!(matches!(
            save(root_text, None, first).unwrap(),
            RuntimeSessionsWrite::Written
        ));
        assert!(matches!(
            save(root_text, Some(first), second).unwrap(),
            RuntimeSessionsWrite::Written
        ));
        assert!(
            matches!(save(root_text, Some(first), first).unwrap(), RuntimeSessionsWrite::Conflict { current: Some(raw) } if raw == second)
        );
        let path = path_for(root_text, false).unwrap();
        std::fs::write(&path, "original malformed history").unwrap();
        assert_eq!(
            read(&path).unwrap().as_deref(),
            Some("original malformed history")
        );
        assert!(save(root_text, Some("original malformed history"), first).is_err());
        assert_eq!(
            std::fs::read_to_string(path).unwrap(),
            "original malformed history"
        );
        let actual = std::fs::canonicalize(&root).unwrap();
        assert!(actual.starts_with(std::fs::canonicalize(std::env::temp_dir()).unwrap()));
        assert!(actual
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("trylo-team-cas-"));
        std::fs::remove_dir_all(actual).unwrap();
    }
}
