// Trylo Desktop — git_file_diff Tauri command (P2-1, spec §7.7).
//
// Fixed semantics: HEAD -> current worktree for ONE repo-relative path.
//   - tracked modified: HEAD blob vs disk content
//   - staged + unstaged: the combined HEAD -> worktree is shown
//   - untracked: empty vs disk content
//   - deleted: HEAD blob vs empty
//   - renamed: oldPath HEAD blob vs newPath disk content
// Never loads the diff body into the WebView when either side is a
// > 2 MiB file or is detected as binary — those return a `truncated` /
// `binary` marker instead (spec §7.7).

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

use crate::commands::error::CommandError;

use super::git_snapshot::resolve_repo_relative;

/// Diff body size cap per side (spec §7.7 / §14).
const MAX_DIFF_BYTES: u64 = 2 * 1024 * 1024;
/// Bytes scanned for a NUL to classify a file as binary.
const BINARY_PROBE: usize = 8000;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileDiff {
    pub path: String,
    pub old_path: Option<String>,
    pub original: String,
    pub modified: String,
    pub binary: bool,
    pub truncated: bool,
    pub language_hint: Option<String>,
}

fn is_binary(bytes: &[u8]) -> bool {
    let mut probe = bytes.iter().take(BINARY_PROBE);
    probe.any(|b| *b == 0)
}

/// Read the HEAD blob of `rel` from git. Returns `None` when git fails
/// (path not in HEAD / unborn HEAD) WITHOUT surfacing a stack — the caller
/// interprets None as "no original content".
fn read_head_blob(root: &Path, rel: &str) -> Option<Vec<u8>> {
    let spec = format!("HEAD:{rel}");
    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .arg("show")
        .arg(spec.as_str())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    Some(output.stdout)
}

#[tauri::command]
pub async fn git_file_diff(
    root: String,
    path: String,
    old_path: Option<String>,
) -> Result<GitFileDiff, CommandError> {
    let root_path = PathBuf::from(&root);
    if !root_path.is_dir() {
        return Err(CommandError::NotADirectory { path: root_path });
    }
    let joined = resolve_repo_relative(&root_path, &path).ok_or_else(|| CommandError::Io {
        path: PathBuf::from(&root),
        source: std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "diff path must be repo-relative",
        ),
    })?;

    // Rename / copy: the ORIGINAL (left) side is the rename SOURCE's HEAD
    // blob; `path` is the CURRENT (right, disk) side. The old path is only
    // fed to `git show` as the HEAD spec — it never touches the disk — but we
    // still guard it as repo-relative so a hostile caller cannot smuggle a
    // traversal into the git spec.
    if let Some(op) = &old_path {
        resolve_repo_relative(&root_path, op).ok_or_else(|| CommandError::Io {
            path: PathBuf::from(&root),
            source: std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "old_path must be repo-relative",
            ),
        })?;
    }
    let head_spec_rel: &str = old_path.as_deref().unwrap_or(&path);

    // Size cap on the worktree side first so we never stream a huge body.
    let worktree_size = std::fs::symlink_metadata(&joined)
        .ok()
        .and_then(|m| (!m.is_dir()).then_some(m.len()));

    // Determine the HEAD side size by asking git for the blob and by checking
    // file size. We fetch the HEAD blob lazily only if both sides are small.
    let head_blob = if worktree_size.map_or(true, |s| s <= MAX_DIFF_BYTES) {
        read_head_blob(&root_path, head_spec_rel)
    } else {
        None
    };

    let original = match &head_blob {
        Some(bytes) if bytes.len() as u64 <= MAX_DIFF_BYTES && !is_binary(bytes) => {
            String::from_utf8_lossy(bytes).to_string()
        }
        Some(bytes) => {
            // Matches binary or oversized HEAD side; handled below.
            return Ok(GitFileDiff {
                path,
                old_path: old_path.clone(),
                original: String::new(),
                modified: String::new(),
                binary: bytes.contains(&0),
                truncated: bytes.len() as u64 > MAX_DIFF_BYTES,
                language_hint: None,
            });
        }
        None => String::new(),
    };

    // Modified side (current disk content), capped.
    let (modified, worktree_binary, worktree_truncated) = match worktree_size {
        Some(size) if size <= MAX_DIFF_BYTES => match std::fs::read(&joined) {
            Ok(bytes) => {
                if is_binary(&bytes) {
                    (String::new(), true, false)
                } else {
                    (String::from_utf8_lossy(&bytes).to_string(), false, false)
                }
            }
            Err(_) => (String::new(), false, true),
        },
        Some(_) => (String::new(), false, true),
        // Missing on disk = deleted.
        None => (String::new(), false, false),
    };

    let original_len = original.len() as u64;
    let truncated = worktree_truncated || original_len > MAX_DIFF_BYTES;
    let binary = worktree_binary || head_blob.as_deref().is_some_and(is_binary);

    Ok(GitFileDiff {
        path,
        old_path,
        original,
        modified,
        binary,
        truncated,
        language_hint: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn binary_detection() {
        assert!(!is_binary(b"plain text file\nno nul byte\n"));
        assert!(is_binary(b"some\x00binary"));
    }

    #[test]
    fn resolve_guards_path() {
        let root = Path::new("/tmp/repo");
        assert!(resolve_repo_relative(root, "a.rs").is_some());
        assert!(resolve_repo_relative(root, "../etc/passwd").is_none());
        assert!(resolve_repo_relative(root, "a/../../b.rs").is_none());
    }

    #[test]
    fn read_head_blob_none_when_unborn() {
        // A path that definitely does not resolve in git should not panic and
        // should yield None when git is unavailable or HEAD is unborn. We only
        // assert the None-vs-error contract loosely because git may not exist
        // in the test environment.
        let root = Path::new("/nonexistent-repo-root");
        let result = read_head_blob(root, "does-not-exist.rs");
        // Either None (git error / no repo) — never a panic, and never a
        // spurious Some. This guards the "no HEAD / no original" degradation.
        assert!(result.is_none());
    }
}
