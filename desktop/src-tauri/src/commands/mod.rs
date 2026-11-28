// Trylo Desktop — Tauri commands module root. See ARCHITECTURE.md §9
// (commands folder) + §10.2 (one Tauri command per file).
//
// Each submodule is a single Tauri command. This file just re-exports
// them so `lib.rs` can list them in `tauri::generate_handler!`.

pub mod attachment_bytes;
pub mod attachment_staging;
mod background_command;
pub mod cli_runtime;
pub mod computer_preview;
pub mod conversation_history;
pub mod diagnostics;
pub mod error;
pub mod git_diff_stats;
pub mod git_file_diff;
pub mod git_snapshot;
pub mod list_dir;
pub mod list_remote_artifacts;
pub mod lsp_config;
pub mod lsp_list;
pub mod lsp_send;
pub mod lsp_spawn;
pub mod lsp_state;
pub mod lsp_stop;
pub mod macos_companion;
pub mod native_browser;
pub mod node_runtime;
#[cfg(windows)]
pub mod pick_folder;
pub mod preview;
pub mod process_close_input;
pub mod process_list;
mod process_output;
pub mod process_recovery;
mod process_recovery_identity;
pub mod process_send;
pub mod process_spawn;
#[cfg(unix)]
pub(crate) mod posix_process_group;
pub mod process_state;
pub mod process_stop;
pub mod process_team_guard;
pub mod process_team_owner;
pub mod process_termination;
pub mod pty;
pub mod quick_look;
pub mod read_file;
pub mod read_file_bytes;
pub mod read_remote_artifact;
pub mod remote_artifact_policy;
pub mod runtime_sessions;
pub mod scan_tree;
pub mod search;
pub mod servicehost;
pub mod servicehost_state;
pub mod servicehost_termination;
pub mod settings;
/// Global shutdown contract — one owner for every sidecar the shell
/// spawned (audit §3.2). Not a Tauri command; called from the app
/// lifecycle hooks in `lib.rs`.
pub mod shutdown;
pub mod stat_file;
pub mod team_runs_storage;
pub mod test_connection;
pub mod watch;
pub mod work_host;
pub mod workspace_root;
pub mod write_file;
pub mod write_file_bytes;
