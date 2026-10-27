use std::collections::{BTreeMap, HashMap};
use std::io::{ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::error::CommandError;

pub(crate) mod write_lock;
use write_lock::WorkspaceWriteLock;

const FILE_NAME: &str = "runtime-sessions.v1.json";
const LOCK_FILE_NAME: &str = "runtime-sessions.v1.lock";
const MAX_BYTES: usize = 2 * 1024 * 1024;
static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);
type WorkspaceLocks = Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>;

#[derive(Default)]
pub struct RuntimeSessionsState {
    locks: WorkspaceLocks,
}

#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum RuntimeSessionsWrite {
    Written,
    Conflict { current: Option<String> },
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Document {
    #[serde(rename = "schemaVersion")]
    schema_version: u8,
    sessions: BTreeMap<String, Binding>,
}

#[derive(Deserialize)]
#[serde(tag = "state", rename_all = "snake_case", deny_unknown_fields)]
enum Binding {
    Creating {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "runId")]
        run_id: String,
    },
    Established {
        #[serde(rename = "sessionId")]
        session_id: String,
    },
    Unknown {
        #[serde(rename = "sessionId")]
        session_id: String,
        reason: String,
    },
}

fn rejected(reason: &str) -> CommandError {
    CommandError::Validation {
        reason: format!("runtime sessions: {reason}"),
    }
}

fn identity(value: &str, max: usize) -> bool {
    !value.trim().is_empty() && value.len() <= max && !value.contains('\0')
}

fn session_id(value: &str) -> bool {
    value.starts_with("desktop-")
        && value.len() > 8
        && value.len() <= 160
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_.".contains(&byte))
}

fn validate(json: &str) -> Result<(), CommandError> {
    if json.len() > MAX_BYTES {
        return Err(rejected("document too large"));
    }
    let document: Document =
        serde_json::from_str(json).map_err(|_| rejected("invalid document"))?;
    if document.schema_version != 1 {
        return Err(rejected("unsupported schema"));
    }
    for (conversation, binding) in document.sessions {
        if !identity(&conversation, 512) {
            return Err(rejected("invalid conversation id"));
        }
        let valid = match binding {
            Binding::Creating {
                session_id: id,
                run_id,
            } => session_id(&id) && identity(&run_id, 4096),
            Binding::Established { session_id: id } => session_id(&id),
            Binding::Unknown {
                session_id: id,
                reason,
            } => session_id(&id) && identity(&reason, 4096),
        };
        if !valid {
            return Err(rejected("invalid binding"));
        }
    }
    Ok(())
}

fn path_for(root: &Path) -> Result<PathBuf, CommandError> {
    let parent = root.join(".trylo");
    match std::fs::canonicalize(&parent) {
        Ok(actual) if !actual.starts_with(root) => {
            return Err(rejected("parent escapes workspace"))
        }
        Ok(_) => {}
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(source) => {
            return Err(CommandError::Io {
                path: parent,
                source,
            })
        }
    }
    let path = parent.join(FILE_NAME);
    match std::fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            return Err(rejected("metadata is not a regular file"))
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
                    path: path.to_path_buf(),
                    source,
                })?;
            validate(&json)?;
            Ok(Some(json))
        }
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(source) => Err(CommandError::Io {
            path: path.to_path_buf(),
            source,
        }),
    }
}

#[cfg(windows)]
fn replace(temp: &Path, target: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    let from: Vec<u16> = temp.as_os_str().encode_wide().chain(Some(0)).collect();
    let to: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
    // Both buffers are null-terminated and live across the synchronous Win32 call.
    let result = unsafe {
        MoveFileExW(
            from.as_ptr(),
            to.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn replace(temp: &Path, target: &Path) -> std::io::Result<()> {
    std::fs::rename(temp, target)
}

pub(crate) fn atomic_write(path: &Path, json: &str) -> Result<(), CommandError> {
    let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let temp = path.with_extension(format!("json.{}.{sequence}.tmp", std::process::id()));
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)
        .map_err(|source| CommandError::Io {
            path: temp.clone(),
            source,
        })?;
    file.write_all(json.as_bytes())
        .and_then(|()| file.sync_all())
        .map_err(|source| CommandError::Io {
            path: temp.clone(),
            source,
        })?;
    drop(file);
    replace(&temp, path).map_err(|source| CommandError::Io {
        path: path.to_path_buf(),
        source,
    })
}

impl RuntimeSessionsState {
    fn locked<T>(
        &self,
        workspace_root: &str,
        operation: impl FnOnce(&Path) -> Result<T, CommandError>,
    ) -> Result<T, CommandError> {
        let root = std::fs::canonicalize(workspace_root).map_err(|source| CommandError::Io {
            path: PathBuf::from(workspace_root),
            source,
        })?;
        let lock = self
            .locks
            .lock()
            .map_err(|_| rejected("workspace locks poisoned"))?
            .entry(root.clone())
            .or_default()
            .clone();
        let _guard = lock
            .lock()
            .map_err(|_| rejected("workspace lock poisoned"))?;
        operation(&root)
    }

    fn load(&self, workspace_root: &str) -> Result<Option<String>, CommandError> {
        self.locked(workspace_root, |root| read(&path_for(root)?))
    }

    fn save(
        &self,
        workspace_root: &str,
        expected: Option<&str>,
        json: &str,
    ) -> Result<RuntimeSessionsWrite, CommandError> {
        validate(json)?;
        self.locked(workspace_root, |root| {
            path_for(root)?;
            let parent = root.join(".trylo");
            std::fs::create_dir_all(&parent).map_err(|source| CommandError::Io {
                path: parent.clone(),
                source,
            })?;
            path_for(root)?;
            let lock_path = parent.join(LOCK_FILE_NAME);
            let _writer =
                WorkspaceWriteLock::acquire(&lock_path, std::time::Duration::from_secs(2))
                    .map_err(|source| CommandError::Io {
                        path: lock_path,
                        source,
                    })?;
            // The read and CAS belong to the OS-lock lifetime, not merely this
            // App's local mutex. Recheck redirection after waiting for a peer.
            let path = path_for(root)?;
            let current = read(&path)?;
            if current.as_deref() != expected {
                return Ok(RuntimeSessionsWrite::Conflict { current });
            }
            atomic_write(&path, json)?;
            Ok(RuntimeSessionsWrite::Written)
        })
    }
}

#[tauri::command]
pub async fn runtime_sessions_load<R: tauri::Runtime>(
    webview: tauri::Webview<R>,
    workspace_root: String,
    state: State<'_, RuntimeSessionsState>,
) -> Result<Option<String>, CommandError> {
    if webview.label() != "main" {
        return Err(rejected("only the main webview may read associations"));
    }
    state.load(&workspace_root)
}

#[tauri::command]
pub async fn runtime_sessions_save<R: tauri::Runtime>(
    webview: tauri::Webview<R>,
    workspace_root: String,
    expected: Option<String>,
    json: String,
    state: State<'_, RuntimeSessionsState>,
) -> Result<RuntimeSessionsWrite, CommandError> {
    if webview.label() != "main" {
        return Err(rejected("only the main webview may write associations"));
    }
    state.save(&workspace_root, expected.as_deref(), &json)
}

#[cfg(test)]
mod tests;
