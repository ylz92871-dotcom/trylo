// Trylo Desktop — git_diff_stats Tauri command (WP-4, spec §4.7).
//
// Batched, real Git line stats for a bounded set of repo-relative paths,
// matching exactly what the user sees when they open the HEAD -> worktree
// diff (`git diff HEAD -- <path>`):
//   - tracked / staged / unstaged: `git diff --numstat -z HEAD -- <paths...>`
//   - untracked text files not present in numstat: additions = current line
//     count (deletions = 0)
//   - binary: `binary: true` (the UI shows `Binary`, never a fake +N/−N)
//   - deleted files appear in numstat with their deletion count
//   - any per-path failure / timeout yields an "unknown" stat (both count
//     fields absent) rather than failing the whole run — the projector only
//     degrades `statsComplete`.
//
// All parameters go through `Command::arg` (or the stdin pipe) — never shell
// string concatenation. Every requested path is validated repo-relative
// before it is handed to git or read off disk.

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;

use serde::Serialize;

use super::git_snapshot::resolve_repo_relative;
use crate::commands::error::CommandError;

/// Per-file read cap so we never stream a huge body just to count lines.
const MAX_LINE_BYTES: u64 = 2 * 1024 * 1024;
/// Bytes scanned for a NUL to classify a file as binary.
const BINARY_PROBE: usize = 8000;
/// Cap for the single numstat git child (should be instantaneous for a
/// bounded path set, but a hung git must never leak past this).
const NUMSTAT_TIMEOUT: Duration = Duration::from_secs(8);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffStat {
    pub path: String,
    pub additions: Option<u64>,
    pub deletions: Option<u64>,
    pub binary: bool,
}

fn is_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(BINARY_PROBE).any(|b| *b == 0)
}

/// Count "lines" the way git roughly counts them: one per `\n`. A file that
/// does not end in a newline still counts its final partial line.
fn count_lines(bytes: &[u8]) -> u64 {
    if bytes.is_empty() {
        return 0;
    }
    let newlines = bytes.iter().filter(|b| **b == b'\n').count() as u64;
    if bytes.last() == Some(&b'\n') {
        newlines
    } else {
        newlines + 1
    }
}

/// Parse `git diff --numstat -z` output into `path -> (add, del, binary)`.
/// Each NUL record is `<add>\t<del>\t<path>`; `-` marks a binary side, so a
/// record whose add AND del are both `-` is a binary change. Rename/copy
/// source paths ride as extra NUL tokens with no tabs and are skipped.
pub fn parse_numstat_z(raw: &[u8]) -> HashMap<String, (Option<u64>, Option<u64>, bool)> {
    let mut out = HashMap::new();
    for token in raw.split(|b| *b == 0) {
        if token.is_empty() {
            continue;
        }
        let mut parts = token.split(|b| *b == b'\t');
        let (Some(add), Some(del), Some(path)) = (parts.next(), parts.next(), parts.next()) else {
            continue;
        };
        let add_field = std::str::from_utf8(add).unwrap_or("-");
        let del_field = std::str::from_utf8(del).unwrap_or("-");
        let binary = add_field == "-" && del_field == "-";
        let add_num = (!binary && add_field != "-").then(|| add_field.parse::<u64>().ok()).flatten();
        let del_num = (!binary && del_field != "-").then(|| del_field.parse::<u64>().ok()).flatten();
        out.insert(
            String::from_utf8_lossy(path).to_string(),
            (add_num, del_num, binary),
        );
    }
    out
}

#[tauri::command]
pub async fn git_diff_stats(
    root: String,
    paths: Vec<String>,
) -> Result<Vec<GitDiffStat>, CommandError> {
    let root_path = PathBuf::from(&root);
    if !root_path.is_dir() {
        return Err(CommandError::NotADirectory { path: root_path });
    }

    // Validate + resolve every requested path up front. Entries that fail
    // repo-relative resolution are dropped (defensive: the projector only
    // ever sends normalized snapshot paths).
    let resolved: Vec<(String, PathBuf)> = paths
        .iter()
        .filter_map(|p| resolve_repo_relative(&root_path, p).map(|abs| (p.clone(), abs)))
        .collect();

    let mut numstat: HashMap<String, (Option<u64>, Option<u64>, bool)> = HashMap::new();
    if !resolved.is_empty() {
        let mut cmd = tokio::process::Command::new("git");
        cmd.arg("-C")
            .arg(&root)
            .arg("diff")
            .arg("--numstat")
            .arg("-z")
            .arg("HEAD")
            .arg("--");
        for (p, _) in &resolved {
            cmd.arg(p);
        }
        cmd.stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true);
        if let Ok(child) = cmd.spawn() {
            if let Ok(Ok(output)) =
                tokio::time::timeout(NUMSTAT_TIMEOUT, child.wait_with_output()).await
            {
                if output.status.success() {
                    numstat = parse_numstat_z(&output.stdout);
                }
                // Non-zero exit (e.g. unborn HEAD) -> empty numstat; we
                // degrade to per-path line counting / unknown below.
            }
        }
    }

    let mut result: Vec<GitDiffStat> = Vec::with_capacity(resolved.len());
    for (path, abs) in &resolved {
        if let Some((add, del, binary)) = numstat.get(path) {
            result.push(GitDiffStat {
                path: path.clone(),
                additions: *add,
                deletions: *del,
                binary: *binary,
            });
            continue;
        }

        // Not in the tracked numstat: an untracked file (or unchanged — but a
        // change never comes here because the projector only asks for
        // changed paths). Count current disk lines as additions.
        let meta = std::fs::symlink_metadata(abs).ok();
        match meta {
            Some(m) if m.is_file() && m.len() <= MAX_LINE_BYTES => match std::fs::read(abs) {
                Ok(bytes) if is_binary(&bytes) => {
                    result.push(GitDiffStat {
                        path: path.clone(),
                        additions: None,
                        deletions: None,
                        binary: true,
                    });
                }
                Ok(bytes) => result.push(GitDiffStat {
                    path: path.clone(),
                    additions: Some(count_lines(&bytes)),
                    deletions: Some(0),
                    binary: false,
                }),
                Err(_) => result.push(GitDiffStat {
                    path: path.clone(),
                    additions: None,
                    deletions: None,
                    binary: false,
                }),
            },
            // Missing / too large / not a regular file -> unknown (never fake
            // +0 −0). A tracked deletion already surfaced via numstat.
            _ => result.push(GitDiffStat {
                path: path.clone(),
                additions: None,
                deletions: None,
                binary: false,
            }),
        }
    }

    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn count_lines_handles_empty_and_trailing() {
        assert_eq!(count_lines(b"a\nb\nc"), 3);
        assert_eq!(count_lines(b"a\nb\nc\n"), 3);
        assert_eq!(count_lines(b""), 0);
        assert_eq!(count_lines(b"\n"), 1);
    }

    #[test]
    fn parses_numstat_regular_and_binary() {
        // "3\t1\t" then path; binary as "-	-\t"; rename source as a bare
        // NUL token (no tabs) that must be skipped.
        let raw = b"3\t1\tsrc/a.ts\x00-\t-\timg.bin\x00src/old.ts\x0010\t0\tnew.rs\x00";
        let map = parse_numstat_z(raw);
        assert_eq!(map.get("src/a.ts"), Some(&(Some(3), Some(1), false)));
        assert_eq!(map.get("img.bin"), Some(&(None, None, true)));
        assert_eq!(map.get("new.rs"), Some(&(Some(10), Some(0), false)));
        assert_eq!(map.len(), 3); // bare "src/old.ts" rename source skipped
    }

    #[test]
    fn parses_numstat_handles_garbage_and_unicode() {
        let raw = "12\t4\t中文 文件 .rs\x00garbage\x00".as_bytes();
        let map = parse_numstat_z(raw);
        assert_eq!(map.get("中文 文件 .rs"), Some(&(Some(12), Some(4), false)));
        assert_eq!(map.len(), 1);
    }

    #[test]
    fn resolve_guards_every_requested_path() {
        let root = Path::new("/tmp/repo");
        let ok = resolve_repo_relative(root, "a/b.rs").is_some();
        let bad = resolve_repo_relative(root, "../../etc/passwd").is_none();
        assert!(ok && bad);
    }
}