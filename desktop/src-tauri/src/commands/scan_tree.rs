// Trylo Desktop — scan_tree Tauri command (P2-1, spec §8.4).
//
// A bounded recursive directory scan that returns a typed `Vec<FileStat>` in
// ONE IPC round-trip instead of hundreds of per-file WebView calls. This is a
// generic filesystem service — it carries no Work/artifact business semantic.
// The Work scanner (desktop/src/results/work-artifact-scanner.ts) restricts
// the result to `.trylo/out` and converts each entry into an artifact target.
//
// Hard limits are applied on the host: maxFiles / maxDepth are clamped to
// fixed ceilings so a caller can never ask the host to walk the whole disk.
// The scan uses `symlink_metadata` and never follows symlinks / directory
// junctions. A missing root is an EMPTY scan, not a task failure (spec §8.4);
// per-entry metadata failures degrade to a bounded warning list and are skipped
// rather than failing the whole scan.

use std::path::PathBuf;
use std::time::SystemTime;

use serde::Serialize;

use crate::commands::error::CommandError;

/// Hard ceilings the caller's maxFiles / maxDepth are clamped to (spec §8.4:
/// "受 maxFiles / maxDepth 硬上限约束").
const HARD_MAX_FILES: usize = 10_000;
const HARD_MAX_DEPTH: usize = 32;
/// Bounded warning list so one pathological tree cannot balloon the payload.
const WARNING_LIMIT: usize = 32;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStat {
    pub path: String,
    pub size: u64,
    /// Unix-epoch milliseconds. Matches JS `number` (safe until year 287396).
    pub modified_ms: u128,
    pub is_directory: bool,
    pub is_file: bool,
    /// True when the entry is a symbolic link (including Windows reparse
    /// points that surface as symlinks via `symlink_metadata`). The walk
    /// never follows the link; consumers must treat `is_symlink` as
    /// "not a regular file" regardless of what the target is.
    pub is_symlink: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanTreeResult {
    pub files: Vec<FileStat>,
    pub truncated: bool,
    pub warnings: Vec<String>,
}

fn modified_ms(mtime: std::io::Result<SystemTime>) -> u128 {
    mtime
        .ok()
        .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis())
}

/// Pure, testable walk. Scans `root` depth-first up to `max_files` files and
/// `max_depth` directory depth. Uses `symlink_metadata` so a symlink is listed
/// as a file entry but never descended into.
pub fn scan_tree_files(
    root: &std::path::Path,
    max_files: usize,
    max_depth: usize,
) -> ScanTreeResult {
    // Local items first (clippy items_after_statements): the scalar-typed
    // recursion + warning helpers keep the walk testable without exposing the
    // recursive detail. Every nested call passes the same &mut state through.
    fn warn(warnings: &mut Vec<String>, path: &std::path::Path, msg: &str) {
        if warnings.len() < WARNING_LIMIT {
            warnings.push(format!("{}: {}", path.display(), msg));
        }
    }

    // Returns false when the caller should stop the whole walk (cap reached).
    fn walk(
        dir: &std::path::Path,
        depth: usize,
        max_depth: usize,
        max_files: usize,
        files: &mut Vec<FileStat>,
        warnings: &mut Vec<String>,
        truncated: &mut bool,
    ) -> bool {
        if depth > max_depth {
            return true; // deeper levels are simply not scanned
        }
        let read_dir = match std::fs::read_dir(dir) {
            Ok(rd) => rd,
            Err(err) => {
                warn(warnings, dir, &format!("read_dir failed: {err}"));
                return true;
            }
        };
        for entry in read_dir {
            if files.len() >= max_files {
                *truncated = true;
                return false;
            }
            let entry = match entry {
                Ok(e) => e,
                Err(err) => {
                    warn(warnings, dir, &format!("entry failed: {err}"));
                    continue;
                }
            };
            let path = entry.path();
            // symlink_metadata does NOT follow symlinks / junctions.
            let meta = std::fs::symlink_metadata(&path);
            match meta {
                Ok(m) if m.is_dir() => {
                    if !walk(
                        &path,
                        depth + 1,
                        max_depth,
                        max_files,
                        files,
                        warnings,
                        truncated,
                    ) {
                        return false;
                    }
                }
                Ok(m) => {
                    files.push(FileStat {
                        path: path.to_string_lossy().to_string(),
                        size: m.len(),
                        modified_ms: modified_ms(m.modified()),
                        is_directory: m.is_dir(),
                        is_file: m.is_file(),
                        is_symlink: m.file_type().is_symlink(),
                    });
                }
                Err(err) => {
                    warn(warnings, &path, &format!("metadata failed: {err}"));
                }
            }
        }
        true
    }

    let mut files: Vec<FileStat> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();
    let mut truncated = false;

    if !root.is_dir() {
        // Missing root = empty scan, not a failure (spec §8.4).
        return ScanTreeResult {
            files,
            truncated,
            warnings,
        };
    }

    walk(
        root,
        0,
        max_depth,
        max_files,
        &mut files,
        &mut warnings,
        &mut truncated,
    );
    ScanTreeResult {
        files,
        truncated,
        warnings,
    }
}

#[tauri::command]
pub async fn scan_tree(
    root: String,
    max_files: Option<usize>,
    max_depth: Option<usize>,
) -> Result<ScanTreeResult, CommandError> {
    let p = PathBuf::from(&root);
    // Missing / non-directory root is an empty scan (spec §8.4), not an error.
    if !p.is_dir() {
        return Ok(ScanTreeResult {
            files: Vec::new(),
            truncated: false,
            warnings: Vec::new(),
        });
    }
    let files = max_files.unwrap_or(1000).min(HARD_MAX_FILES);
    let depth = max_depth.unwrap_or(12).min(HARD_MAX_DEPTH);
    Ok(scan_tree_files(&p, files, depth))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::Path;

    fn tempdir(name: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("trylo-scan-tree-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn missing_root_is_empty_scan_not_error() {
        let result = scan_tree_files(Path::new("/does/not/exist"), 1000, 12);
        assert!(result.files.is_empty());
        assert!(!result.truncated);
    }

    #[test]
    fn scans_nested_files_recursively() {
        let root = tempdir("nested");
        fs::create_dir_all(root.join("a/b")).unwrap();
        fs::write(root.join("a/one.txt"), "1").unwrap();
        fs::write(root.join("a/b/two.md"), "22").unwrap();
        fs::write(root.join("root.txt"), "333").unwrap();

        let result = scan_tree_files(&root, 1000, 12);
        let paths: Vec<String> = result.files.iter().map(|f| f.path.clone()).collect();
        assert_eq!(paths.len(), 3);
        // Every path normalised to `/` separators so the assertion is
        // Windows/casing portable.
        let norm: Vec<String> = paths.iter().map(|p| p.replace('\\', "/")).collect();
        assert!(norm
            .iter()
            .all(|p| p.ends_with("one.txt") || p.ends_with("two.md") || p.ends_with("root.txt")));
        assert!(norm.iter().any(|p| p.ends_with("two.md")));
        assert!(!result.truncated);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn respects_max_files_and_sets_truncated() {
        let root = tempdir("cap");
        for i in 0..10 {
            fs::write(root.join(format!("f{i}.txt")), "x").unwrap();
        }
        let result = scan_tree_files(&root, 4, 12);
        assert_eq!(result.files.len(), 4);
        assert!(result.truncated);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn respects_max_depth() {
        let root = tempdir("depth");
        fs::create_dir_all(root.join("l1/l2/l3/l4")).unwrap();
        fs::write(root.join("l1/l2/l3/l4/deep.txt"), "x").unwrap();
        fs::write(root.join("l1/shallow.txt"), "x").unwrap();
        let result = scan_tree_files(&root, 1000, 2);
        let paths: Vec<String> = result
            .files
            .iter()
            .map(|f| f.path.replace('\\', "/"))
            .collect();
        assert!(paths.iter().any(|p| p.ends_with("shallow.txt")));
        assert!(!paths.iter().any(|p| p.ends_with("deep.txt")));
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn does_not_descend_into_symlinked_directories() {
        let root = tempdir("symlink");
        let real = tempdir("symlink-real");
        fs::write(real.join("secret.txt"), "secret").unwrap();
        let link = root.join("link");
        // Root also contains a real file so the scan is never empty (both the
        // success path and the skip path assert it is present).
        fs::write(root.join("plain.txt"), "x").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&real, &link).unwrap();
        #[cfg(windows)]
        {
            use std::os::windows::fs::symlink_dir;
            // Directory-symlink creation needs admin / Developer Mode on
            // Windows; without privilege the test cannot create the fixture.
            // Skip the symlink scenario instead of panicking on the OS error.
            if let Err(e) = symlink_dir(&real, &link) {
                eprintln!("skip symlink test: cannot create dir symlink ({e})");
                // Still verify the root scans its plain file.
                let result = scan_tree_files(&root, 1000, 12);
                let norm: Vec<String> = result
                    .files
                    .iter()
                    .map(|f| f.path.replace('\\', "/"))
                    .collect();
                assert!(norm.iter().any(|p| p.ends_with("plain.txt")));
                fs::remove_dir_all(&root).unwrap();
                fs::remove_dir_all(&real).unwrap();
                return;
            }
        }
        let result = scan_tree_files(&root, 1000, 12);
        let norm: Vec<String> = result
            .files
            .iter()
            .map(|f| f.path.replace('\\', "/"))
            .collect();
        assert!(norm.iter().any(|p| p.ends_with("plain.txt")));
        // The symlink is listed as an entry (not followed), but its target's
        // file must not appear.
        assert!(!norm.iter().any(|p| p.ends_with("secret.txt")));
        fs::remove_dir_all(&root).unwrap();
        fs::remove_dir_all(&real).unwrap();
    }

    /// File-level symlinks: the entry must be reported with
    /// `is_symlink=true, is_file=false, is_directory=false` so the
    /// consumer (work-artifact-scanner) can reject it without further
    /// metadata calls. Skip on Windows when symlink creation requires
    /// Developer Mode (same privilege rule as the directory case above).
    #[test]
    fn file_symlink_is_flagged_and_not_a_regular_file() {
        let root = tempdir("file-symlink");
        let real = tempdir("file-symlink-real");
        fs::write(real.join("target.txt"), "secret").unwrap();
        fs::write(root.join("plain.txt"), "x").unwrap();
        let link = root.join("link.txt");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&real.join("target.txt"), &link).unwrap();
        #[cfg(windows)]
        {
            use std::os::windows::fs::symlink_file;
            if let Err(e) = symlink_file(real.join("target.txt"), &link) {
                eprintln!("skip file-symlink test: cannot create file symlink ({e})");
                let result = scan_tree_files(&root, 1000, 12);
                let plain = result
                    .files
                    .iter()
                    .find(|f| f.path.replace('\\', "/").ends_with("plain.txt"))
                    .expect("plain.txt present");
                assert!(!plain.is_symlink, "regular file must not be flagged");
                assert!(plain.is_file, "regular file must report is_file=true");
                fs::remove_dir_all(&root).unwrap();
                fs::remove_dir_all(&real).unwrap();
                return;
            }
        }
        let result = scan_tree_files(&root, 1000, 12);
        let link_entry = result
            .files
            .iter()
            .find(|f| f.path.replace('\\', "/").ends_with("link.txt"))
            .expect("link.txt present");
        assert!(link_entry.is_symlink, "file symlink must set is_symlink");
        assert!(
            !link_entry.is_file,
            "file symlink must not be classified as a regular file"
        );
        assert!(
            !link_entry.is_directory,
            "file symlink must not be classified as a directory"
        );
        let plain = result
            .files
            .iter()
            .find(|f| f.path.replace('\\', "/").ends_with("plain.txt"))
            .expect("plain.txt present");
        assert!(!plain.is_symlink, "regular file must not be flagged");
        assert!(plain.is_file, "regular file must report is_file=true");
        fs::remove_dir_all(&root).unwrap();
        fs::remove_dir_all(&real).unwrap();
    }
}
