// Trylo Desktop — Language server configurations. See
// the architecture doc §2.7. One entry per supported language.
//
// Spike scope: TypeScript only. The other 4 languages (Python,
// C/C++, Rust, Go) are config additions — no code change needed,
// the LspManager is generic over `LspServerConfig`. We document
// them so adding one is a single-line edit here + a runtime
// check on `which` for the binary.

use std::path::Path;

#[derive(Debug, Clone)]
pub struct LspServerConfig {
    pub command: &'static str,
    pub args: &'static [&'static str],
    /// Default args that receive `workspace_root` and a file path.
    /// Kept simple for the spike; real implementations have
    /// richer init sequences (initializationOptions etc.).
    pub language_id: &'static str,
    pub extensions: &'static [&'static str],
}

/// All five languages per arch doc §2.7. Resolved at
/// `lsp_spawn` time: if the binary isn't on PATH, `lsp_spawn`
/// returns a `CommandError::LspNotInstalled`.
const TYPESCRIPT: LspServerConfig = LspServerConfig {
    command: "typescript-language-server",
    args: &["--stdio"],
    language_id: "typescript",
    extensions: &[".ts", ".tsx", ".js", ".jsx"],
};

const PYTHON: LspServerConfig = LspServerConfig {
    command: "pyright-langserver",
    args: &["--stdio"],
    language_id: "python",
    extensions: &[".py"],
};

const C_CPP: LspServerConfig = LspServerConfig {
    command: "clangd",
    args: &["--stdio"],
    language_id: "cpp",
    extensions: &[".c", ".cc", ".cpp", ".cxx", ".h", ".hpp"],
};

const RUST: LspServerConfig = LspServerConfig {
    command: "rust-analyzer",
    args: &["--stdio"],
    language_id: "rust",
    extensions: &[".rs"],
};

const GO: LspServerConfig = LspServerConfig {
    command: "gopls",
    args: &["-mode=stdio"],
    language_id: "go",
    extensions: &[".go"],
};

/// Look up the config for a language id. Returns None if the
/// language is not in the registry.
pub fn lookup(language: &str) -> Option<&'static LspServerConfig> {
    let configs: &[&LspServerConfig] = &[&TYPESCRIPT, &PYTHON, &C_CPP, &RUST, &GO];
    configs.iter().copied().find(|c| c.language_id == language)
}

/// All available languages. The order here is the order
/// `availableLanguages()` returns.
pub fn all() -> &'static [&'static LspServerConfig] {
    &[&TYPESCRIPT, &PYTHON, &C_CPP, &RUST, &GO]
}

/// Check whether a binary exists on PATH. The spike doesn't
/// download or install language servers; we just surface a
/// clear error if the binary is missing.
pub fn is_installed(cfg: &LspServerConfig) -> bool {
    // Use `where` (Windows) or `which` (Unix). For the spike we
    // just check both — `where` ships with Windows; `which` is
    // in Git Bash. Both return 0 on success.
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("where")
            .arg(cfg.command)
            .output()
            .is_ok_and(|o| o.status.success())
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::process::Command::new("which")
            .arg(cfg.command)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }
}

/// Choose the right config for a path based on its extension.
/// Returns the first config whose extensions list contains the
/// file's extension. (Reserved for Phase 3 — currently
/// `lsp_spawn` looks up by language id instead.)
#[allow(dead_code)]
pub fn for_path(path: &Path) -> Option<&'static LspServerConfig> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    for c in all().iter().copied() {
        for supported in c.extensions {
            if supported.trim_start_matches('.') == ext {
                return Some(c);
            }
        }
    }
    None
}
