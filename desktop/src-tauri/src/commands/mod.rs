// Trylo Desktop — Tauri commands module root. See the architecture doc §9
// (commands folder) + §10.2 (one Tauri command per file).
//
// Each submodule is a single Tauri command. This file just re-exports
// them so `lib.rs` can list them in `tauri::generate_handler!`.

pub mod attachment_staging;
pub mod conversation_history;
pub mod diagnostics;
pub mod error;
pub mod git_diff_stats;
pub mod git_file_diff;
pub mod git_snapshot;
pub mod list_dir;
pub mod lsp_config;
pub mod lsp_list;
pub mod lsp_send;
pub mod lsp_spawn;
pub mod lsp_state;
pub mod lsp_stop;
pub mod node_runtime;
pub mod pick_folder;
pub mod process_list;
pub mod process_send;
pub mod process_spawn;
pub mod process_state;
pub mod process_stop;
pub mod pty;
pub mod read_file;
pub mod read_file_bytes;
pub mod scan_tree;
pub mod search;
/// Global shutdown contract — one owner for every sidecar the shell
/// spawned (audit §3.2). Not a Tauri command; called from the app
/// lifecycle hooks in `lib.rs`.
pub mod shutdown;
pub mod servicehost;
pub mod servicehost_state;
pub mod settings;
pub mod stat_file;
pub mod test_connection;
pub mod watch;
pub mod work_host;
pub mod workd;
pub mod workd_state;
pub mod write_file;
pub mod write_file_bytes;
