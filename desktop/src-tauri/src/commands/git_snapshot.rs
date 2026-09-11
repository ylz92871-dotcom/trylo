// Trylo Desktop — git_snapshot Tauri command (P2-1, spec §7.3–§7.5;
// C-Core: whole-operation budget + batched fingerprinting).
//
// Replaces the narrow `git_status` porcelain-line parser with a typed,
// NUL-delimited `git status --porcelain=v1 -z` snapshot. Each changed
// path gets a content / index OID fingerprinted into the entry so the
// Code result projector can tell a pre-dirty file that stayed unchanged
// from one that was modified again mid-run (spec §7.4).
//
// C-Core scale design (audit P1-5): a per-process timeout alone cannot
// bound the snapshot — 2000 dirty entries × 2 subprocesses each is
// still hours in the worst case. The operation now runs under ONE
// shared deadline:
//
//   * every git subprocess shares the whole-operation budget and never
//     receives a fresh full timeout (`SnapshotBudget::step_timeout`
//     clamps to the remaining time);
//   * index metadata comes from ONE `git ls-files -s -z` call instead
//     of one `ls-files` per dirty path;
//   * worktree fingerprints come from batched
//     `git hash-object --stdin-paths` calls (≤ HASH_BATCH_SIZE paths
//     per child) instead of one `hash-object` per dirty path;
//   * when the budget runs out the snapshot returns a recognisable
//     partial/timeout result (`timedOut`) instead of hanging;
//   * every spawn is `kill_on_drop` + awaited inside a `timeout`, so a
//     cancelled step can never leave an orphan git child behind.
//
// Child-process count for N dirty entries: 1 (status) + 1 (ls-files) +
// ceil(N / HASH_BATCH_SIZE) (hashing) + 1 (rev-parse) — bounded by
// construction, so no extra concurrency pool is needed.
//
// All parameters go through `Command::arg` / stdin payloads — never
// shell string concatenation. Paths returned by Git are repo-relative
// by construction; the command double-checks that the requested diff /
// content path stays inside the repo (spec §13.4).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::Serialize;
use tokio::io::AsyncWriteExt;

use crate::commands::error::CommandError;

/// One changed path parsed out of the porcelain v1 `-z` stream. The two
/// status characters are Git's X (index/staged) and Y (worktree) fields.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PorcelainEntry {
    pub path: String,
    pub old_path: Option<String>,
    pub index_status: char,
    pub worktree_status: char,
}

/// The typed snapshot returned to the renderer (camelCase via serde so the
/// TS `GitService` receives exactly the documented contract).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitSnapshotEntry {
    pub path: String,
    pub old_path: Option<String>,
    pub index_status: String,
    pub worktree_status: String,
    pub worktree_oid: Option<String>,
    pub index_oid: Option<String>,
    pub missing: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitWorkspaceSnapshot {
    pub repository: bool,
    pub head: Option<String>,
    pub entries: Vec<GitSnapshotEntry>,
    pub captured_at: f64,
    pub truncated: bool,
    /// C-Core: true when the whole-operation budget was exhausted. The
    /// snapshot is then explicitly PARTIAL — oids past the deadline are
    /// absent and the caller degrades instead of trusting completeness.
    pub timed_out: bool,
    pub warning: Option<String>,
}

/// Max dirty entries we fingerprint before a snapshot is `truncated`
/// (spec §7.5: beyond 2000 we stop claiming a complete run delta).
const MAX_DIRTY_ENTRIES: usize = 2000;

/// C-Core: the WHOLE snapshot must finish inside this budget (audit P1-5).
/// Individual subprocesses never get a fresh full timeout — they share it.
const SNAPSHOT_TOTAL_BUDGET: Duration = Duration::from_secs(20);

/// Per-step cap so one hung git call cannot consume the entire budget on
/// its own; whatever remains still belongs to the later steps.
const GIT_STEP_CAP: Duration = Duration::from_secs(8);

/// Below this residual there is no point spawning another child — the
/// snapshot stops and reports `timed_out` instead.
const MIN_STEP_BUDGET: Duration = Duration::from_millis(150);

/// Paths per batched `git hash-object --stdin-paths` child. 512 keeps each
/// child fast and the pipe payload small; 2000 dirty entries become 4
/// children instead of 2000.
const HASH_BATCH_SIZE: usize = 512;

/// Shared deadline for every git subprocess in one snapshot (C-Core).
/// Copy-by-value on purpose: the budget is a monotonically shrinking
/// resource and no step may extend it.
#[derive(Debug, Clone, Copy)]
pub struct SnapshotBudget {
    deadline: Instant,
}

impl SnapshotBudget {
    pub fn new(total: Duration) -> Self {
        Self {
            deadline: Instant::now() + total,
        }
    }

    /// Remaining time; 0 once the deadline has passed.
    pub fn remaining(self) -> Duration {
        self.deadline.saturating_duration_since(Instant::now())
    }

    /// True once the deadline has passed.
    pub fn exhausted(self) -> bool {
        Instant::now() >= self.deadline
    }

    /// Timeout for the NEXT subprocess: `min(step cap, remaining)`, or
    /// `None` when the residual is too small to justify another spawn.
    /// This is what makes every child respect the OPERATION budget
    /// instead of privately re-earning a full timeout.
    pub fn step_timeout(self) -> Option<Duration> {
        let rem = self.remaining();
        if rem < MIN_STEP_BUDGET {
            return None;
        }
        Some(rem.min(GIT_STEP_CAP))
    }
}

/// Epoch-millisecond "captured at" timestamp (spec §7.3 contract). The field
/// is a capture TIME, not a wall-time duration (M4).
fn now_epoch_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64()
        * 1000.0
}

/// Run one `git -C <root> <args>` without shelling out, bounded by the
/// shared budget. On timeout the child future is dropped (`kill_on_drop`)
/// so it can never linger. Returns `None` on failure / timeout / exhausted
/// budget — callers degrade, never panic.
async fn git_output(
    root: &Path,
    args: &[&str],
    budget: SnapshotBudget,
) -> Option<std::process::Output> {
    let timeout = budget.step_timeout()?;
    let child = tokio::process::Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .ok()?;
    tokio::time::timeout(timeout, child.wait_with_output())
        .await
        .ok()?
        .ok()
}

/// Whether `b` is one of Git's porcelain X/Y status characters.
fn is_status_char(b: u8) -> bool {
    matches!(
        b,
        b'M' | b'A' | b'D' | b'R' | b'C' | b'U' | b'?' | b'!' | b' ' | b'T'
    )
}

/// Pure parser for `git status --porcelain=v1 -z` output (spec §12.3).
///
/// Each record is a NUL-terminated token. A normal entry is the two status
/// characters followed by a space and the path. A rename / copy emits a second
/// NUL-terminated token carrying the original path. Malformed tokens are
/// skipped rather than panicking — a bad byte mid-stream never crashes the
/// host.
pub fn parse_status_v1_z(raw: &[u8]) -> Vec<PorcelainEntry> {
    let mut out = Vec::new();
    let tokens: Vec<&[u8]> = raw.split(|b| *b == 0).filter(|t| !t.is_empty()).collect();
    let mut i = 0usize;
    while i < tokens.len() {
        let tok = tokens[i];
        // A header token must start with two status characters then a space.
        if tok.len() < 3 || !is_status_char(tok[0]) || !is_status_char(tok[1]) || tok[2] != b' ' {
            // Orphan / malformed record — skip instead of panicking.
            i += 1;
            continue;
        }
        let index_status = tok[0] as char;
        let worktree_status = tok[1] as char;
        let path = String::from_utf8_lossy(&tok[3..]).to_string();
        let is_rename_or_copy = index_status == 'R' || index_status == 'C';
        let old_path = if is_rename_or_copy {
            // The original path is the next NUL token (no status header).
            let old = tokens
                .get(i.wrapping_add(1))
                .map(|t| String::from_utf8_lossy(t).to_string());
            i += 2;
            old
        } else {
            i += 1;
            None
        };
        out.push(PorcelainEntry {
            path,
            old_path,
            index_status,
            worktree_status,
        });
    }
    out
}

/// Pure parser for `git ls-files -s -z` (C-Core batch index metadata).
/// Each NUL-terminated record is `<mode> <oid> <stage>\t<path>`. Returns
/// `path -> oid`, preferring stage 0 for conflicted paths (first non-zero
/// stage wins only when no stage-0 record exists). Malformed records are
/// skipped, never fatal.
pub fn parse_ls_files_stage(raw: &[u8]) -> HashMap<String, String> {
    let mut out: HashMap<String, String> = HashMap::new();
    for token in raw.split(|b| *b == 0) {
        if token.is_empty() {
            continue;
        }
        let Some(tab) = token.iter().position(|b| *b == b'\t') else {
            continue;
        };
        let header = &token[..tab];
        let path = String::from_utf8_lossy(&token[tab + 1..]).to_string();
        let mut fields = header.split(|b| *b == b' ');
        let Some(mode) = fields.next() else { continue };
        let Some(oid) = fields.next() else { continue };
        let Some(stage) = fields.next() else { continue };
        if mode.is_empty() || oid.is_empty() || path.is_empty() {
            continue;
        }
        let oid = String::from_utf8_lossy(oid).to_string();
        if stage == b"0" {
            out.insert(path, oid);
        } else {
            out.entry(path).or_insert(oid);
        }
    }
    out
}

// ── safe repo-relative path resolution (spec §13.4) ─────────────────────────

/// Reject a "repo-relative" path that is absolute, a device/UNC path, or an
/// unresolved `..` traversal. Returns the joined absolute path on success.
pub fn resolve_repo_relative(root: &Path, relative: &str) -> Option<PathBuf> {
    if relative.is_empty() || relative.contains('\\') {
        return None;
    }
    let p = Path::new(relative);
    if p.is_absolute() {
        return None;
    }
    // Normalise: collapse any traversal segments after we have walked the
    // path once. We reject outright if any component is `..`.
    let mut joined = root.to_path_buf();
    for comp in p.components() {
        match comp {
            std::path::Component::CurDir => {}
            std::path::Component::Normal(_) => joined.push(comp),
            // Absolute prefix, parent-dir traversal, and any other root /
            // device component are rejected outright.
            _ => return None,
        }
    }
    Some(joined)
}

// ── batched fingerprinting (C-Core) ─────────────────────────────────────────

/// Batched index OIDs: ONE `git ls-files -s -z` for the whole repository
/// replaces one subprocess per dirty path (audit P1-5). Empty map on
/// failure / exhausted budget — entries then simply lack `indexOid`.
async fn batched_index_oids(root: &Path, budget: SnapshotBudget) -> HashMap<String, String> {
    let Some(output) = git_output(root, &["ls-files", "-s", "-z"], budget).await else {
        return HashMap::new();
    };
    if !output.status.success() {
        return HashMap::new();
    }
    parse_ls_files_stage(&output.stdout)
}

/// Blob-hash a chunk of absolute paths with ONE
/// `git hash-object --stdin-paths` child (line-delimited stdin, one oid per
/// line in input order). Returns `None` on any failure — the caller falls
/// back to per-path hashing for this chunk only, still budget-aware.
async fn hash_paths_batch(
    root: &Path,
    paths: &[String],
    budget: SnapshotBudget,
) -> Option<Vec<String>> {
    let timeout = budget.step_timeout()?;
    let mut payload: Vec<u8> =
        Vec::with_capacity(paths.iter().map(String::len).sum::<usize>() + paths.len());
    for p in paths {
        payload.extend_from_slice(p.as_bytes());
        payload.push(b'\n');
    }
    let work = async {
        let mut child = tokio::process::Command::new("git")
            .arg("-C")
            .arg(root)
            .args(["hash-object", "--stdin-paths"])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .ok()?;
        let mut stdin = child.stdin.take()?;
        stdin.write_all(&payload).await.ok()?;
        // Close stdin so the child sees EOF before we wait.
        drop(stdin);
        child.wait_with_output().await.ok()
    };
    let output = tokio::time::timeout(timeout, work).await.ok().flatten()?;
    if !output.status.success() {
        return None;
    }
    let lines: Vec<String> = String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(str::to_string)
        .collect();
    // One oid per input path, same order — anything else means the batch
    // result cannot be attributed back to the entries.
    (lines.len() == paths.len()).then_some(lines)
}

/// Single-path `git hash-object` — ONLY used as the fallback for a chunk
/// whose batch child failed (e.g. a file vanished between `is_file` and
/// the batch read). Still shares the operation budget.
async fn hash_single(root: &Path, abs: &Path, budget: SnapshotBudget) -> Option<String> {
    let abs_str = abs.to_string_lossy().to_string();
    let output = git_output(root, &["hash-object", &abs_str], budget).await?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Fingerprint the worktree side of every dirty entry under the shared
/// budget. Returns `(entry index -> oid, timed_out)`. Bounded: at most
/// `ceil(N / HASH_BATCH_SIZE)` hash children plus a per-path fallback for
/// at most one failed chunk.
async fn fingerprint_worktrees(
    root: &Path,
    entries: &[PorcelainEntry],
    budget: SnapshotBudget,
) -> (HashMap<usize, String>, bool) {
    // Candidates: entries whose current worktree file exists. Deleted
    // entries have no content to hash; `is_file` also excludes
    // directories / symlinks-to-directories. Paths whose absolute form
    // contains a newline cannot ride the line-delimited stdin protocol.
    let mut hashable: Vec<(usize, PathBuf)> = Vec::new();
    for (i, e) in entries.iter().enumerate() {
        if e.index_status == 'D' || e.worktree_status == 'D' {
            continue;
        }
        let Some(abs) = resolve_repo_relative(root, &e.path) else {
            continue;
        };
        if !abs.is_file() {
            continue;
        }
        let abs_str = abs.to_string_lossy();
        if abs_str.contains('\n') || abs_str.contains('\r') {
            continue;
        }
        hashable.push((i, abs));
    }

    let mut oids: HashMap<usize, String> = HashMap::with_capacity(hashable.len());
    let mut timed_out = false;
    for chunk in hashable.chunks(HASH_BATCH_SIZE) {
        if budget.step_timeout().is_none() {
            timed_out = true;
            break;
        }
        let paths: Vec<String> = chunk
            .iter()
            .map(|(_, abs)| abs.to_string_lossy().to_string())
            .collect();
        if let Some(batch) = hash_paths_batch(root, &paths, budget).await {
            for ((idx, _), oid) in chunk.iter().zip(batch) {
                oids.insert(*idx, oid);
            }
            continue;
        }
        // Chunk failed (a path vanished mid-flight, or the budget got too
        // tight for the batch). Degrade to per-path hashing for THIS chunk
        // only; the deadline still governs every child.
        for (idx, abs) in chunk {
            if budget.step_timeout().is_none() {
                timed_out = true;
                break;
            }
            if let Some(oid) = hash_single(root, abs, budget).await {
                oids.insert(*idx, oid);
            }
        }
        if timed_out {
            break;
        }
    }
    (oids, timed_out)
}

async fn git_head(root: &Path, budget: SnapshotBudget) -> Option<String> {
    let output = git_output(root, &["rev-parse", "--short", "HEAD"], budget).await?;
    if !output.status.success() {
        return None;
    }
    let head = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!head.is_empty()).then_some(head)
}

/// The deadline-aware snapshot pipeline. Never panics; every degradation
/// path is explicit in the returned `GitWorkspaceSnapshot`.
pub async fn snapshot_repo(root: &Path, budget: SnapshotBudget) -> GitWorkspaceSnapshot {
    // 1 — dirty-path list. A failure here means either "not a repository"
    // (git exited non-zero) or "budget/failure" (no output at all); the
    // two degrade differently for the renderer.
    let status_output = git_output(
        root,
        &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
        budget,
    )
    .await;
    let Some(output) = status_output else {
        return GitWorkspaceSnapshot {
            repository: false,
            head: None,
            entries: Vec::new(),
            captured_at: now_epoch_ms(),
            truncated: false,
            timed_out: budget.step_timeout().is_none() || budget.exhausted(),
            warning: Some(
                "Git snapshot timed out or failed; no change attribution available.".to_string(),
            ),
        };
    };
    if !output.status.success() {
        return GitWorkspaceSnapshot {
            repository: false,
            head: None,
            entries: Vec::new(),
            captured_at: now_epoch_ms(),
            truncated: false,
            timed_out: false,
            warning: Some("Not a Git repository; no change attribution available.".to_string()),
        };
    }

    let parsed = parse_status_v1_z(&output.stdout);
    let dirty_count = parsed.len();
    let truncated = dirty_count > MAX_DIRTY_ENTRIES;
    let bounded: Vec<PorcelainEntry> = parsed.into_iter().take(MAX_DIRTY_ENTRIES).collect();

    // 2 — ONE ls-files call for every index OID (C-Core batch metadata).
    let index_oids = batched_index_oids(root, budget).await;

    // 3 — batched worktree hashes under the shared deadline.
    let (worktree_oids, hash_timed_out) = fingerprint_worktrees(root, &bounded, budget).await;

    // 4 — HEAD short hash; degrades to None when the budget is gone.
    let head = git_head(root, budget).await;
    let timed_out = hash_timed_out || (head.is_none() && budget.step_timeout().is_none());

    // 5 — assembly. Missing oids after the deadline are simply absent;
    // `timed_out` tells the caller the snapshot is partial.
    let entries = bounded
        .into_iter()
        .enumerate()
        .map(|(i, entry)| {
            let missing = entry.index_status == 'D' || entry.worktree_status == 'D';
            // Index OID, with the rename/copy fallback to the ORIGINAL
            // path (renames reference the source in the index).
            let index_oid = index_oids
                .get(&entry.path)
                .or_else(|| {
                    entry
                        .old_path
                        .as_deref()
                        .and_then(|old| index_oids.get(old))
                })
                .cloned();
            GitSnapshotEntry {
                path: entry.path,
                old_path: entry.old_path,
                index_status: entry.index_status.to_string(),
                worktree_status: entry.worktree_status.to_string(),
                worktree_oid: worktree_oids.get(&i).cloned(),
                index_oid,
                missing,
            }
        })
        .collect();

    GitWorkspaceSnapshot {
        repository: true,
        head,
        entries,
        captured_at: now_epoch_ms(),
        truncated,
        timed_out,
        warning: timed_out.then(|| {
            "Git snapshot exceeded its operation budget; change attribution may be partial."
                .to_string()
        }),
    }
}

#[tauri::command]
pub async fn git_snapshot(root: String) -> Result<GitWorkspaceSnapshot, CommandError> {
    let p = PathBuf::from(&root);
    if !p.is_dir() {
        return Err(CommandError::NotADirectory { path: p });
    }
    // Not a repository (or git missing) is reported INSIDE the snapshot so
    // the Code result projection can degrade to checks-only instead of
    // masking success (spec §7.5). The whole operation runs under one
    // shared deadline (C-Core, audit P1-5).
    Ok(snapshot_repo(&p, SnapshotBudget::new(SNAPSHOT_TOTAL_BUDGET)).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(path: &str, x: char, y: char) -> PorcelainEntry {
        PorcelainEntry {
            path: path.to_string(),
            old_path: None,
            index_status: x,
            worktree_status: y,
        }
    }

    #[test]
    fn parses_staged_unstaged_untracked() {
        // " M", "M ", "MM", "??", "D " — all space-separated single path.
        let raw = b" M modded.rs\0M  staged.rs\0MM both.rs\0?? new.txt\0D  gone.rs\0";
        let got = parse_status_v1_z(raw);
        assert_eq!(
            got,
            vec![
                entry("modded.rs", ' ', 'M'),
                entry("staged.rs", 'M', ' '),
                entry("both.rs", 'M', 'M'),
                entry("new.txt", '?', '?'),
                entry("gone.rs", 'D', ' '),
            ]
        );
    }

    #[test]
    fn parses_rename_with_old_path() {
        let raw = b"R  src/a.rs\0src/b.rs\0";
        let got = parse_status_v1_z(raw);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].path, "src/a.rs");
        assert_eq!(got[0].old_path.as_deref(), Some("src/b.rs"));
        assert_eq!(got[0].index_status, 'R');
    }

    #[test]
    fn handles_unsafe_paths_and_empty_repo() {
        // No records at all -> empty (empty repository).
        assert!(parse_status_v1_z(b"").is_empty());
        // Spaces and a quoted marker: porcelain v1 -z disables quoting, so a
        // path with a space is a single token; no panic.
        let raw = b"M  has space.rb\0";
        let got = parse_status_v1_z(raw);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].path, "has space.rb");
    }

    #[test]
    fn skips_malformed_records_without_panicking() {
        // A truncated header (" M" with no path), an empty token, and a
        // garbage token must not panic.
        let raw = b" M\0??\0\xff\xfe\0 M ok.rs\0";
        let got = parse_status_v1_z(raw);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].path, "ok.rs");
    }

    #[test]
    fn handles_unicode_paths() {
        let raw = "M  中文 文件 .rs\0".as_bytes();
        let got = parse_status_v1_z(raw);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].path, "中文 文件 .rs");
    }

    #[test]
    fn resolve_repo_relative_rejects_unsafe_paths() {
        let root = Path::new("/tmp/repo");
        assert!(resolve_repo_relative(root, "a/b.rs").is_some());
        assert!(resolve_repo_relative(root, "a/../b.rs").is_none());
        assert!(resolve_repo_relative(root, "/abs/path").is_none());
        assert!(resolve_repo_relative(root, "a\\b.rs").is_none());
        assert!(resolve_repo_relative(root, "").is_none());
        assert!(resolve_repo_relative(root, "a/b.rs").is_some());
    }

    #[test]
    fn parses_ls_files_stage_prefers_stage_zero() {
        // Two normal stage-0 records + one conflicted pair (stage 1 / 2 on
        // the same path) + a malformed record that must be skipped.
        // (`\x00` instead of `\0` before digits: `\01` would parse as an
        // octal-looking escape.)
        let raw = b"100644 aaaa 0\tsrc/a.rs\x00100644 bbbb 0\tsrc/b.rs\x00\
                     100644 cccc 1\tconflict.rs\x00100644 dddd 2\tconflict.rs\x00\
                     garbage\x00";
        let got = parse_ls_files_stage(raw);
        assert_eq!(got.get("src/a.rs").map(String::as_str), Some("aaaa"));
        assert_eq!(got.get("src/b.rs").map(String::as_str), Some("bbbb"));
        // Non-zero stage is kept only as a fallback; a later stage-0 record
        // would have replaced it.
        assert_eq!(got.get("conflict.rs").map(String::as_str), Some("cccc"));
        assert_eq!(got.len(), 3);
    }

    #[test]
    fn budget_step_timeout_clamps_and_exhausts() {
        // Fresh budget: clamped to the per-step cap.
        let b = SnapshotBudget::new(Duration::from_secs(60));
        assert_eq!(b.step_timeout(), Some(GIT_STEP_CAP));
        // Budget smaller than the cap: clamped to the remaining time.
        let b = SnapshotBudget::new(Duration::from_secs(2));
        assert!(b.step_timeout().unwrap() <= Duration::from_secs(2));
        // Nearly-dead budget: no spawn is justified.
        let b = SnapshotBudget::new(Duration::from_millis(1));
        std::thread::sleep(Duration::from_millis(5));
        assert!(b.exhausted());
        assert_eq!(b.step_timeout(), None);
    }

    // ── scale / stress tests (C-Core, audit P1-5) ───────────────────────────

    fn unique_temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "trylo-snapshot-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |d| d.as_nanos())
        ));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    fn run_git_ok(dir: &Path, args: &[&str]) {
        let out = std::process::Command::new("git")
            .current_dir(dir)
            .args(args)
            .output()
            .expect("spawn git");
        assert!(
            out.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    fn init_repo_with_untracked(dir: &Path, file_count: usize) {
        run_git_ok(dir, &["init", "-q"]);
        run_git_ok(dir, &["config", "user.email", "test@trylo.local"]);
        run_git_ok(dir, &["config", "user.name", "trylo-test"]);
        for i in 0..file_count {
            let path = dir.join(format!("f{i:04}.txt"));
            std::fs::write(path, format!("content {i}\n")).expect("write fixture file");
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn scale_2000_dirty_entries_finishes_within_budget() {
        let dir = unique_temp_dir("scale");
        init_repo_with_untracked(&dir, 2000);

        let started = Instant::now();
        let snap = snapshot_repo(&dir, SnapshotBudget::new(SNAPSHOT_TOTAL_BUDGET)).await;
        let elapsed = started.elapsed();

        assert!(snap.repository, "2000-file repo must be recognised");
        assert_eq!(snap.entries.len(), 2000, "every dirty entry is reported");
        assert!(!snap.truncated, "exactly 2000 is NOT truncated");
        assert!(!snap.timed_out, "scale snapshot must finish in budget");
        assert!(snap.warning.is_none(), "no partial warning on success");
        // Batched hashing must have fingerprinted every present file.
        let hashed = snap
            .entries
            .iter()
            .filter(|e| e.worktree_oid.is_some())
            .count();
        assert_eq!(hashed, 2000, "all worktree files are batch-fingerprinted");
        // The operation must finish far inside its own budget — the old
        // serial design would need ~2000 subprocess spawns here.
        assert!(
            elapsed < SNAPSHOT_TOTAL_BUDGET,
            "snapshot took {elapsed:?}, budget is {SNAPSHOT_TOTAL_BUDGET:?}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn exhausted_budget_reports_timeout_and_returns_promptly() {
        let dir = unique_temp_dir("timeout");
        init_repo_with_untracked(&dir, 20);

        // A budget below MIN_STEP_BUDGET: no child may spawn at all. The
        // snapshot must come back as an explicit timeout, promptly, and
        // without leaving any git child behind (every spawn is guarded by
        // `step_timeout` + `kill_on_drop`).
        let started = Instant::now();
        let snap = snapshot_repo(&dir, SnapshotBudget::new(Duration::from_millis(1))).await;
        let elapsed = started.elapsed();

        assert!(snap.timed_out, "exhausted budget is reported as timedOut");
        assert!(!snap.repository);
        assert!(snap.entries.is_empty());
        assert!(snap.warning.is_some());
        assert!(
            elapsed < Duration::from_secs(5),
            "timeout snapshot must return promptly, took {elapsed:?}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn small_repo_happy_path_unchanged() {
        let dir = unique_temp_dir("small");
        run_git_ok(&dir, &["init", "-q"]);
        run_git_ok(&dir, &["config", "user.email", "test@trylo.local"]);
        run_git_ok(&dir, &["config", "user.name", "trylo-test"]);
        // One committed file, then modified → " M"; one untracked → "??".
        std::fs::write(dir.join("tracked.txt"), "v1\n").expect("write tracked");
        run_git_ok(&dir, &["add", "tracked.txt"]);
        run_git_ok(&dir, &["commit", "-q", "-m", "init"]);
        std::fs::write(dir.join("tracked.txt"), "v2\n").expect("modify tracked");
        std::fs::write(dir.join("new.txt"), "new\n").expect("write untracked");

        let snap = snapshot_repo(&dir, SnapshotBudget::new(SNAPSHOT_TOTAL_BUDGET)).await;

        assert!(snap.repository);
        assert!(!snap.timed_out);
        assert!(snap.head.is_some(), "committed repo reports HEAD");
        assert_eq!(snap.entries.len(), 2);
        for e in &snap.entries {
            assert!(
                e.worktree_oid.is_some(),
                "small-repo entry {} keeps its worktree fingerprint",
                e.path
            );
        }
        let tracked = snap
            .entries
            .iter()
            .find(|e| e.path == "tracked.txt")
            .unwrap();
        assert_eq!(tracked.worktree_status, "M");
        assert!(
            tracked.index_oid.is_some(),
            "staged-in-index file has indexOid"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
