//! Materialize clipboard bytes as stable conversation attachments.
use super::attachment_staging::{
    ensure_git_exclusion, sanitize_basename, size_limit_for, validate_segment, StagedAttachment,
};
use super::error::CommandError;
use std::io::Write;
use std::path::{Path, PathBuf};

fn validation(reason: &str) -> CommandError {
    CommandError::Validation {
        reason: reason.to_owned(),
    }
}

fn io_error(path: &Path, source: std::io::Error) -> CommandError {
    CommandError::Io {
        path: path.to_path_buf(),
        source,
    }
}

fn stage_bytes(
    workspace_root: &str,
    conversation_id: &str,
    attachment_id: &str,
    name: &str,
    bytes: &[u8],
) -> Result<StagedAttachment, CommandError> {
    validate_segment(conversation_id, "conversation_id")?;
    validate_segment(attachment_id, "attachment_id")?;
    let name = sanitize_basename(name);
    if bytes.len() as u64 > size_limit_for(Path::new(&name)) {
        return Err(validation("clipboard file too large"));
    }
    let root = Path::new(workspace_root);
    let anchor = std::fs::canonicalize(root).map_err(|e| io_error(root, e))?;
    // Check each parent before writing: an existing .trylo junction must not
    // redirect a clipboard write outside the selected project.
    let mut parent = anchor.clone();
    for segment in [".trylo", "attachments", conversation_id, attachment_id] {
        parent.push(segment);
        match std::fs::create_dir(&parent) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(io_error(&parent, e)),
        }
        let metadata = std::fs::symlink_metadata(&parent).map_err(|e| io_error(&parent, e))?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(validation("attachment parent must be a plain directory"));
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if metadata.file_attributes() & 0x400 != 0 {
                return Err(validation("attachment parent cannot be a reparse point"));
            }
        }
        let canonical = std::fs::canonicalize(&parent).map_err(|e| io_error(&parent, e))?;
        if !canonical.starts_with(&anchor) {
            return Err(validation("attachment parent escaped the workspace"));
        }
    }
    let target = parent.join(&name);
    // Exclusive creation rejects existing files and symlinks and preserves
    // earlier attachments with the same display name.
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&target)
        .map_err(|e| io_error(&target, e))?;
    if let Err(error) = file.write_all(bytes) {
        drop(file);
        let _ = std::fs::remove_file(&target);
        return Err(io_error(&target, error));
    }
    drop(file);
    ensure_git_exclusion(&anchor);
    Ok(StagedAttachment {
        relative_path: format!(".trylo/attachments/{conversation_id}/{attachment_id}/{name}"),
        name,
        size: bytes.len() as u64,
    })
}

#[tauri::command]
pub async fn stage_attachment_bytes(
    workspace_root: String,
    conversation_id: String,
    attachment_id: String,
    name: String,
    bytes: Vec<u8>,
) -> Result<StagedAttachment, CommandError> {
    let error_path = PathBuf::from(&workspace_root);
    tokio::task::spawn_blocking(move || {
        stage_bytes(
            &workspace_root,
            &conversation_id,
            &attachment_id,
            &name,
            &bytes,
        )
    })
    .await
    .map_err(|e| io_error(&error_path, std::io::Error::other(e.to_string())))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clipboard_bytes_survive_and_cannot_overwrite_or_escape() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../_workspace/tmp/desktop-clipboard")
            .join(format!("bytes-{}", std::process::id()));
        std::fs::create_dir_all(&root).expect("scratch");
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let id = format!("att-{nonce}");
        let staged = stage_bytes(
            root.to_str().expect("path"),
            "conv",
            &id,
            "微信图片.png",
            b"image bytes",
        )
        .expect("stage bytes");
        let target = root.join(&staged.relative_path);
        assert_eq!(std::fs::read(&target).expect("read"), b"image bytes");
        assert!(stage_bytes(
            root.to_str().expect("path"),
            "conv",
            &id,
            "微信图片.png",
            b"replace"
        )
        .is_err());
        assert!(stage_bytes(
            root.to_str().expect("path"),
            "../escape",
            &id,
            "a.png",
            b"x"
        )
        .is_err());
        assert!(stage_bytes(
            root.to_str().expect("path"),
            "conv",
            &id,
            "large.png",
            &vec![0; 10 * 1024 * 1024 + 1]
        )
        .is_err());
        assert!(root.join(".trylo/attachments/.gitignore").is_file());
        std::fs::remove_dir_all(root).expect("cleanup scratch");
    }
}
