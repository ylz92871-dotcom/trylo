//! A conversation's team root keeps an OS lease until its native reaper ends.
//! The persistent rendezvous file is never deleted; app crashes release the OS
//! handle, so a PID/timestamp guess cannot evict a still-running owner.
use std::path::{Path, PathBuf};
use std::time::Duration;

use sha2::{Digest, Sha256};

use super::error::CommandError;
use super::runtime_sessions::write_lock::WorkspaceWriteLock;

fn invalid(reason: &str) -> CommandError {
    CommandError::Validation {
        reason: format!("team owner: {reason}"),
    }
}

fn directory(root: &Path, path: &Path) -> Result<PathBuf, CommandError> {
    match std::fs::canonicalize(path) {
        Ok(actual) if !actual.starts_with(root) => {
            return Err(invalid("owner directory escapes workspace"))
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(source) => {
            return Err(CommandError::Io {
                path: path.into(),
                source,
            })
        }
    }
    std::fs::create_dir_all(path).map_err(|source| CommandError::Io {
        path: path.into(),
        source,
    })?;
    let actual = std::fs::canonicalize(path).map_err(|source| CommandError::Io {
        path: path.into(),
        source,
    })?;
    if !actual.starts_with(root) {
        return Err(invalid("owner directory escapes workspace"));
    }
    Ok(actual)
}

/// None is a real OS contention result, never an unavailable/read-failure guess.
pub(crate) fn try_acquire(
    workspace_root: &str,
    conversation_id: &str,
) -> Result<Option<WorkspaceWriteLock>, CommandError> {
    if conversation_id.trim().is_empty()
        || conversation_id.len() > 512
        || conversation_id.contains('\0')
    {
        return Err(invalid("invalid conversation identity"));
    }
    let root = std::fs::canonicalize(workspace_root).map_err(|source| CommandError::Io {
        path: workspace_root.into(),
        source,
    })?;
    let parent = directory(&root, &root.join(".trylo"))?;
    let owners = directory(&root, &parent.join("team-owners"))?;
    let identity = format!("{:x}", Sha256::digest(conversation_id.as_bytes()));
    let path = owners.join(format!("{identity}.lock"));
    match WorkspaceWriteLock::acquire(&path, Duration::ZERO) {
        Ok(guard) => Ok(Some(guard)),
        Err(error) if error.kind() == std::io::ErrorKind::TimedOut => Ok(None),
        Err(source) => Err(CommandError::Io { path, source }),
    }
}

pub(crate) fn acquire(
    workspace_root: &str,
    conversation_id: &str,
) -> Result<WorkspaceWriteLock, CommandError> {
    try_acquire(workspace_root, conversation_id)?.ok_or_else(|| {
        invalid("此会话已有团队执行占用，可能位于另一个 Trylo 窗口。请在原窗口停止或等待完成。")
    })
}

#[tauri::command]
pub fn process_team_owner_status(
    workspace_root: &str,
    conversation_id: &str,
) -> Result<bool, CommandError> {
    Ok(try_acquire(workspace_root, conversation_id)?.is_none())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn independent_owners_contend_only_for_the_same_workspace_and_conversation() {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root =
            std::env::temp_dir().join(format!("trylo-team-owner-{}-{nonce}", std::process::id()));
        std::fs::create_dir(&root).unwrap();
        let root_text = root.to_str().unwrap();
        let first = acquire(root_text, "same-chat").unwrap();
        assert!(process_team_owner_status(root_text, "same-chat").unwrap());
        assert!(try_acquire(root_text, "same-chat").unwrap().is_none());
        let other = acquire(root_text, "different-chat").unwrap();
        let other_workspace = root.join("other-workspace");
        std::fs::create_dir(&other_workspace).unwrap();
        let other_root = acquire(other_workspace.to_str().unwrap(), "same-chat").unwrap();
        drop(first);
        assert!(!process_team_owner_status(root_text, "same-chat").unwrap());
        drop(other);
        drop(other_root);
        // Persistent rendezvous files are left until the isolated fixture ends.
        let actual = std::fs::canonicalize(&root).unwrap();
        assert!(actual.starts_with(std::fs::canonicalize(std::env::temp_dir()).unwrap()));
        assert!(actual
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("trylo-team-owner-"));
        std::fs::remove_dir_all(actual).unwrap();
    }
}
