// Trylo Desktop — lsp_spawn Tauri command. See the architecture doc
// §2.7 (LspManager) + §10.2 (one Tauri command per file).
//
// Spawns an LSP server child process. The caller passes a Tauri
// Channel<String> for receiving JSON-RPC frames from the server's
// stdout. We spawn a thread that reads the server's stdout line
// by line (LSP servers are line-delimited JSON-RPC) and pushes
// each line into the channel.
//
// Returns an LspHandle with the server's id. The webview holds
// the handle and uses it for subsequent lsp_send / lsp_stop calls.

use std::io::{BufRead, BufReader, Write};
use std::sync::Mutex;

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::State;

use crate::commands::error::{io_error, CommandError};
use crate::commands::lsp_config;
use crate::commands::lsp_state::{LspProcess, LspState};

#[derive(Debug, Serialize)]
pub struct LspHandleDto {
    pub id: String,
    pub language: String,
    pub workspace_root: String,
}

#[tauri::command]
pub async fn lsp_spawn(
    language: String,
    workspace_root: String,
    on_message: Channel<String>,
    state: State<'_, LspState>,
) -> Result<LspHandleDto, CommandError> {
    eprintln!("[rust] lsp_spawn: {language} root={workspace_root}");
    let cfg = lsp_config::lookup(&language).ok_or_else(|| {
        io_error(
            "(lsp)",
            std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                format!("language '{language}' is not registered"),
            ),
        )
    })?;
    if !lsp_config::is_installed(cfg) {
        return Err(io_error(
            "(lsp)",
            std::io::Error::new(
                std::io::ErrorKind::NotFound,
                format!(
                    "'{}' not on PATH — install it or update lsp_config",
                    cfg.command
                ),
            ),
        ));
    }

    let mut command = std::process::Command::new(cfg.command);
    command.args(cfg.args);
    command.current_dir(&workspace_root);
    command.stdin(std::process::Stdio::piped());
    command.stdout(std::process::Stdio::piped());
    command.stderr(std::process::Stdio::null());

    let mut child = command
        .spawn()
        .map_err(|e| io_error("(lsp)", std::io::Error::other(e.to_string())))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| io_error("(lsp)", std::io::Error::other("no stdout from lsp child")))?;
    let writer = child.stdin.take().ok_or_else(|| {
        io_error(
            "(lsp)",
            std::io::Error::other("no stdin handle from lsp child"),
        )
    })?;

    let id = format!("lsp-{}", std::process::id());

    // Read thread: each stdout line is one JSON-RPC frame.
    // Push to the channel; on read error / EOF, exit.
    let channel_for_thread = on_message.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            match line {
                Ok(text) => {
                    if channel_for_thread.send(text).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    state
        .processes
        .lock()
        .map_err(|_| {
            io_error(
                "(lsp)",
                std::io::Error::other("lsp state poisoned".to_string()),
            )
        })?
        .insert(
            id.clone(),
            LspProcess {
                writer: Box::new(MutexWriter::new(Mutex::new(writer))),
                killer: Box::new(move || {
                    let _ = child.kill();
                }),
            },
        );

    Ok(LspHandleDto {
        id,
        language: language.clone(),
        workspace_root,
    })
}

/// Adapter that implements `Write` for a `Mutex<T>` where
/// `T: Write`. Each call to `write_all` or `flush` locks the
/// mutex for the duration of the call. We need this because
/// `LspProcess.writer` is `Box<dyn Write + Send>` but the
/// child process's stdin needs `&mut ChildStdin`, and multiple
/// threads (the spawn future + future `lsp_send` calls) can call
/// it. Same pattern as the PTY module.
struct MutexWriter<W: Write + Send> {
    inner: Mutex<W>,
}

impl<W: Write + Send> MutexWriter<W> {
    fn new(inner: Mutex<W>) -> Self {
        Self { inner }
    }
}

impl<W: Write + Send> Write for MutexWriter<W> {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.inner
            .lock()
            .expect("lsp writer mutex poisoned")
            .write(buf)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.inner
            .lock()
            .expect("lsp writer mutex poisoned")
            .flush()
    }
}
