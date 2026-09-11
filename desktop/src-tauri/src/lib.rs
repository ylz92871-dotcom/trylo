// Trylo Desktop — Tauri 2 lib entry. See the architecture doc §2 (architecture)
// and §3 Phase 0 Day 1 (this file's scope).
//
// Day 3: register the file system commands so the React side can read
// real files via HostAdapter → invoke(). Day 4: register the watch
// command so the webview can subscribe to filesystem change events
// streamed from the Rust `notify` watcher. The command list grows as
// later days add more (git, process, lsp, pty, search). Per §10.2
// each command lives in its own file under `src-tauri/src/commands/`.

mod commands;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
// `run` deliberately panics if the Tauri app fails to bootstrap.
#[allow(clippy::missing_panics_doc)]
pub fn run() {
    tauri::Builder::default()
        // v1.15.7: native folder picker via the official
        // tauri-plugin-dialog. The plugin must be
        // initialized before generate_handler!.
        .plugin(tauri_plugin_dialog::init())
        // Phase 2: clipboard plugin for the Work sub-app's
        // "Copy path" action on artifact cards.
        .plugin(tauri_plugin_clipboard_manager::init())
        // .plugin(tauri_plugin_dialog::init())  # Phase 3 — re-enable
        //                                              when the crate is
        //                                              available locally.
        .setup(|app| {
            // Day 4: register the watcher state so the watch command
            // can stash live `RecommendedWatcher`s and keep them alive
            // for the lifetime of the app. The map is keyed by the
            // root path (one watcher per root; repeat calls are a
            // no-op per the watch() implementation).
            app.manage(commands::watch::WatchersState::default());
            // Week 2 Day 1: register the PTY state so pty_spawn
            // can stash the writer + killer of each spawned shell.
            app.manage(commands::pty::PtyState::default());
            // Week 4: register the LSP state for the same reason
            // (per-process writer + killer map).
            app.manage(commands::lsp_state::LspState::default());
            // Phase 1 #8 (Settings): per-workspace settings cache.
            app.manage(commands::settings::SettingsState::default());
            // Phase 2 (Trylo Alpha, arch §3): ProcessState for
            // Trylo Core + CC CLI sidecars.
            app.manage(commands::process_state::ProcessState::default());
            // Work sub-app (trylo-workd Node sidecar). See
            // ../../../work/README.md. The daemon is spawned
            // lazily by the renderer via workd_spawn; this
            // just registers the state slot.
            app.manage(commands::workd_state::WorkdState::default());
            // Desktop Services host (desktop-services Node sidecar).
            // NDJSON stdio; state slot only, spawned lazily by the
            // renderer via servicehost_spawn. See
            // docs/TRYLO-MIGRATION-EXECUTION-SPEC-2026-08-28.md §5.
            app.manage(commands::servicehost_state::ServiceHostState::default());
            Ok(())
        })
        .on_window_event(|window, event| {
            // Audit §3.2 SH-P1-2: on window close, run the ONE global
            // teardown. It covers every sidecar the shell owns — the
            // previous inline loop only reached `ProcessState` and the
            // service host, leaking PTYs, LSP servers and workd.
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                let report = commands::shutdown::shutdown_all(window.app_handle());
                if !report.was_clean() {
                    eprintln!(
                        "[trylo] window-close teardown: processes={} ptys={} lsps={} workd={}",
                        report.processes, report.ptys, report.lsps, report.workd
                    );
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::read_file::read_file,
            commands::conversation_history::conversation_history_load,
            commands::conversation_history::conversation_history_save,
            commands::read_file_bytes::read_file_bytes,
            commands::write_file::write_file,
            commands::write_file_bytes::write_file_bytes,
            commands::stat_file::stat_file,
            commands::list_dir::list_dir,
            commands::watch::watch,
            commands::watch::unwatch,
            commands::search::search,
            commands::pty::pty_spawn,
            commands::pty::pty_write,
            commands::pty::pty_resize,
            commands::pty::pty_kill,
            commands::git_snapshot::git_snapshot,
            commands::git_file_diff::git_file_diff,
            commands::git_diff_stats::git_diff_stats,
            commands::scan_tree::scan_tree,
            commands::lsp_spawn::lsp_spawn,
            commands::lsp_send::lsp_send,
            commands::lsp_stop::lsp_stop,
            commands::lsp_list::lsp_list,
            commands::settings::get_settings,
            commands::settings::set_settings,
            commands::process_spawn::process_spawn,
            commands::process_send::process_send,
            commands::process_stop::process_stop,
            commands::process_list::process_list,
            commands::test_connection::test_connection,
            commands::pick_folder::pick_folder,
            // Work sub-app sidecar (trylo-workd). See
            // ../../../work/README.md for the daemon's
            // protocol and STRUCTURE.md for the fork plan.
            commands::workd::workd_spawn,
            commands::workd::workd_stop,
            commands::workd::workd_status,
            commands::workd::workd_diagnostics,
            // Work sub-app host commands. See
            // commands/work_host.rs and
            // ../../../work/src/host-adapter/host-adapter.ts
            // for the contract.
            commands::work_host::work_host_open_file,
            commands::work_host::work_host_open_file_with_app,
            commands::work_host::work_host_show_in_folder,
            commands::work_host::work_host_copy_to_clipboard,
            // P2-1 Work Package B: Work attachment staging.
            // External files are copied into the workspace's
            // .trylo/attachments area; the renderer only ever
            // projects the workspace-relative descriptor path.
            commands::attachment_staging::stage_attachment,
            commands::attachment_staging::remove_conversation_attachments,
            commands::attachment_staging::remove_project_attachments,
            // Desktop Services host (NDJSON stdio sidecar). See
            // docs/TRYLO-MIGRATION-EXECUTION-SPEC-2026-08-28.md §5.
            commands::servicehost::servicehost_spawn,
            commands::servicehost::servicehost_send,
            commands::servicehost::servicehost_stop,
            commands::servicehost::servicehost_status,
            commands::servicehost::servicehost_paths,
            commands::servicehost::servicehost_diagnostics,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        // Audit §3.2 SH-P1-2 — the exit path. `CloseRequested` only fires
        // when a window is closed; a quit from the menu, a `RunEvent::Exit`
        // after the webview crashed, or an OS shutdown can reach the exit
        // event WITHOUT ever closing a window. Teardown therefore also runs
        // here, and `shutdown_all` is idempotent so the double call is free.
        .run(|app_handle, event| {
            match event {
                // Desktop only: the last window closed and the app is about
                // to quit. Cleanup happens here AND on window close; the
                // teardown is idempotent, so the second call is a no-op that
                // only guards the paths where no window was ever closed
                // (menu quit, `app.exit()` from the renderer, OS shutdown).
                // Desktop only: the last window closed and the app is about
                // to quit. Cleanup happens here AND on window close; the
                // teardown is idempotent, so the second call is a no-op that
                // only guards the paths where no window was ever closed
                // (menu quit, `app.exit()` from the renderer, OS shutdown).
                //
                // `Exit` is the final safety net — the event loop is
                // finishing, so whatever is still registered dies here or
                // becomes an orphan.
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => {
                    let report = commands::shutdown::shutdown_all(app_handle);
                    if !report.was_clean() {
                        eprintln!(
                            "[trylo] exit teardown: processes={} ptys={} lsps={} workd={}",
                            report.processes, report.ptys, report.lsps, report.workd
                        );
                    }
                }
                _ => {}
            }
        });
}
