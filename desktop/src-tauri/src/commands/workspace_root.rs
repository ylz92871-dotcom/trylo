use std::io;
use std::path::{Path, PathBuf};

/// Only the fallback for a fresh native profile. Saved project roots win.
pub fn prepare_default_workspace(app_data: &Path) -> io::Result<PathBuf> {
    let workspace = app_data.join("Workspace");
    std::fs::create_dir_all(&workspace)?;
    Ok(workspace)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temporary_root() -> PathBuf {
        std::env::temp_dir().join(format!(
            "trylo-workspace-{}-{}-测试",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    #[test]
    fn fallback_is_writable_and_repeated_startup_preserves_files() {
        let base = temporary_root();
        let first = prepare_default_workspace(&base).unwrap();
        assert_eq!(first.parent(), Some(base.as_path()));
        let marker = first.join("existing.txt");
        std::fs::write(&marker, "preserved").unwrap();
        assert_eq!(prepare_default_workspace(&base).unwrap(), first);
        assert_eq!(std::fs::read_to_string(marker).unwrap(), "preserved");
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn an_invalid_parent_is_an_error_not_a_developer_directory_fallback() {
        let base = temporary_root();
        std::fs::write(&base, "existing file").unwrap();
        assert!(prepare_default_workspace(&base).is_err());
        assert_eq!(std::fs::read_to_string(&base).unwrap(), "existing file");
        std::fs::remove_file(base).unwrap();
    }
}
