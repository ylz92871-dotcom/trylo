// Trylo Desktop — Tauri 2 lib entry. See ARCHITECTURE.md §2 (architecture)
// and §3 Phase 0 Day 1 (this file's scope).
//
// Day 3: register the file system commands so the React side can read
// real files via HostAdapter → invoke(). Day 4: register the watch
// command so the webview can subscribe to filesystem change events
// streamed from the Rust `notify` watcher. The command list grows as
// later days add more (git, process, lsp, pty, search). Per §10.2
// each command lives in its own file under `src-tauri/src/commands/`.

mod commands;
mod macos_shell;
mod preview;
mod window_state;

use tauri::Manager;

fn teardown_app(app_handle: &tauri::AppHandle, origin: &str) {
    #[cfg(target_os = "macos")]
    app_handle.state::<commands::quick_look::QuickLookState>().close();
    if let Some(preview) = app_handle.get_webview_window("computer-preview") {
        let _ = preview.close();
    }
    commands::native_browser::close_owned_popups(app_handle);
    let report = commands::shutdown::shutdown_all(app_handle);
    if !report.was_clean() {
        eprintln!(
            "[trylo] {origin} teardown: processes={} ptys={} lsps={}",
            report.processes, report.ptys, report.lsps
        );
    }
}

fn on_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    #[cfg(target_os = "macos")]
    macos_shell::on_window_event(window, event);

    let tauri::WindowEvent::CloseRequested { api, .. } = event else {
        return;
    };
    if window.label() != "main" {
        return;
    }

    #[cfg(target_os = "macos")]
    {
        // Keep background tasks and local services alive when closing the main window;
        // clicking the Dock icon restores it and Cmd+Q runs full teardown.
        api.prevent_close();
        window.app_handle().state::<window_state::WindowStateManager>().flush();
        let _ = window.hide();
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = api;
        // Main-close owns application exit even when hidden native resources remain.
        // Request the normal Tauri exit path after the existing child teardown.
        teardown_app(window.app_handle(), "window-close");
        window.app_handle().exit(0);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
// `run` deliberately panics if the Tauri app fails to bootstrap.
// The IPC registrations form one manifest so the label gate covers every command.
#[allow(clippy::missing_panics_doc, clippy::too_many_lines)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(target_os = "macos")]
    let builder = macos_shell::configure_builder(builder);
    #[cfg(not(target_os = "macos"))]
    let builder = builder
        .register_asynchronous_uri_scheme_protocol("trylo-preview", |context, request, responder| {
            let app = context.app_handle().clone();
            let label = context.webview_label().to_string();
            tauri::async_runtime::spawn_blocking(move || {
                let state = app.state::<preview::web::WebPreviewState>();
                responder.respond(state.serve(&request, &label));
            });
        });
    builder
        .register_asynchronous_uri_scheme_protocol("trylo-media", |context, request, responder| {
            let app = context.app_handle().clone();
            let label = context.webview_label().to_string();
            tauri::async_runtime::spawn_blocking(move || {
                responder.respond(app.state::<preview::media::MediaState>().serve(&request, &label));
            });
        })
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
            app.manage(commands::computer_preview::PreviewState::default());
            app.manage(commands::quick_look::QuickLookState::default());
            #[cfg(not(target_os = "macos"))]
            app.manage(commands::native_browser::NativeBrowserState::default());
            app.manage(preview::web::WebPreviewState::default());
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
            app.manage(commands::runtime_sessions::RuntimeSessionsState::default());
            let preview_cache = app.path().app_cache_dir()
                .unwrap_or_else(|_| std::env::temp_dir())
                .join("preview/office");
            let office_engine = app.path().resource_dir()?.join("preview/office");
            #[cfg(debug_assertions)]
            let office_engine = std::env::var_os("TRYLO_PREVIEW_ENGINE_ROOT").map_or(office_engine, std::path::PathBuf::from);
            app.manage(commands::preview::office::OfficePreviewState::bundled(preview_cache, office_engine));
            let media_cache = app.path().app_cache_dir().unwrap_or_else(|_| std::env::temp_dir()).join("preview/media");
            let media_engine = app.path().resource_dir()?.join("preview/media");
            #[cfg(debug_assertions)]
            let media_engine = std::env::var_os("TRYLO_MEDIA_ENGINE_ROOT").map_or(media_engine, std::path::PathBuf::from);
            app.manage(preview::media::MediaState::new(media_cache, media_engine));
            // Desktop Services host (desktop-services Node sidecar).
            // NDJSON stdio; state slot only, spawned lazily by the
            // renderer via servicehost_spawn. See
            // docs/TRYLO-MIGRATION-EXECUTION-SPEC-2026-08-28.md §5.
            app.manage(commands::servicehost_state::ServiceHostState::default());
            app.manage(window_state::WindowStateManager::default());

            #[cfg(target_os = "macos")]
            macos_shell::setup(app.handle())?;

            Ok(())
        })
        .on_window_event(on_window_event)
        .invoke_handler(|invoke| {
            // Remote browser contents also lack application-defined commands,
            // including after they navigate to a locally trusted URL.
            if !commands::native_browser::allows_application_ipc(
                invoke.message.webview_ref().label(),
            ) {
                invoke.resolver.reject("浏览器网页无权调用应用接口");
                return true;
            }
            let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
                commands::native_browser::native_browser_command,
                commands::computer_preview::computer_preview_open,
                commands::computer_preview::computer_preview_publish,
                commands::computer_preview::computer_preview_subscribe,
                commands::read_file::read_file,
                commands::conversation_history::conversation_history_load,
                commands::conversation_history::conversation_history_save,
                commands::runtime_sessions::runtime_sessions_load,
                commands::runtime_sessions::runtime_sessions_save,
                commands::read_file_bytes::read_file_bytes,
                commands::read_remote_artifact::read_remote_artifact,
                commands::list_remote_artifacts::list_remote_artifacts,
                commands::preview::office::preview_office,
                commands::preview::office::preview_office_cancel,
                commands::preview::resource::preview_resource,
                commands::preview::resource::preview_media_path,
                commands::preview::media::preview_media_open,
                commands::preview::media::preview_media_close,
                commands::preview::resource::preview_text,
                commands::preview::resource::preview_head,
                commands::preview::web::preview_web_open,
                commands::preview::web::preview_web_layout,
                commands::preview::web::preview_web_close,
                commands::preview::web::preview_web_status,
                commands::preview::resource::preview_binary,
                commands::preview::codecs::preview_codec_paths,
                commands::write_file::write_file,
                commands::write_file_bytes::write_file_bytes,
                commands::stat_file::stat_file,
                commands::list_dir::list_dir,
                commands::watch::watch,
                commands::watch::unwatch,
                commands::search::search,
                commands::quick_look::quick_look_open,
                commands::pty::pty_spawn,
                commands::pty::pty_status,
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
                commands::settings::default_workspace_root,
                commands::settings::set_settings,
                // P08 §WP6: CLI/Node resolved from the resource dir, never
                // a developer absolute path.
                commands::cli_runtime::resolve_cli_runtime,
                commands::process_spawn::process_spawn,
                commands::process_send::process_send,
                // P08 §4.2: close stdin without killing the process — the new
                // CLI's `run` only starts after EOF.
                commands::process_close_input::process_close_input,
                commands::process_stop::process_stop,
                commands::process_list::process_list,
                commands::process_recovery::process_recovery_list,
                commands::process_recovery::process_read_output,
                commands::process_team_owner::process_team_owner_status,
                commands::team_runs_storage::team_runs_load,
                commands::team_runs_storage::team_runs_save,
                commands::test_connection::test_connection,
                #[cfg(windows)]
                commands::pick_folder::pick_folder,
                commands::work_host::work_host_open_file,
                commands::work_host::work_host_open_file_with_app,
                commands::work_host::work_host_show_in_folder,
                commands::work_host::work_host_copy_to_clipboard,
                // P2-1 Work Package B: Work attachment staging.
                // External files are copied into the workspace's
                // .trylo/attachments area; the renderer only ever
                // projects the workspace-relative descriptor path.
                commands::attachment_staging::stage_attachment,
                commands::attachment_bytes::stage_attachment_bytes,
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
                macos_shell::set_window_theme,
                macos_shell::set_native_window_title,
                macos_shell::toggle_window_zoom,
                macos_shell::set_dock_attention,
                macos_shell::show_native_context_menu,
                macos_shell::reveal_workspace_directory,
            ];
            handler(invoke)
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        // Audit §3.2 SH-P1-2 — the exit path. `CloseRequested` only fires
        // when a window is closed; a quit from the menu, a `RunEvent::Exit`
        // after the webview crashed, or an OS shutdown can reach the exit
        // event WITHOUT ever closing a window. Teardown therefore also runs
        // here, and `shutdown_all` is idempotent so the double call is free.
        .run(|app, event| on_run_event(app, &event));
}

fn on_run_event(app_handle: &tauri::AppHandle, event: &tauri::RunEvent) {
    #[cfg(target_os = "macos")]
    if let tauri::RunEvent::Reopen {
        has_visible_windows: false,
        ..
    } = event
    {
        macos_shell::restore_main_window(app_handle);
        return;
    }

    // Closing the last window and explicit/OS exit share the idempotent
    // native owner. WebView reload never enters this shutdown path.
    if matches!(
        event,
        tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
    ) {
        app_handle.state::<window_state::WindowStateManager>().flush();
        teardown_app(app_handle, "exit");
    }
}
