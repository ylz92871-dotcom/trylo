// Trylo Desktop — resolve_cli_runtime Tauri command (P08 §WP6).
//
// One command that answers "where is the CLI and which Node runs it?"
// using the resource resolver, so the renderer never has to know a
// developer's absolute path.
//
// Before this, `settings.cliPath` defaulted to a hard-coded
// `C:/trylo-cli/cli.js` — a path that exists on exactly one
// machine. A packaged build that reached it would fail to spawn with an
// error that looks like a CLI bug rather than a packaging bug.
//
// The command returns absolute paths (the renderer must hand them to
// `process_spawn`), but it also returns the SOURCE of each resolution so
// diagnostics can report "bundled" / "dev-checkout" without printing the
// private path.

use tauri::Manager;

use crate::commands::error::CommandError;
use crate::commands::node_runtime;

#[derive(Debug, serde::Serialize)]
pub struct CliRuntimeDto {
    /// Absolute path to the CLI entry script, or null when nothing was
    /// found. Null is a REAL answer: the UI must say "CLI not found"
    /// instead of falling back to a guessed path.
    pub cli_script: Option<String>,
    /// `env` | `bundled` | `dev-checkout` | null.
    pub cli_source: Option<String>,
    /// Node interpreter to run the script with.
    pub node_program: String,
    /// `env` | `bundled` | `dev-checkout` | `system-path`.
    pub node_source: String,
}

#[tauri::command]
pub async fn resolve_cli_runtime(app: tauri::AppHandle) -> Result<CliRuntimeDto, CommandError> {
    let resource_dir = app.path().resource_dir().ok();
    let cli = node_runtime::resolve_cli_script(resource_dir.as_deref());
    let node = node_runtime::resolve_node(resource_dir.as_deref());
    Ok(CliRuntimeDto {
        cli_script: cli
            .as_ref()
            .map(|r| r.program.to_string_lossy().to_string()),
        cli_source: cli
            .as_ref()
            .map(|r| r.source.as_str().to_string()),
        node_program: node.program.to_string_lossy().to_string(),
        node_source: node.source.as_str().to_string(),
    })
}
