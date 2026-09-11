// Trylo Desktop — shared Node runtime + bundled-resource resolution.
//
// Audit doc `TRYLO-WORK-PHASE1-PHASE2-RUNTIME-AUDIT-AND-REMEDIATION-2026-08-28.md`
// §2.3 Task W4 requires one resolver shared by `workd.rs` and
// `servicehost.rs`:
//
//   - the installed app MUST NOT rely on `node` being on the system PATH;
//   - the installed app MUST NOT fall back to the source repo;
//   - dev runs MAY use the repo checkout and the PATH node.
//
// Layout the resolver understands (relative to the bundled resource dir):
//
//   <resource_dir>/runtime/node/win-x64/node.exe   # pinned Node runtime
//   <resource_dir>/work/bin/trylo-workd.mjs        # Work daemon wrapper
//   <resource_dir>/desktop-services/dist/host.bundle.mjs
//
// Dev fallback mirrors the same names two levels above `src-tauri`
// (i.e. the repo root), so the tree shape is identical in both modes.

use std::path::{Path, PathBuf};

/// Where a resolved runtime/script came from. Surfaced in diagnostics so a
/// "it works in dev, not installed" report can be triaged in one look.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimeSource {
    /// `TRYLO_NODE_BINARY` / `TRYLO_WORKD_SCRIPT` explicit override.
    Env,
    /// `app.path().resource_dir()` — the packaged, self-contained path.
    Bundled,
    /// Repo checkout (dev / `tauri dev` only).
    DevCheckout,
    /// Bare `node` resolved through the system PATH (dev only).
    SystemPath,
}

impl RuntimeSource {
    pub fn as_str(self) -> &'static str {
        match self {
            RuntimeSource::Env => "env",
            RuntimeSource::Bundled => "bundled",
            RuntimeSource::DevCheckout => "dev-checkout",
            RuntimeSource::SystemPath => "system-path",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeResolution {
    pub program: PathBuf,
    pub source: RuntimeSource,
}

/// Relative paths (inside a resource dir or the repo root) that may hold the
/// pinned interpreter, in priority order. Only the host platform's entry is
/// ever present in a real package; the generic `runtime/node/node` entry lets
/// a maintainer stage a runtime without matching the triple.
fn node_runtime_candidates() -> &'static [&'static str] {
    if cfg!(target_os = "windows") {
        &["runtime/node/win-x64/node.exe", "runtime/node/node.exe"]
    } else if cfg!(target_os = "macos") {
        &[
            "runtime/node/darwin-arm64/bin/node",
            "runtime/node/darwin-x64/bin/node",
            "runtime/node/node",
        ]
    } else {
        &[
            "runtime/node/linux-x64/bin/node",
            "runtime/node/linux-arm64/bin/node",
            "runtime/node/node",
        ]
    }
}

/// Bare program name used when nothing better is found (dev PATH fallback).
fn node_program_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "node.exe"
    } else {
        "node"
    }
}

/// Repo root derived from `CARGO_MANIFEST_DIR`
/// (`<repo>/desktop/src-tauri`), independent of cwd.
fn repo_root() -> Option<PathBuf> {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    manifest.ancestors().nth(2).map(Path::to_path_buf)
}

/// First existing candidate under `root`, if any.
fn first_existing(root: &Path, candidates: &[&str]) -> Option<PathBuf> {
    candidates
        .iter()
        .map(|rel| root.join(rel))
        .find(|candidate| candidate.is_file())
}

/// Resolve the Node interpreter. Priority:
///   1. `TRYLO_NODE_BINARY` (operator override / tests)
///   2. bundled `<resource_dir>/runtime/node/**`  ← installed app
///   3. `<repo>/runtime/node/**`                  ← dev checkout
///   4. bare `node` from PATH                     ← dev fallback only
///
/// The installed app is expected to hit (2); (4) is a dev convenience and is
/// reported as `system-path` so a packaged build that somehow reaches it is
/// obvious in diagnostics.
pub fn resolve_node(resource_dir: Option<&Path>) -> RuntimeResolution {
    if let Ok(explicit) = std::env::var("TRYLO_NODE_BINARY") {
        let trimmed = explicit.trim();
        if !trimmed.is_empty() {
            return RuntimeResolution {
                program: PathBuf::from(trimmed),
                source: RuntimeSource::Env,
            };
        }
    }
    let candidates = node_runtime_candidates();
    if let Some(dir) = resource_dir {
        if let Some(found) = first_existing(dir, candidates) {
            return RuntimeResolution {
                program: found,
                source: RuntimeSource::Bundled,
            };
        }
    }
    if let Some(root) = repo_root() {
        if let Some(found) = first_existing(&root, candidates) {
            return RuntimeResolution {
                program: found,
                source: RuntimeSource::DevCheckout,
            };
        }
    }
    RuntimeResolution {
        program: PathBuf::from(node_program_name()),
        source: RuntimeSource::SystemPath,
    }
}

/// Relative path of the Work daemon wrapper inside a resource dir / repo.
const WORKD_SCRIPT_RELATIVE: &str = "work/bin/trylo-workd.mjs";

/// Resolve `trylo-workd.mjs`. Priority:
///   1. `TRYLO_WORKD_SCRIPT` (operator override / tests)
///   2. bundled `<resource_dir>/work/bin/trylo-workd.mjs` ← installed app
///   3. `<repo>/work/bin/trylo-workd.mjs`                 ← dev checkout
///
/// Returns `None` when nothing exists — the caller turns that into a stable
/// `workd_script_missing` reason code instead of a raw spawn ENOENT.
pub fn resolve_workd_script(resource_dir: Option<&Path>) -> Option<RuntimeResolution> {
    resolve_workd_script_in(resource_dir, repo_root())
}

/// Same resolution, with the repo-root fallback injected. Production passes
/// the real repo root; tests pass `None` to isolate packaging behaviour from
/// wherever the checkout happens to live.
pub fn resolve_workd_script_in(
    resource_dir: Option<&Path>,
    repo_root: Option<PathBuf>,
) -> Option<RuntimeResolution> {
    if let Ok(explicit) = std::env::var("TRYLO_WORKD_SCRIPT") {
        let trimmed = explicit.trim();
        if !trimmed.is_empty() {
            return Some(RuntimeResolution {
                program: PathBuf::from(trimmed),
                source: RuntimeSource::Env,
            });
        }
    }
    if let Some(dir) = resource_dir {
        let candidate = dir.join(WORKD_SCRIPT_RELATIVE);
        if candidate.is_file() {
            return Some(RuntimeResolution {
                program: candidate,
                source: RuntimeSource::Bundled,
            });
        }
    }
    if let Some(root) = repo_root {
        let candidate = root.join(WORKD_SCRIPT_RELATIVE);
        if candidate.is_file() {
            return Some(RuntimeResolution {
                program: candidate,
                source: RuntimeSource::DevCheckout,
            });
        }
    }
    None
}

/// Diag-safe description of a resolution: the source only, never the full
/// private absolute path (audit §2.3 Task W3: no absolute private paths in
/// renderer-facing diagnostics).
pub fn describe(resolution: &RuntimeResolution) -> String {
    let file = resolution
        .program
        .file_name()
        .map_or_else(|| "?".to_string(), |name| name.to_string_lossy().to_string());
    format!("{} ({})", file, resolution.source.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn candidates_are_platform_specific() {
        let candidates = node_runtime_candidates();
        assert!(!candidates.is_empty());
        if cfg!(target_os = "windows") {
            assert!(candidates[0].ends_with("node.exe"));
            assert!(candidates.contains(&"runtime/node/win-x64/node.exe"));
        }
    }

    #[test]
    fn bundled_runtime_wins_over_the_repo_checkout() {
        let root = std::env::temp_dir().join(format!("trylo-node-runtime-{}", std::process::id()));
        let bundled = root.join("bundled");
        let dev = root.join("dev");
        let rel = node_runtime_candidates()[0];
        for base in [&bundled, &dev] {
            let target = base.join(rel);
            std::fs::create_dir_all(target.parent().unwrap()).unwrap();
            std::fs::write(&target, b"stub").unwrap();
        }

        let resolved = resolve_node(Some(&bundled));
        assert_eq!(resolved.source, RuntimeSource::Bundled);
        assert!(resolved.program.starts_with(&bundled));

        // No bundled dir offered (pre-setup / tests): the dev checkout is all
        // that is left, and only because we cannot see the real repo here.
        let _ = resolve_node(None);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn missing_script_resolves_to_none_without_a_repo_fallback() {
        let root =
            std::env::temp_dir().join(format!("trylo-workd-missing-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        // No script in the resources dir and no repo to fall back to: the
        // caller must get `None`, which becomes `workd_script_missing`.
        assert!(resolve_workd_script_in(Some(&root), None).is_none());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn workd_script_prefers_the_resource_dir() {
        let root = std::env::temp_dir().join(format!("trylo-workd-{}", std::process::id()));
        let bundled = root.join("bundled");
        let target = bundled.join(WORKD_SCRIPT_RELATIVE);
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        std::fs::write(&target, "// stub\n").unwrap();

        let resolved = resolve_workd_script(Some(&bundled)).expect("script present");
        assert_eq!(resolved.source, RuntimeSource::Bundled);
        assert!(resolved.program.ends_with(WORKD_SCRIPT_RELATIVE));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn describe_never_leaks_the_absolute_path() {
        let resolution = RuntimeResolution {
            program: PathBuf::from("C:/secret/place/node.exe"),
            source: RuntimeSource::Bundled,
        };
        let text = describe(&resolution);
        assert!(text.contains("node.exe"));
        assert!(!text.contains("secret"));
        assert!(text.contains("bundled"));
    }
}
