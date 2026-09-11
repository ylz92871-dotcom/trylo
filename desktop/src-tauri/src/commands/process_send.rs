// Trylo Desktop — process_send Tauri command. See the architecture doc
// §2.2 + §3 Phase 2 task #3+#4.

use std::io::Write;

use tauri::State;

use crate::commands::error::{io_error, CommandError};
use crate::commands::process_state::ProcessState;

/// Write one line of text to the process's stdin. A trailing
/// `\n` is appended if the caller didn't include one — most
/// sidecar protocols (CC CLI's `--output-format stream-json`,
/// Trylo Core's planned JSON-over-stdio) are line-delimited.
#[tauri::command]
pub async fn process_send(
    id: String,
    message: String,
    state: State<'_, ProcessState>,
) -> Result<(), CommandError> {
    let mut processes = state.processes.lock().map_err(|_| {
        io_error(
            "(process)",
            std::io::Error::other("process state poisoned".to_string()),
        )
    })?;
    let proc = processes.get_mut(&id).ok_or_else(|| {
        io_error(
            "(process)",
            std::io::Error::new(
                std::io::ErrorKind::NotFound,
                format!("process '{id}' not found"),
            ),
        )
    })?;
    let mut bytes = message.into_bytes();
    if bytes.last() != Some(&b'\n') {
        bytes.push(b'\n');
    }
    proc.writer
        .write_all(&bytes)
        .map_err(|e| io_error("(process)", std::io::Error::other(e.to_string())))?;
    proc.writer
        .flush()
        .map_err(|e| io_error("(process)", std::io::Error::other(e.to_string())))?;
    Ok(())
}
