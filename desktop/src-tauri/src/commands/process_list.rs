// Trylo Desktop — process_list Tauri command. See the architecture doc
// §2.2 + §3 Phase 2 task #3+#4.
//
// Lists live processes. Only returns rows still present in the
// table — the reaper thread removes a row the moment its child
// exits, so a child that died always disappears from this list
// (no fake-lively entries, spec §5.3 #5/#6).

use serde::Serialize;
use tauri::State;

use crate::commands::error::{io_error, CommandError};
use crate::commands::process_state::{ProcessMetadata, ProcessState};

#[derive(Debug, Serialize)]
pub struct ProcessInfoDto {
    pub id: String,
    pub label: String,
    pub pid: u32,
    pub metadata: ProcessMetadata,
}

#[tauri::command]
pub async fn process_list(
    state: State<'_, ProcessState>,
) -> Result<Vec<ProcessInfoDto>, CommandError> {
    let processes = state.processes.lock().map_err(|_| {
        io_error(
            "(process)",
            std::io::Error::other("process state poisoned".to_string()),
        )
    })?;
    Ok(processes
        .iter()
        .map(|(id, entry)| ProcessInfoDto {
            id: id.clone(),
            label: entry.label.clone(),
            pid: entry.pid,
            metadata: entry.metadata.clone(),
        })
        .collect())
}
