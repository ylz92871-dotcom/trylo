// Trylo Desktop — Process shared state. See ARCHITECTURE.md §2.2
// (Tauri IPC) + §3 Phase 2 task #3+#4 (Trylo Core subprocess +
// CC CLI channel).
//
// The Trylo React app spawns long-running sidecar processes
// (Trylo Core, CC CLI, future Hermes) via the Rust shell. Each
// process has:
//   - a writer half (stdin): the React app sends prompts
//   - a killer closure: the React app or the shell can stop it
//   - a process id: the React app holds this and routes requests
//     through it
//
// The map is wrapped in an `Arc` so the per-process reaper thread
// (spawned by process_spawn) can remove its own entry when the
// child exits — the exit watcher is the only true owner of the
// child, and it must be able to clean the table from off the
// Tauri command's future.

use std::collections::HashMap;
use std::io;
use std::sync::{Arc, Mutex};

mod input_control;
mod stop_control;
pub use input_control::ProcessInputControl;
#[cfg(test)]
pub(crate) mod test_input;
pub use stop_control::ProcessStopControl;
#[cfg(test)]
pub use stop_control::ProcessStopState;

/// The run metadata the React supervisor attaches to a spawn
/// (spec CODE-WORK-NEXT-STAGE-ARCHITECTURE §2.2). Not used for
/// identity — `id` is the unique handle — but surfaced by
/// `process_list` so diagnostics can attribute a live child to
/// its project / conversation / run.
#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct ProcessMetadata {
    pub project_key: Option<String>,
    pub conversation_id: Option<String>,
    pub run_id: Option<String>,
}

pub struct ProcessEntry {
    /// P08 §4.2: stdin has its own owner. Closing it delivers EOF without
    /// disarming Stop or blocking other registrations on input IO.
    pub input: Arc<ProcessInputControl>,
    /// Terminates the child process *tree*. On Windows this is
    /// `taskkill /T /F` by pid (the audit requires "终止正确进程
    /// 树，避免仅关闭 stdin"); elsewhere a `kill -KILL`. The
    /// reaper thread owns the `Child`, so the killer acts on the
    /// OS pid and lets `child.wait()` observe the exit.
    pub stop: Arc<ProcessStopControl>,
    /// Human-readable label, e.g. "trylo-core", "cc-cli".
    pub label: String,
    /// OS pid of the spawned child (for taskkill / diagnostics).
    pub pid: u32,
    /// Optional debug attribution (project / conversation / run).
    pub metadata: ProcessMetadata,
}

#[derive(Default, Clone)]
pub struct ProcessState {
    pub processes: Arc<Mutex<HashMap<String, ProcessEntry>>>,
    pub recovery: Arc<Mutex<super::process_recovery::RecoveryStore>>,
}

impl ProcessState {
    pub fn input_for(&self, id: &str) -> io::Result<Arc<ProcessInputControl>> {
        let table = self
            .processes
            .lock()
            .map_err(|_| io::Error::other("process state poisoned"))?;
        table
            .get(id)
            .map(|entry| Arc::clone(&entry.input))
            .ok_or_else(|| {
                io::Error::new(io::ErrorKind::NotFound, format!("process '{id}' not found"))
            })
    }
}
