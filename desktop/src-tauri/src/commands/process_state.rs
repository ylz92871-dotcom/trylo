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
    /// P08 §4.2: stdin is a TAKEABLE ownership slot.
    ///
    /// `None` means the writer has already been dropped, i.e. stdin is
    /// closed (the child sees EOF). Closing stdin is *dropping the
    /// writer*, never killing the process — stdout, the killer and the
    /// exit attribution all stay owned by this entry, so a one-shot CLI
    /// can be told "the prompt is complete" while it is still streaming
    /// and while `stop` remains able to terminate its whole tree.
    pub writer: Option<Box<dyn Write + Send>>,
    /// Terminates the child process *tree*. On Windows this is
    /// `taskkill /T /F` by pid (the audit requires "终止正确进程
    /// 树，避免仅关闭 stdin"); elsewhere a `kill -KILL`. The
    /// reaper thread owns the `Child`, so the killer acts on the
    /// OS pid and lets `child.wait()` observe the exit.
    pub killer: Box<dyn FnMut() -> std::io::Result<()> + Send + Sync>,
    pub stop_state: ProcessStopState,
    /// Human-readable label, e.g. "trylo-core", "cc-cli".
    pub label: String,
    /// OS pid of the spawned child (for taskkill / diagnostics).
    pub pid: u32,
    /// Optional debug attribution (project / conversation / run).
    pub metadata: ProcessMetadata,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProcessStopState {
    Running,
    Requested,
}

impl ProcessEntry {
    /// A failed termination keeps the writer and retry authority. Only the
    /// reaper may release either after observing the actual child exit.
    pub fn request_stop(&mut self) -> std::io::Result<bool> {
        if self.stop_state == ProcessStopState::Requested {
            return Ok(false);
        }
        (self.killer)()?;
        self.stop_state = ProcessStopState::Requested;
        Ok(true)
    }

    /// P08 §4.2: close stdin by taking (and dropping) the writer.
    /// Idempotent — a second call takes `None` and does nothing.
    pub fn close_input(&mut self) {
        if let Some(mut writer) = self.writer.take() {
            // Flush first so a buffered prompt reaches the child; a flush
            // failure here is not actionable (we are closing anyway).
            let _ = writer.flush();
            drop(writer);
        }
    }
}

#[derive(Default)]
pub struct ProcessState {
    pub processes: Arc<Mutex<HashMap<String, ProcessEntry>>>,
}
