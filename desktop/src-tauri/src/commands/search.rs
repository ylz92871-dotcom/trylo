// Trylo Desktop — search Tauri command. See the architecture doc §2.4
// (monaco-vcode-api search service override) + §3 Phase 1
// Week 2 (Terminal + Search).
//
// Ripgrep-backed file-content search. Week 2 Day 2 adds the
// `regex` and `case_insensitive` toggles; the rest of the
// behavior is the same as the Day 6 spike.

use std::path::PathBuf;
use std::process::Command;

use serde::Serialize;

use crate::commands::error::CommandError;

#[derive(Debug, Serialize)]
pub struct SearchMatch {
    pub path: String,
    /// 1-based line number, per editor convention.
    pub line: u32,
    pub content: String,
}

#[tauri::command]
pub async fn search(
    query: String,
    path: String,
    regex: bool,
    case_insensitive: bool,
) -> Result<Vec<SearchMatch>, CommandError> {
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err(CommandError::Io {
            path: p,
            source: std::io::Error::new(std::io::ErrorKind::NotFound, "search path does not exist"),
        });
    }

    // `rg --no-heading --line-number` emits one match per line:
    //   <path>:<line>:<content>
    // We parse the first two `:`-separated fields; the content can
    // itself contain `:` (Windows paths, file contents, etc.).
    // When `regex` is false we use -F (fixed string) so metachars
    // are treated literally — most users want a "search" box to
    // do that, not silently fail on an unescaped `*`.
    let mut cmd = Command::new("rg");
    cmd.arg("--no-heading")
        .arg("--line-number")
        .arg("--no-config")
        .arg(if regex { "-e" } else { "-F" })
        .arg("--")
        .arg(&query)
        .arg(&p);
    if case_insensitive {
        cmd.arg("-i");
    }
    let output = cmd.output().map_err(|e| CommandError::Io {
        path: p.clone(),
        source: std::io::Error::other(e.to_string()),
    })?;

    // rg exits 1 when there are no matches. That's a successful run
    // with an empty result, not an error.
    if !output.status.success() && output.status.code() != Some(1) {
        return Err(CommandError::Io {
            path: p,
            source: std::io::Error::other(format!("rg exited with {:?}", output.status.code())),
        });
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut matches: Vec<SearchMatch> = stdout
        .lines()
        .filter_map(|line| {
            // <path>:<line>:<content>
            let mut split = line.splitn(3, ':');
            let path = split.next()?.to_string();
            let line_no: u32 = split.next()?.parse().ok()?;
            let content = split.next()?.to_string();
            Some(SearchMatch {
                path,
                line: line_no,
                content,
            })
        })
        .take(200) // spike-time cap
        .collect();
    matches.sort_by(|a, b| (a.path.as_str(), a.line).cmp(&(b.path.as_str(), b.line)));
    Ok(matches)
}
