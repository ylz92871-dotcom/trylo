// Trylo Desktop — Process shared state. See the architecture doc §2.2
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
use std::io::Write;
use std::sync::{Arc, Mutex};

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
    pub writer: Box<dyn Write + Send>,
    /// Terminates the child process *tree*. On Windows this is
    /// `taskkill /T /F` by pid (the audit requires "终止正确进程
    /// 树，避免仅关闭 stdin"); elsewhere a `kill -KILL`. The
    /// reaper thread owns the `Child`, so the killer acts on the
    /// OS pid and lets `child.wait()` observe the exit.
    pub killer: Box<dyn FnMut() + Send + Sync>,
    /// Human-readable label, e.g. "trylo-core", "cc-cli".
    pub label: String,
    /// OS pid of the spawned child (for taskkill / diagnostics).
    pub pid: u32,
    /// Optional debug attribution (project / conversation / run).
    pub metadata: ProcessMetadata,
}

#[derive(Default)]
pub struct ProcessState {
    pub processes: Arc<Mutex<HashMap<String, ProcessEntry>>>,
}
