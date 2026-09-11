// Trylo Desktop — process_stop Tauri command. See the architecture doc
// §2.2 + §3 Phase 2 task #3+#4.

use tauri::State;

use crate::commands::error::{io_error, CommandError};
use crate::commands::process_state::ProcessState;

#[tauri::command]
pub async fn process_stop(id: String, state: State<'_, ProcessState>) -> Result<(), CommandError> {
    let mut processes = state.processes.lock().map_err(|_| {
        io_error(
            "(process)",
            std::io::Error::other("process state poisoned".to_string()),
        )
    })?;
    if let Some(mut proc) = processes.remove(&id) {
        (proc.killer)();
    }
    Ok(())
}
