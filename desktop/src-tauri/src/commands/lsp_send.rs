// Trylo Desktop — lsp_send Tauri command. See ARCHITECTURE.md
// §2.7 + §10.2.

use std::io::Write;

use tauri::State;

use crate::commands::error::{io_error, CommandError};
use crate::commands::lsp_state::LspState;

/// Write one JSON-RPC frame to the server's stdin. The
/// `message` is the full LSP message including the
/// `Content-Length: N\r\n\r\n` header — the protocol is
/// header-framed, and the caller (vscode-jsonrpc) composes
/// headers. Rust only owns the byte transport.
#[tauri::command]
pub async fn lsp_send(
    id: String,
    message: String,
    state: State<'_, LspState>,
) -> Result<(), CommandError> {
    let mut processes = state.processes.lock().map_err(|_| {
        io_error(
            "(lsp)",
            std::io::Error::other("lsp state poisoned".to_string()),
        )
    })?;
    if let Some(proc) = processes.get_mut(&id) {
        proc.writer
            .write_all(message.as_bytes())
            .map_err(|e| io_error("(lsp)", std::io::Error::other(e.to_string())))?;
        proc.writer
            .flush()
            .map_err(|e| io_error("(lsp)", std::io::Error::other(e.to_string())))?;
    }
    Ok(())
}
