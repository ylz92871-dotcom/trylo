// Trylo Desktop — watch Tauri command. See ARCHITECTURE.md §2.6
// (WorkspaceWatcher is an interface) + §3 Phase 0 Day 4.
//
// Rust side: a `notify`-backed watcher. Events stream out via a
// Tauri `Channel<FileChangeEventDto>`. The TS-side
// `TauriChannelWorkspaceWatcher` subscribes to the channel and
// dispatches to per-path subscribers per the WorkspaceWatcher
// interface.
//
// Per arch doc §2.6 the eventual Phase-4 swap is the same Rust
// surface — only the inner mechanism changes (chokidar in JS today,
// notify in Rust Phase 4). The interface is the contract; this
// file is the Rust impl that backs it during the spike.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::commands::error::CommandError;

/// Wire shape streamed to the webview. Mirrors `FileChangeEvent` in
/// `host-adapter/types.ts` (`snake_case` keys today; the spike's TS
/// side reads them as-is — we don't auto-convert for DTOs).
#[derive(Debug, Clone, Serialize)]
pub struct FileChangeEventDto {
    pub kind: String,
    pub path: String,
    /// Set when `kind == "renamed"`; the previous path of the move.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
}

/// Holds the live `notify::RecommendedWatcher`s so they stay alive
/// for the lifetime of the Tauri app. When a watcher is dropped the
/// underlying OS handle is released and no more events fire.
#[derive(Default)]
pub struct WatchersState {
    pub watchers: Mutex<HashMap<String, RecommendedWatcher>>,
}

/// Start a recursive watch on `root`. Events are streamed to the
/// webview via the `on_event` channel. Calling this twice with the
/// same `root` is a no-op for the second call (we keep the first
/// watcher alive).
#[tauri::command]
pub async fn watch(
    root: String,
    on_event: tauri::ipc::Channel<FileChangeEventDto>,
    app: AppHandle,
) -> Result<(), CommandError> {
    let p: &Path = Path::new(&root);
    if !p.exists() {
        return Err(CommandError::Io {
            path: PathBuf::from(&root),
            source: std::io::Error::new(std::io::ErrorKind::NotFound, "watch root does not exist"),
        });
    }

    // Idempotency: if we already have a watcher for this root, just
    // re-attach the channel and return. Cheap path during HMR +
    // StrictMode double-invoke in dev.
    {
        let state: State<'_, WatchersState> = app.state();
        let watchers = state.watchers.lock().unwrap();
        if watchers.contains_key(&root) {
            eprintln!("[rust] watch: already watching {root}, no-op");
            return Ok(());
        }
    }

    // Build the watcher. `notify::recommended_watcher` polls the OS
    // for the best backend (FSEvents on macOS, inotify on Linux,
    // ReadDirectoryChangesW on Windows).
    let channel = on_event.clone();
    let mut watcher: RecommendedWatcher =
        notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            let event = match res {
                Ok(e) => e,
                Err(err) => {
                    eprintln!("[rust] watch: notify error: {err}");
                    return;
                }
            };
            // Map notify's EventKind to our 3-bucket string. notify has
            // more granular kinds (ModifyData, ModifyMetadata, ...);
            // we collapse to "modified" until we have a use for the
            // split. Day 5's EditorBridge can refine.
            let kind = match event.kind {
                notify::EventKind::Create(_) => "created",
                notify::EventKind::Modify(_) => "modified",
                notify::EventKind::Remove(_) => "deleted",
                _ => return, // Access, Other, Any — skip for now
            };
            for path in &event.paths {
                let _ = channel.send(FileChangeEventDto {
                    kind: kind.to_string(),
                    path: path.to_string_lossy().to_string(),
                    old_path: None,
                });
                eprintln!("[rust] watch: {kind} {}", path.display());
            }
        })
        .map_err(|e| CommandError::Io {
            path: p.to_path_buf(),
            source: std::io::Error::other(e.to_string()),
        })?;

    watcher
        .watch(p, RecursiveMode::Recursive)
        .map_err(|e| CommandError::Io {
            path: p.to_path_buf(),
            source: std::io::Error::other(e.to_string()),
        })?;

    // Stash the watcher so it lives as long as the app. Dropping it
    // would release the OS handle and silently stop the watch.
    {
        let state: State<'_, WatchersState> = app.state();
        let mut watchers = state.watchers.lock().unwrap();
        watchers.insert(root.clone(), watcher);
    }

    eprintln!("[rust] watch: started on {root}");
    Ok(())
}

/// Stop the watcher for `root`. The OS handle is released; no more
/// events will fire. Currently unused in the spike (HMR + a full
/// reload release the watcher via app teardown) but the interface
/// is here so the TS side can call it on file close in Phase 1.
#[allow(dead_code)]
#[tauri::command]
pub async fn unwatch(root: String, app: AppHandle) -> Result<(), CommandError> {
    let state: State<'_, WatchersState> = app.state();
    let mut watchers = state.watchers.lock().unwrap();
    if watchers.remove(&root).is_some() {
        eprintln!("[rust] unwatch: stopped {root}");
        Ok(())
    } else {
        Err(CommandError::Io {
            path: PathBuf::from(&root),
            source: std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "no active watcher for this root",
            ),
        })
    }
}
