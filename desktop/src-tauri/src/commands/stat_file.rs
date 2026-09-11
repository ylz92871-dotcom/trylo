// Trylo Desktop — stat_file Tauri command. See the architecture doc §2.6
// (WorkspaceWatcher) + §9 (file system as a service).
//
// One Tauri command per file per §10.2. This file owns `stat_file`.
// Returns the JS `FileStat` shape (see host-adapter/types.ts).
//
// Uses `symlink_metadata` so the `is_symlink` field is honest: a symlink
// is reported as a symlink (not as a regular file, not as a directory).
// `metadata()` follows symlinks and would silently misclassify the entry;
// the scanner (work-artifact-scanner) relies on this distinction to
// reject symlinks before they can become artifacts.

use crate::commands::error::CommandError;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStat {
    pub path: String,
    pub size: u64,
    /// Unix-epoch milliseconds. Matches JS `number` (safe until year 287396).
    pub modified_ms: u128,
    pub is_directory: bool,
    pub is_file: bool,
    /// True when the entry is a symbolic link / Windows reparse point.
    /// `is_file` and `is_directory` are both false in that case.
    pub is_symlink: bool,
}

fn modified_ms(mtime: std::io::Result<SystemTime>) -> u128 {
    mtime
        .ok()
        .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis())
}

#[tauri::command]
pub async fn stat_file(path: String) -> Result<FileStat, CommandError> {
    let p: &Path = Path::new(&path);
    let lmeta = match std::fs::symlink_metadata(p) {
        Ok(m) => m,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return Err(CommandError::Io {
                path: PathBuf::from(&path),
                source: std::io::Error::new(std::io::ErrorKind::NotFound, "file not found"),
            });
        }
        Err(err) => {
            return Err(CommandError::Io {
                path: PathBuf::from(&path),
                source: err,
            });
        }
    };
    let is_symlink = lmeta.file_type().is_symlink();
    Ok(FileStat {
        path: path.clone(),
        size: lmeta.len(),
        modified_ms: modified_ms(lmeta.modified()),
        is_directory: lmeta.is_dir(),
        is_file: lmeta.is_file(),
        is_symlink,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tempdir(name: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("trylo-stat-file-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[tokio::test]
    async fn regular_file_reports_is_file_true() {
        let root = tempdir("regular");
        let f = root.join("plain.txt");
        fs::write(&f, "x").unwrap();
        let stat = stat_file(f.to_string_lossy().to_string()).await.unwrap();
        assert!(stat.is_file);
        assert!(!stat.is_directory);
        assert!(!stat.is_symlink);
        fs::remove_dir_all(&root).unwrap();
    }

    #[tokio::test]
    async fn directory_reports_is_directory_true() {
        let root = tempdir("dir");
        let stat = stat_file(root.to_string_lossy().to_string()).await.unwrap();
        assert!(stat.is_directory);
        assert!(!stat.is_file);
        assert!(!stat.is_symlink);
        fs::remove_dir_all(&root).unwrap();
    }

    /// File symlink: must be reported as a symlink with both
    /// `is_file=false` and `is_directory=false`. Skip on Windows when
    /// symlink creation needs Developer Mode.
    #[tokio::test]
    async fn file_symlink_reports_is_symlink_true() {
        let root = tempdir("symlink");
        let real = tempdir("symlink-real");
        fs::write(real.join("target.txt"), "secret").unwrap();
        let link = root.join("link.txt");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&real.join("target.txt"), &link).unwrap();
        #[cfg(windows)]
        {
            use std::os::windows::fs::symlink_file;
            if let Err(e) = symlink_file(real.join("target.txt"), &link) {
                eprintln!("skip file-symlink stat test: cannot create file symlink ({e})");
                fs::remove_dir_all(&root).unwrap();
                fs::remove_dir_all(&real).unwrap();
                return;
            }
        }
        let stat = stat_file(link.to_string_lossy().to_string()).await.unwrap();
        assert!(stat.is_symlink, "file symlink must set is_symlink");
        assert!(!stat.is_file, "file symlink must not be is_file");
        assert!(!stat.is_directory, "file symlink must not be is_directory");
        fs::remove_dir_all(&root).unwrap();
        fs::remove_dir_all(&real).unwrap();
    }

    #[tokio::test]
    async fn missing_file_returns_not_found() {
        let path = std::env::temp_dir()
            .join(format!("trylo-stat-missing-{}.txt", std::process::id()))
            .to_string_lossy()
            .to_string();
        let err = stat_file(path).await.unwrap_err();
        // Just exercising the not-found path. CommandError is opaque to
        // tests, so the only behavioural promise is "stat_file did not
        // succeed for a non-existent path".
        let _ = err;
    }
}
