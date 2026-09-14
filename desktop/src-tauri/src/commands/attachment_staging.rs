// Trylo Desktop — attachment staging Tauri commands
// (P2-1 Work Package B). See ARCHITECTURE.md §9 + §10.2.
//
// Work attachments are NEVER projected to the daemon as bare
// external absolute paths. The renderer asks this command to
// copy each picked / dropped file into the workspace-controlled
// staging area:
//
//   <workspace>/.trylo/attachments/<conversationId>/<attachmentId>/<sanitized-basename>
//
// and receives back a workspace-RELATIVE descriptor path.
//
// Security checklist enforced here (audit §3.4):
//   - conversation_id / attachment_id whitelist (no traversal);
//   - symlink / reparse-point / directory / special-file rejection
//     via `symlink_metadata` (never follows links);
//   - per-kind size limit checked BEFORE the copy;
//   - basename sanitization (control chars, separators, reserved
//     Windows names, leading/trailing dots, length cap, Unicode kept);
//   - one directory per attachmentId — same-name files never
//     overwrite each other; an existing target is an error;
//   - POST-copy validation: re-stat the destination (plain file,
//     size equals the copied byte count) — catches TOCTOU source
//     mutation;
//   - canonical containment: canonicalize the staged file and
//     assert it stays under the canonical workspace anchor;
//   - git safety: `.trylo/attachments/.gitignore` (`*`) plus a
//     best-effort `.git/info/exclude` entry, so staged content
//     never enters the user's commits.

use crate::commands::error::CommandError;
use serde::Serialize;
use std::path::Path;

/// Office documents get the generous cap (mirrors the
/// `attachment-utils.ts` constants: 50 MB).
const MAX_OFFICE_BYTES: u64 = 50 * 1024 * 1024;
/// Text and image attachments: 10 MB.
const MAX_OTHER_BYTES: u64 = 10 * 1024 * 1024;
/// Stems longer than this are truncated (extension preserved).
const MAX_STEM_CHARS: usize = 100;
/// Fallback name when sanitization empties the basename.
const FALLBACK_NAME: &str = "attachment.bin";

/// Result of a successful stage. `relative_path` is ALWAYS a
/// forward-slashed workspace-relative path — the renderer puts
/// it verbatim into the `<trylo_attachments>` prompt block.
#[derive(Debug, Serialize)]
pub struct StagedAttachment {
    pub relative_path: String,
    pub name: String,
    pub size: u64,
}

fn validation(reason: impl Into<String>) -> CommandError {
    CommandError::Validation {
        reason: reason.into(),
    }
}

fn io_error(path: &Path, source: std::io::Error) -> CommandError {
    CommandError::Io {
        path: path.to_path_buf(),
        source,
    }
}

/// `JoinError` from `spawn_blocking` — the staging body itself
/// never panics (no unwraps on user input), so surface it as IO.
fn join_error(path: &Path, err: &tokio::task::JoinError) -> CommandError {
    io_error(path, std::io::Error::other(err.to_string()))
}

/// Id segments are path components we build directories from, so
/// they get a strict whitelist instead of escaping attempts being
/// detected after the fact: `[A-Za-z0-9_-]{1,128}`. This rejects
/// `..`, `/`, `\`, NUL and every other separator outright.
fn validate_segment(value: &str, what: &str) -> Result<(), CommandError> {
    let ok = !value.is_empty()
        && value.len() <= 128
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    if ok {
        Ok(())
    } else {
        Err(validation(format!(
            "invalid {what}: must match [A-Za-z0-9_-]{{1,128}}"
        )))
    }
}

/// Office extension set mirrors `attachment-utils.ts` — only the
/// size LIMIT depends on it here; the kind classification itself
/// stays a renderer concern.
fn is_office_ext(path: &Path) -> bool {
    let ext = path
        .extension()
        .map(std::ffi::OsStr::to_ascii_lowercase)
        .and_then(|e| e.to_str().map(str::to_owned));
    matches!(
        ext.as_deref(),
        Some("doc" | "docx" | "xls" | "xlsx" | "ppt" | "pptx" | "pdf")
    )
}

fn size_limit_for(path: &Path) -> u64 {
    if is_office_ext(path) {
        MAX_OFFICE_BYTES
    } else {
        MAX_OTHER_BYTES
    }
}

/// Windows reserved device names (case-insensitive, with or
/// without an extension) are invalid file stems on NTFS.
fn is_windows_reserved_stem(stem: &str) -> bool {
    let up = stem.to_ascii_uppercase();
    // Reserved names are ASCII-only; the byte-split below is only
    // valid on pure-ASCII stems.
    if !up.is_ascii() {
        return false;
    }
    if matches!(up.as_str(), "CON" | "PRN" | "AUX" | "NUL") {
        return true;
    }
    if up.len() == 4 {
        let (prefix, tail) = up.split_at(3);
        if matches!(prefix, "COM" | "LPT")
            && tail.bytes().next().is_some_and(|b| b.is_ascii_digit())
        {
            return true;
        }
    }
    false
}

/// Sanitize a raw basename for use as the staged file name:
/// drop control characters, trim whitespace and dots (Windows
/// forbids trailing dots/spaces), reject reserved device stems,
/// cap the stem length. Unicode characters are preserved — a
/// `需求.docx` keeps its display name. An empty result falls
/// back to `attachment.bin`.
fn sanitize_basename(raw: &str) -> String {
    // A path component can never contain a separator, but a
    // hostile caller controls `raw`; re-split defensively.
    let last = raw.rsplit(['/', '\\']).next().unwrap_or(raw);
    let cleaned: String = last.chars().filter(|c| !c.is_control()).collect();
    let trimmed = cleaned.trim().trim_matches('.').trim();
    if trimmed.is_empty() {
        return FALLBACK_NAME.to_owned();
    }
    // `.` is ASCII, so the byte index from `rfind` is a safe cut.
    let (stem, ext) = match trimmed.rfind('.') {
        Some(i) if i > 0 => trimmed.split_at(i),
        _ => (trimmed, ""),
    };
    let mut stem: String = stem.chars().take(MAX_STEM_CHARS).collect();
    if stem.is_empty() {
        stem.push_str("file");
    }
    if is_windows_reserved_stem(&stem) {
        stem.insert(0, '_');
    }
    format!("{stem}{ext}")
}

/// Best-effort double git exclusion: a directory-local
/// `.gitignore` (works even in sub-repos) plus the repo's
/// `.git/info/exclude` (leaves the working tree untouched).
/// Failures here must never fail the stage itself.
fn ensure_git_exclusion(anchor: &Path) {
    let attachments_dir = anchor.join(".trylo").join("attachments");
    let ignore = attachments_dir.join(".gitignore");
    if !ignore.exists() {
        let _ = std::fs::write(&ignore, "# Trylo staged attachments — never commit\n*\n");
    }
    let exclude = anchor.join(".git").join("info").join("exclude");
    if exclude.is_file() {
        if let Ok(mut content) = std::fs::read_to_string(&exclude) {
            let present = content
                .lines()
                .any(|line| line.trim() == ".trylo/attachments/");
            if !present {
                if !content.is_empty() && !content.ends_with('\n') {
                    content.push('\n');
                }
                content.push_str(".trylo/attachments/\n");
                let _ = std::fs::write(&exclude, content);
            }
        }
    }
}

/// The blocking staging body. Runs inside `spawn_blocking` so a
/// large copy never stalls the Tauri async worker pool.
fn stage_attachment_sync(
    workspace_root: &str,
    conversation_id: &str,
    attachment_id: &str,
    source_path: &str,
) -> Result<StagedAttachment, CommandError> {
    validate_segment(conversation_id, "conversation_id")?;
    validate_segment(attachment_id, "attachment_id")?;

    let anchor = std::fs::canonicalize(workspace_root)
        .map_err(|e| io_error(Path::new(workspace_root), e))?;

    let src = Path::new(source_path);
    // PRE-copy validation. `symlink_metadata` never follows the
    // link, so a symlink/reparse point shows up as `is_symlink()`
    // instead of masquerading as its target.
    let meta = std::fs::symlink_metadata(src).map_err(|e| io_error(src, e))?;
    let file_type = meta.file_type();
    if file_type.is_symlink() {
        return Err(validation(format!(
            "symlinks cannot be attached: {source_path}"
        )));
    }
    if file_type.is_dir() {
        return Err(CommandError::NotAFile {
            path: src.to_path_buf(),
        });
    }
    if !file_type.is_file() {
        return Err(validation(format!(
            "special files cannot be attached: {source_path}"
        )));
    }
    let limit = size_limit_for(src);
    if meta.len() > limit {
        return Err(validation(format!(
            "file too large ({} > {} bytes)",
            meta.len(),
            limit
        )));
    }

    let name = src.file_name().map_or_else(
        || FALLBACK_NAME.to_owned(),
        |n| sanitize_basename(&n.to_string_lossy()),
    );

    // One directory per attachmentId — same-name files from
    // different attachments can never collide or overwrite.
    let relative_path = format!(".trylo/attachments/{conversation_id}/{attachment_id}/{name}");
    let target = anchor
        .join(".trylo")
        .join("attachments")
        .join(conversation_id)
        .join(attachment_id)
        .join(&name);
    if target.exists() {
        return Err(validation(format!(
            "attachment already staged ({relative_path}) — remove it first"
        )));
    }
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| io_error(parent, e))?;
    }
    // The copy itself. A source that disappears mid-flight turns
    // into a visible IO failure — never a silent half-stage.
    let copied = std::fs::copy(src, &target).map_err(|e| io_error(src, e))?;

    // POST-copy validation (TOCTOU): the destination must be a
    // plain file whose size matches both the copied byte count
    // and the pre-copy stat. Any mismatch removes the partial
    // target and fails loudly.
    let cleanup_on_mismatch = |err: CommandError| -> CommandError {
        let _ = std::fs::remove_file(&target);
        err
    };
    let post = std::fs::symlink_metadata(&target)
        .map_err(|e| cleanup_on_mismatch(io_error(&target, e)))?;
    if !post.file_type().is_file() {
        return Err(cleanup_on_mismatch(validation(
            "staged destination is not a plain file",
        )));
    }
    if post.len() != copied || post.len() != meta.len() {
        return Err(cleanup_on_mismatch(validation(format!(
            "staged size mismatch (pre {} / copied {} / post {})",
            meta.len(),
            copied,
            post.len()
        ))));
    }

    // Canonical containment: the staged file must resolve inside
    // the canonical workspace anchor. Defense-in-depth — with
    // whitelisted ids and a joined target this cannot fail, but
    // the assertion turns any future regression into a hard error.
    let canonical_target =
        std::fs::canonicalize(&target).map_err(|e| cleanup_on_mismatch(io_error(&target, e)))?;
    if !canonical_target.starts_with(&anchor) {
        return Err(cleanup_on_mismatch(validation(
            "staged file escaped the workspace containment",
        )));
    }

    ensure_git_exclusion(&anchor);

    Ok(StagedAttachment {
        relative_path,
        name,
        size: copied,
    })
}

/// Stage one external file into the workspace's controlled
/// attachment area. See the module header for the full safety
/// checklist.
#[tauri::command]
pub async fn stage_attachment(
    workspace_root: String,
    conversation_id: String,
    attachment_id: String,
    source_path: String,
) -> Result<StagedAttachment, CommandError> {
    let err_path = source_path.clone();
    tokio::task::spawn_blocking(move || {
        stage_attachment_sync(
            &workspace_root,
            &conversation_id,
            &attachment_id,
            &source_path,
        )
    })
    .await
    .map_err(|e| join_error(Path::new(&err_path), &e))?
}

/// Remove every staged attachment of one conversation
/// (conversation-deletion cleanup). Idempotent: a missing
/// directory is success.
#[tauri::command]
pub async fn remove_conversation_attachments(
    workspace_root: String,
    conversation_id: String,
) -> Result<(), CommandError> {
    let err_path = workspace_root.clone();
    tokio::task::spawn_blocking(move || {
        validate_segment(&conversation_id, "conversation_id")?;
        let dir = Path::new(&workspace_root)
            .join(".trylo")
            .join("attachments")
            .join(&conversation_id);
        match std::fs::remove_dir_all(&dir) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(io_error(&dir, e)),
        }
    })
    .await
    .map_err(|e| join_error(Path::new(&err_path), &e))?
}

/// Remove the whole project staging area (workspace close).
/// Idempotent.
#[tauri::command]
pub async fn remove_project_attachments(workspace_root: String) -> Result<(), CommandError> {
    let err_path = workspace_root.clone();
    tokio::task::spawn_blocking(move || {
        let dir = Path::new(&workspace_root)
            .join(".trylo")
            .join("attachments");
        match std::fs::remove_dir_all(&dir) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(io_error(&dir, e)),
        }
    })
    .await
    .map_err(|e| join_error(Path::new(&err_path), &e))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    /// Per-test scratch directory under the OS temp dir. No
    /// external crate: unique by nanos + pid, removed eagerly.
    fn scratch(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos());
        let dir = std::env::temp_dir().join(format!(
            "trylo-attach-{label}-{}-{}",
            nanos,
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).expect("scratch dir");
        dir
    }

    fn cleanup(dir: &Path) {
        let _ = std::fs::remove_dir_all(dir);
    }

    fn write(dir: &Path, name: &str, content: &[u8]) -> PathBuf {
        let p = dir.join(name);
        std::fs::write(&p, content).expect("write source file");
        p
    }

    #[test]
    fn happy_path_stages_unicode_file() {
        let root = scratch("happy");
        let content = b"fake-office-bytes";
        let src = write(&root, "需求文档.docx", content);
        let res = stage_attachment_sync(
            root.to_str().unwrap(),
            "work-conv1",
            "attachment_a1",
            src.to_str().unwrap(),
        )
        .expect("stage succeeds");
        assert_eq!(res.name, "需求文档.docx");
        assert_eq!(res.size, u64::try_from(content.len()).unwrap());
        assert_eq!(
            res.relative_path,
            ".trylo/attachments/work-conv1/attachment_a1/需求文档.docx"
        );
        let staged = root.join(".trylo/attachments/work-conv1/attachment_a1/需求文档.docx");
        assert!(staged.is_file());
        assert_eq!(std::fs::read(&staged).unwrap(), content);
        cleanup(&root);
    }

    #[test]
    fn rejects_traversal_and_separator_ids() {
        let root = scratch("ids");
        let src = write(&root, "a.txt", b"x");
        let root_s = root.to_str().unwrap();
        let src_s = src.to_str().unwrap();
        for bad in ["../evil", "a/b", "a\\b", "..", "", "a b", "a\0b"] {
            assert!(
                stage_attachment_sync(root_s, bad, "attachment_a1", src_s).is_err(),
                "conversation id must be rejected: {bad:?}"
            );
            assert!(
                stage_attachment_sync(root_s, "conv1", bad, src_s).is_err(),
                "attachment id must be rejected: {bad:?}"
            );
        }
        cleanup(&root);
    }

    #[test]
    fn rejects_directory_source() {
        let root = scratch("dir");
        let sub = root.join("some-dir");
        std::fs::create_dir_all(&sub).unwrap();
        let err = stage_attachment_sync(
            root.to_str().unwrap(),
            "conv1",
            "attachment_a1",
            sub.to_str().unwrap(),
        )
        .expect_err("directories are rejected");
        assert!(matches!(err, CommandError::NotAFile { .. }));
        cleanup(&root);
    }

    #[test]
    fn rejects_oversized_text_file() {
        let root = scratch("big");
        // 10 MB + 1 byte — just over the non-office cap.
        let oversize: usize = MAX_OTHER_BYTES.try_into().expect("usize fits the cap");
        let src = write(&root, "big.txt", &vec![b'a'; oversize + 1]);
        let err = stage_attachment_sync(
            root.to_str().unwrap(),
            "conv1",
            "attachment_a1",
            src.to_str().unwrap(),
        )
        .expect_err("oversized is rejected");
        let reason = err.to_string();
        assert!(reason.contains("file too large"), "reason: {reason}");
        cleanup(&root);
    }

    #[test]
    fn office_gets_the_generous_limit() {
        let root = scratch("office");
        // 20 MB of office data fits the 50 MB cap.
        let src = write(&root, "deck.pptx", &vec![b'b'; 20 * 1024 * 1024]);
        let res = stage_attachment_sync(
            root.to_str().unwrap(),
            "conv1",
            "attachment_a1",
            src.to_str().unwrap(),
        );
        assert!(res.is_ok(), "20MB office must fit: {:?}", res.err());
        cleanup(&root);
    }

    #[test]
    fn rejects_symlink_source() {
        let root = scratch("link");
        let target = write(&root, "real.txt", b"data");
        let link = root.join("link.txt");
        #[cfg(unix)]
        let created = std::os::unix::fs::symlink(&target, &link).is_ok();
        #[cfg(windows)]
        let created = std::os::windows::fs::symlink_file(&target, &link).is_ok();
        if !created {
            // Symlink creation needs privilege on some Windows
            // setups; the rejection logic is platform-neutral
            // (symlink_metadata), covered by review elsewhere.
            eprintln!("skipping symlink test: could not create symlink");
            cleanup(&root);
            return;
        }
        let err = stage_attachment_sync(
            root.to_str().unwrap(),
            "conv1",
            "attachment_a1",
            link.to_str().unwrap(),
        )
        .expect_err("symlinks are rejected");
        assert!(err.to_string().contains("symlink"), "reason: {err}");
        cleanup(&root);
    }

    #[test]
    fn same_name_different_attachments_never_collide() {
        let root = scratch("names");
        let src = write(&root, "report.pdf", b"one");
        let r1 = stage_attachment_sync(
            root.to_str().unwrap(),
            "conv1",
            "attachment_a1",
            src.to_str().unwrap(),
        )
        .unwrap();
        let r2 = stage_attachment_sync(
            root.to_str().unwrap(),
            "conv1",
            "attachment_b2",
            src.to_str().unwrap(),
        )
        .unwrap();
        assert_ne!(r1.relative_path, r2.relative_path);
        assert!(r1.relative_path.contains("attachment_a1"));
        assert!(r2.relative_path.contains("attachment_b2"));
        cleanup(&root);
    }

    #[test]
    fn restaging_same_attachment_id_is_rejected_not_overwritten() {
        let root = scratch("nooverwrite");
        let src = write(&root, "report.pdf", b"one");
        stage_attachment_sync(
            root.to_str().unwrap(),
            "conv1",
            "attachment_a1",
            src.to_str().unwrap(),
        )
        .unwrap();
        let err = stage_attachment_sync(
            root.to_str().unwrap(),
            "conv1",
            "attachment_a1",
            src.to_str().unwrap(),
        )
        .expect_err("second stage of the same id fails");
        assert!(err.to_string().contains("already staged"), "reason: {err}");
        // Original bytes untouched.
        let staged = root.join(".trylo/attachments/conv1/attachment_a1/report.pdf");
        assert_eq!(std::fs::read(&staged).unwrap(), b"one");
        cleanup(&root);
    }

    #[test]
    fn missing_source_is_a_visible_io_failure() {
        let root = scratch("missing");
        let ghost = root.join("ghost.txt");
        let err = stage_attachment_sync(
            root.to_str().unwrap(),
            "conv1",
            "attachment_a1",
            ghost.to_str().unwrap(),
        )
        .expect_err("missing source fails");
        assert!(matches!(err, CommandError::Io { .. }));
        cleanup(&root);
    }

    #[test]
    fn git_exclusion_is_written_and_idempotent() {
        let root = scratch("git");
        // Fake repo so the exclude branch runs too.
        let info = root.join(".git").join("info");
        std::fs::create_dir_all(&info).unwrap();
        std::fs::write(info.join("exclude"), "# existing\n").unwrap();

        let src = write(&root, "a.txt", b"x");
        stage_attachment_sync(
            root.to_str().unwrap(),
            "conv1",
            "attachment_a1",
            src.to_str().unwrap(),
        )
        .unwrap();
        stage_attachment_sync(
            root.to_str().unwrap(),
            "conv2",
            "attachment_b2",
            src.to_str().unwrap(),
        )
        .unwrap();

        let ignore = root.join(".trylo/attachments/.gitignore");
        let ignore_content = std::fs::read_to_string(&ignore).unwrap();
        assert!(ignore_content.contains('*'));
        assert_eq!(ignore_content.matches('#').count(), 1, "written once");

        let exclude = std::fs::read_to_string(info.join("exclude")).unwrap();
        assert_eq!(exclude.matches(".trylo/attachments/").count(), 1);
        assert!(exclude.starts_with("# existing\n"));
        cleanup(&root);
    }

    #[test]
    fn sanitize_basename_covers_hostile_inputs() {
        assert_eq!(sanitize_basename("plain.txt"), "plain.txt");
        assert_eq!(sanitize_basename("  spaced . "), "spaced");
        assert_eq!(sanitize_basename("CON.txt"), "_CON.txt");
        assert_eq!(sanitize_basename("nul"), "_nul");
        assert_eq!(sanitize_basename("com1.log"), "_com1.log");
        assert_eq!(sanitize_basename("..."), FALLBACK_NAME);
        assert_eq!(sanitize_basename("a/b\\c.txt"), "c.txt");
        assert_eq!(sanitize_basename("控制\u{8}字符.txt"), "控制字符.txt");
        let long = format!("{}.txt", "x".repeat(500));
        let out = sanitize_basename(&long);
        assert!(out.chars().count() <= MAX_STEM_CHARS + ".txt".len());
        assert!(Path::new(&out)
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("txt")));
        // Unicode survives untouched.
        assert_eq!(sanitize_basename("需求文档.docx"), "需求文档.docx");
    }

    #[test]
    fn remove_conversation_attachments_is_idempotent() {
        let root = scratch("remove");
        let src = write(&root, "a.txt", b"x");
        stage_attachment_sync(
            root.to_str().unwrap(),
            "conv1",
            "attachment_a1",
            src.to_str().unwrap(),
        )
        .unwrap();
        let dir = root.join(".trylo/attachments/conv1");
        assert!(dir.exists());
        remove_conversation_dir_sync(&root, "conv1");
        assert!(!dir.exists());
        // Second removal: still success.
        remove_conversation_dir_sync(&root, "conv1");
        cleanup(&root);
    }

    /// Sync twin of the command body for direct test access.
    fn remove_conversation_dir_sync(root: &Path, conversation_id: &str) {
        validate_segment(conversation_id, "conversation_id").unwrap();
        let dir = root
            .join(".trylo")
            .join("attachments")
            .join(conversation_id);
        match std::fs::remove_dir_all(&dir) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => panic!("unexpected removal failure: {e}"),
        }
    }

    /// REAL-git isolation proof (validation step 4): after staging,
    /// `git status` must not surface anything under
    /// `.trylo/attachments`. Skips cleanly when git is unavailable.
    #[test]
    fn real_git_status_never_shows_staged_attachments() {
        let root = scratch("realgit");
        let init = std::process::Command::new("git")
            .args(["init", "--quiet"])
            .current_dir(&root)
            .output();
        match init {
            Ok(out) if out.status.success() => {}
            _ => {
                eprintln!("git unavailable — skipping real-git isolation test");
                cleanup(&root);
                return;
            }
        }

        // One user file the repo SHOULD see, plus a staged attachment.
        write(&root, "user-file.txt", b"tracked-content");
        let external = std::env::temp_dir().join(format!(
            "trylo-attach-external-{}-{}.txt",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_or(0, |d| d.as_nanos())
        ));
        std::fs::write(&external, b"attachment-bytes").unwrap();
        stage_attachment_sync(
            root.to_str().unwrap(),
            "conv1",
            "attachment_a1",
            external.to_str().unwrap(),
        )
        .unwrap();

        let status = std::process::Command::new("git")
            .args(["status", "--porcelain"])
            .current_dir(&root)
            .output()
            .expect("git status");
        assert!(status.status.success(), "git status failed");
        let text = String::from_utf8_lossy(&status.stdout).to_string();
        assert!(
            !text.contains(".trylo/attachments"),
            "staged attachments leaked into git status:\n{text}"
        );
        // The user's own file is still visible — the ignore is scoped.
        assert!(
            text.contains("user-file.txt"),
            "scoped ignore too broad:\n{text}"
        );
        let _ = std::fs::remove_file(&external);
        cleanup(&root);
    }
}
