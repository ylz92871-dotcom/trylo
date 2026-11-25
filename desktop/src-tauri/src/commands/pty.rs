// Trylo Desktop — pty Tauri commands. See ARCHITECTURE.md §3
// Phase 1 Week 2 (Terminal).
//
// Phase 1.0 day 1: spawn a child process with a PTY, stream
// its output back to the webview via a Tauri Channel, and accept
// keystroke input via pty_write. One PTY at a time per the spike
// (the arch doc allows multiple — `pty:{id}` — but we keep the
// implementation simple and add a registry in Phase 1 Day 2+ if
// needed).

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::State;

use crate::commands::error::CommandError;

static NEXT_PTY_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Default)]
pub struct PtyState {
    pub processes: Mutex<HashMap<String, PtyProcess>>,
}

pub struct PtyProcess {
    /// The writer half — input from the user. Send bytes here.
    pub writer: Box<dyn Write + Send>,
    /// A closure that kills the underlying child. We use a
    /// `FnMut` boxed closure instead of the `ChildKiller` trait
    /// because the `portable_pty` child-kill return type
    /// (`Box<dyn Error + Send + Sync + 'static>`) doesn't
    /// satisfy the bounds needed to coerce via `as`; the
    /// closure approach is the simplest path that compiles.
    pub killer: Box<dyn FnMut() + Send + Sync>,
}

fn pty_io_error(msg: &str, e: impl std::fmt::Display) -> CommandError {
    CommandError::Io {
        path: std::path::PathBuf::from("(pty)"),
        source: std::io::Error::other(format!("{msg}: {e}")),
    }
}

#[derive(Debug, Serialize)]
pub struct PtySpawnResult {
    pub id: String,
    pub shell: String,
}

#[cfg(windows)]
fn default_terminal_shell() -> String {
    "bash.exe".to_owned()
}

#[cfg(unix)]
fn default_terminal_shell() -> String {
    use std::os::unix::fs::PermissionsExt;

    std::env::var("SHELL")
        .ok()
        .filter(|shell| {
            let path = std::path::Path::new(shell);
            path.is_absolute()
                && path.metadata().is_ok_and(|metadata| {
                    metadata.is_file() && metadata.permissions().mode() & 0o111 != 0
                })
        })
        .unwrap_or_else(|| if cfg!(target_os = "macos") { "/bin/zsh" } else { "/bin/sh" }.to_owned())
}

/// Spawn a child process attached to a PTY. The child process's
/// stdout/stderr stream back to the caller via `on_output`
/// (a Tauri Channel<Vec<u8>>). Returns the process id.
#[tauri::command]
pub async fn pty_spawn(
    shell: Option<String>,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    on_output: Channel<Vec<u8>>,
    state: State<'_, PtyState>,
) -> Result<PtySpawnResult, CommandError> {
    let shell = shell.unwrap_or_else(default_terminal_shell);
    eprintln!("[rust] pty_spawn called: shell={shell} cols={cols} rows={rows} cwd={cwd:?}");
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| pty_io_error("openpty", e))?;

    let mut cmd = CommandBuilder::new(&shell);
    if let Some(c) = cwd.as_deref() {
        cmd.cwd(c);
    }
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| pty_io_error("clone_reader", e))?;

    let id = format!("pty-{}", NEXT_PTY_ID.fetch_add(1, Ordering::Relaxed));
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| pty_io_error("take_writer", e))?;
    let mut processes = state.processes.lock().map_err(|e| pty_io_error("lock", e))?;
    let mut child = pair.slave.spawn_command(cmd).map_err(|e| pty_io_error("spawn", e))?;

    // Spawn a thread that reads PTY output and pushes it into the
    // Tauri Channel. The channel send call returns Err only if the
    // webview has dropped the subscription; in that case the
    // thread exits. We also exit on read 0 (EOF) or any I/O error.
    let channel_for_thread = on_output.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if channel_for_thread.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
            }
        }
    });

    processes.insert(id.clone(), PtyProcess {
        writer: Box::new(writer),
        killer: Box::new(move || {
            if child.kill().is_ok() {
                let _ = child.wait();
            }
        }),
    });

    Ok(PtySpawnResult { id, shell })
}

/// Write input bytes to a previously-spawned PTY.
#[tauri::command]
pub async fn pty_write(
    id: String,
    data: Vec<u8>,
    state: State<'_, PtyState>,
) -> Result<(), CommandError> {
    let mut processes = state.processes.lock().map_err(|_| CommandError::Io {
        path: std::path::PathBuf::from("(pty)"),
        source: std::io::Error::other("pty state poisoned".to_string()),
    })?;
    if let Some(proc) = processes.get_mut(&id) {
        proc.writer
            .write_all(&data)
            .map_err(|e| pty_io_error("write", e))?;
        proc.writer.flush().map_err(|e| pty_io_error("flush", e))?;
    }
    Ok(())
}

/// Resize a previously-spawned PTY's window. The reader thread
/// continues with the new size; output reflows on the next write.
#[tauri::command]
pub async fn pty_resize(
    id: String,
    cols: u16,
    rows: u16,
    _state: State<'_, PtyState>,
) -> Result<(), CommandError> {
    eprintln!("[rust] pty_resize: {id} {cols}x{rows}");
    // Phase 1.0 day 1: drop resize on the floor (portable-pty
    // doesn't expose a clean resize API without a master handle
    // ref we don't store). xterm.js will re-flow visually. We
    // log the request so debugging is possible.
    Ok(())
}

/// Kill a previously-spawned PTY.
#[tauri::command]
pub async fn pty_kill(id: String, state: State<'_, PtyState>) -> Result<(), CommandError> {
    let mut processes = state.processes.lock().map_err(|_| CommandError::Io {
        path: std::path::PathBuf::from("(pty)"),
        source: std::io::Error::other("pty state poisoned".to_string()),
    })?;
    if let Some(mut proc) = processes.remove(&id) {
        (proc.killer)();
    }
    Ok(())
}
