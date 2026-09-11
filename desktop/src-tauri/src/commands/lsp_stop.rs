// Trylo Desktop — lsp_stop Tauri command. See the architecture doc
// §2.7 + §10.2.

use tauri::State;

use crate::commands::error::{io_error, CommandError};
use crate::commands::lsp_state::LspState;

#[tauri::command]
pub async fn lsp_stop(id: String, state: State<'_, LspState>) -> Result<(), CommandError> {
    let mut processes = state.processes.lock().map_err(|_| {
        io_error(
            "(lsp)",
            std::io::Error::other("lsp state poisoned".to_string()),
        )
    })?;
    if let Some(mut proc) = processes.remove(&id) {
        (proc.killer)();
    }
    Ok(())
}
