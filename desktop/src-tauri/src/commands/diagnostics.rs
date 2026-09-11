// Trylo Desktop — bounded, redacted diagnostics for sidecar stderr.
//
// Audit doc `TRYLO-WORK-PHASE1-PHASE2-RUNTIME-AUDIT-AND-REMEDIATION-2026-08-28.md`:
//   - SH-P0-5: the Service Host's stderr was `Stdio::null()`, so a real
//     import / path / Node-runtime failure was completely invisible.
//   - W-P0-3:  the Work daemon's stderr was inherited to the terminal that
//     launched Tauri; an installed user has no terminal.
//
// Both now pipe stderr and feed it through this module, which keeps a
// BOUNDED number of SANITISED lines. What is never kept:
//   - secret values (api keys, tokens, bearer headers, cookies);
//   - prompt / message bodies;
//   - full private absolute paths (only the last two components survive).
//
// The renderer receives the sanitised tail only — never the raw stream.

use std::collections::VecDeque;
use std::sync::Mutex;

/// Hard cap per line. Long stack traces are truncated, not stored.
const MAX_LINE_CHARS: usize = 240;
/// Default number of retained lines (oldest dropped first).
const DEFAULT_MAX_LINES: usize = 20;

/// Lower-cased key names whose value must never be recorded.
const SENSITIVE_KEYS: &[&str] = &[
    "apikey",
    "api_key",
    "api-key",
    "x-api-key",
    "token",
    "accesstoken",
    "access_token",
    "refreshtoken",
    "refresh_token",
    "secret",
    "clientsecret",
    "password",
    "passwd",
    "pwd",
    "authorization",
    "auth",
    "bearer",
    "cookie",
    "set-cookie",
    "sessionid",
    "session",
    "privatekey",
    "private_key",
];

/// Characters that terminate a path token inside a log line.
const PATH_TERMINATORS: &[char] = &[' ', '\t', '"', '\'', '`', ',', ';', ')', ']', '}', '>', '<'];

/// A process-safe ring buffer of sanitised stderr lines.
pub struct DiagnosticTail {
    lines: Mutex<VecDeque<String>>,
    max_lines: usize,
}

impl DiagnosticTail {
    #[must_use]
    pub fn new() -> Self {
        Self::with_limit(DEFAULT_MAX_LINES)
    }

    #[must_use]
    pub fn with_limit(max_lines: usize) -> Self {
        Self {
            lines: Mutex::new(VecDeque::with_capacity(max_lines.max(1))),
            max_lines: max_lines.max(1),
        }
    }

    /// Record one already-split line. Blank/whitespace-only lines are
    /// dropped — a crash tail of 200 empty lines hides the real cause.
    pub fn push(&self, line: &str) {
        let sanitized = sanitize_line(line);
        if sanitized.trim().is_empty() {
            return;
        }
        if let Ok(mut guard) = self.lines.lock() {
            if guard.len() >= self.max_lines {
                guard.pop_front();
            }
            guard.push_back(sanitized);
        }
    }

    /// Split a raw chunk on newlines and record each line.
    pub fn push_chunk(&self, chunk: &str) {
        for line in chunk.lines() {
            self.push(line);
        }
    }

    #[must_use]
    pub fn snapshot(&self) -> Vec<String> {
        match self.lines.lock() {
            Ok(guard) => guard.iter().cloned().collect(),
            Err(_) => Vec::new(),
        }
    }

    pub fn clear(&self) {
        if let Ok(mut guard) = self.lines.lock() {
            guard.clear();
        }
    }
}

impl Default for DiagnosticTail {
    fn default() -> Self {
        Self::new()
    }
}

/// Sanitise + truncate a single stderr line.
#[must_use]
pub fn sanitize_line(line: &str) -> String {
    let mut text = redact_secrets(line);
    text = redact_paths(&text);
    truncate_chars(&text, MAX_LINE_CHARS)
}

fn truncate_chars(input: &str, max: usize) -> String {
    let mut out = String::with_capacity(max + 1);
    for (index, ch) in input.chars().enumerate() {
        if index >= max {
            out.push('…');
            break;
        }
        out.push(ch);
    }
    out
}

/// Replace secret VALUES with `<redacted>`, keeping the key name so the
/// diagnostic stays actionable ("apiKey=<redacted>" beats "<redacted>").
fn redact_secrets(input: &str) -> String {
    let tokens: Vec<&str> = input.split_whitespace().collect();
    let mut out = String::with_capacity(input.len());
    let mut index = 0;
    while index < tokens.len() {
        let token = tokens[index];
        let bare = bare_token(token);
        let lower = bare.to_ascii_lowercase();

        // Provider keys (`sk-…`) turn up bare in stack traces.
        if lower.starts_with("sk-") && lower.len() > 6 {
            out.push_str("<redacted> ");
            index += 1;
            continue;
        }
        // `Bearer <token>` — the scheme is public, the value is not.
        if lower == "bearer" && tokens.len() > index + 1 {
            out.push_str(token);
            out.push_str(" <redacted> ");
            index += 2;
            continue;
        }
        // key=value / key:value / "key": "value"
        if let Some(sep) = token.find(['=', ':']) {
            let key: String = token[..sep]
                .chars()
                .filter(char::is_ascii_alphanumeric)
                .collect();
            if SENSITIVE_KEYS.contains(&key.to_ascii_lowercase().as_str()) {
                out.push_str(&redact_assignment(token, sep));
                out.push(' ');
                index += 1;
                // `Authorization: Bearer eyJ…` — the value spilled into the
                // following tokens; swallow them so the secret is really gone.
                if value_after_separator(token, sep).is_empty() {
                    index += swallow_values(&tokens, index);
                }
                continue;
            }
        }
        out.push_str(token);
        out.push(' ');
        index += 1;
    }
    out.trim_end().to_string()
}

/// Strip quoting/punctuation so `"Bearer"` and `Bearer,` compare equal.
fn bare_token(token: &str) -> &str {
    token.trim_matches(|c: char| !c.is_ascii_alphanumeric() && c != '-' && c != '_')
}

/// Everything after the `=`/`:`, minus trailing punctuation.
fn value_after_separator(token: &str, sep: usize) -> &str {
    let sep_len = token[sep..].chars().next().map_or(1, char::len_utf8);
    let rest = &token[sep + sep_len..];
    let trimmed = rest.trim_end_matches(|c: char| !c.is_ascii_alphanumeric());
    trimmed
}

/// Rebuild `key=<redacted>` while preserving the token's trailing punctuation
/// (`token="abc",` → `token=<redacted>,`).
fn redact_assignment(token: &str, sep: usize) -> String {
    let (head, rest) = token.split_at(sep);
    let sep_char = rest.chars().next().unwrap_or('=');
    let trailing: String = token
        .chars()
        .rev()
        .take_while(|c| !c.is_ascii_alphanumeric() && *c != '=' && *c != ':')
        .collect();
    let trailing: String = trailing.chars().rev().collect();
    let value = value_after_separator(token, sep);
    let separator_gap = if value.is_empty() { " " } else { "" };
    format!("{head}{sep_char}{separator_gap}<redacted>{trailing}")
}

/// Consume the tokens that hold a spilled secret value
/// (`Authorization: Bearer eyJ… supplied`). Stops at the first ordinary
/// word, so prose after the header survives.
fn swallow_values(tokens: &[&str], from: usize) -> usize {
    let mut consumed = 0;
    let mut after_bearer = false;
    while consumed < 3 {
        let Some(token) = tokens.get(from + consumed) else {
            break;
        };
        let bare = bare_token(token);
        let is_bearer = bare.eq_ignore_ascii_case("bearer");
        let is_plain_word = bare.chars().all(|c| c.is_ascii_alphabetic()) && bare.len() > 1;
        if !after_bearer && !is_bearer && is_plain_word {
            break;
        }
        after_bearer = is_bearer;
        consumed += 1;
    }
    consumed
}

/// Collapse absolute paths: a user-profile path becomes `~/…`, any other
/// absolute path keeps only its last two components.
fn redact_paths(input: &str) -> String {
    let chars: Vec<char> = input.chars().collect();
    let mut out = String::with_capacity(input.len());
    let mut index = 0;
    while index < chars.len() {
        if is_windows_absolute(&chars, index) {
            let end = scan_path_end(&chars, index + 3);
            out.push_str(&summarize_path(&chars[index..end].iter().collect::<String>()));
            index = end;
            continue;
        }
        if is_posix_home(&chars, index) {
            let end = scan_path_end(&chars, index);
            out.push_str(&summarize_path(&chars[index..end].iter().collect::<String>()));
            index = end;
            continue;
        }
        out.push(chars[index]);
        index += 1;
    }
    out
}

fn is_windows_absolute(chars: &[char], index: usize) -> bool {
    index + 2 < chars.len()
        && chars[index].is_ascii_alphabetic()
        && chars[index + 1] == ':'
        && (chars[index + 2] == '\\' || chars[index + 2] == '/')
}

fn is_posix_home(chars: &[char], index: usize) -> bool {
    let rest: String = chars[index..].iter().take(7).collect();
    rest == "/Users/" || rest == "/home/"
}

fn scan_path_end(chars: &[char], start: usize) -> usize {
    let mut end = start;
    while end < chars.len() && !PATH_TERMINATORS.contains(&chars[end]) {
        end += 1;
    }
    // A trailing separator would make the summary look like a directory
    // that never existed; back off over it.
    while end > start && (chars[end - 1] == '/' || chars[end - 1] == '\\') {
        end -= 1;
    }
    end.max(start)
}

/// `C:\Users\me\a\b.txt` → `~/a/b.txt`; `C:\work\trylo\work\bin` → `…/work/bin`.
fn summarize_path(path: &str) -> String {
    let normalized = path.replace('\\', "/");
    let segments: Vec<&str> = normalized.split('/').filter(|s| !s.is_empty()).collect();
    if let Some(home_index) = segments
        .iter()
        .position(|s| s.eq_ignore_ascii_case("users") || s.eq_ignore_ascii_case("home"))
    {
        // Windows: ["C:", "Users", "me", ...] — skip the profile name.
        // POSIX:   ["", "home", "me", ...] — the leading empty segment was
        // filtered out, so the profile name sits at home_index + 1 too.
        let rest = &segments[(home_index + 2).min(segments.len())..];
        if rest.is_empty() {
            return "~".to_string();
        }
        return format!("~/{}", rest.join("/"));
    }
    if segments.len() <= 2 {
        return normalized;
    }
    format!("…/{}", segments[segments.len() - 2..].join("/"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secret_values_are_redacted_but_keys_survive() {
        assert_eq!(
            sanitize_line("apiKey=sk-live-abcdef123456 supplied"),
            "apiKey=<redacted> supplied"
        );
        assert_eq!(
            sanitize_line("Authorization: Bearer abc.def-123"),
            "Authorization: <redacted>"
        );
        // Prose after a spilled header must survive.
        assert_eq!(
            sanitize_line("Authorization: Bearer abc.def-123 rejected by upstream"),
            "Authorization: <redacted> rejected by upstream"
        );
        assert!(sanitize_line("token leaked sk-abcdefghijk").contains("<redacted>"));
        assert!(!sanitize_line("apiKey=sk-live-abcdef123456").contains("sk-live"));
    }

    #[test]
    fn non_secret_lines_are_untouched() {
        assert_eq!(
            sanitize_line("Error: Cannot find module 'cowork-os'"),
            "Error: Cannot find module 'cowork-os'"
        );
    }

    #[test]
    fn windows_user_paths_collapse_to_home() {
        let out = sanitize_line(r"Cannot read C:\Users\alice\AppData\Local\Trylo\x.json");
        assert!(out.contains("~/AppData/Local/Trylo/x.json"), "{out}");
        assert!(!out.contains("alice"), "{out}");
    }

    #[test]
    fn other_absolute_paths_keep_only_the_tail() {
        let out = sanitize_line(r"missing C:\work\trylo\work\vendor\cowork-os\bin");
        assert!(out.contains("…/cowork-os/bin"), "{out}");
        assert!(!out.contains("D:/CC"), "{out}");
    }

    #[test]
    fn short_paths_are_left_readable() {
        assert_eq!(sanitize_line("open C:/tmp"), "open C:/tmp");
    }

    #[test]
    fn long_lines_are_truncated() {
        let out = sanitize_line(&"x".repeat(500));
        assert_eq!(out.chars().count(), MAX_LINE_CHARS + 1);
        assert!(out.ends_with('…'));
    }

    #[test]
    fn tail_is_bounded_and_drops_blank_lines() {
        let tail = DiagnosticTail::with_limit(3);
        tail.push_chunk("first\n\n   \nsecond\n");
        tail.push("third");
        tail.push("fourth");
        let snapshot = tail.snapshot();
        assert_eq!(snapshot, vec!["second", "third", "fourth"]);
    }

    #[test]
    fn tail_survives_concurrent_writers() {
        let tail = std::sync::Arc::new(DiagnosticTail::with_limit(100));
        let mut handles = Vec::new();
        for worker in 0..8 {
            let clone = std::sync::Arc::clone(&tail);
            handles.push(std::thread::spawn(move || {
                for line in 0..50 {
                    clone.push(&format!("w{worker}-l{line}"));
                }
            }));
        }
        for handle in handles {
            handle.join().unwrap();
        }
        assert_eq!(tail.snapshot().len(), 100);
    }

    #[test]
    fn default_tail_size() {
        let tail = DiagnosticTail::new();
        for line in 0..(DEFAULT_MAX_LINES + 5) {
            tail.push(&format!("line-{line}"));
        }
        assert_eq!(tail.snapshot().len(), DEFAULT_MAX_LINES);
        assert_eq!(tail.snapshot()[0], format!("line-{}", 5));
    }
}
