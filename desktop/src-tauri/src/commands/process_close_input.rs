// Trylo Desktop — process_close_input Tauri command. See
// ARCHITECTURE.md §2.2 and P08 技术规格 §4.2.
//
// Closes a sidecar's STDIN *without* touching anything else.
//
// Why this exists: the new Trylo CLI's `run` is ONE PROCESS PER TURN
// that only starts executing after its stdin reaches EOF (spec §3.3).
// The legacy CC-CLI contract is a resident stdin process that waits for
// more input, so nothing in the old bridge could ever say "that was the
// whole prompt". Without this command the new CLI would sit idle until
// the user gave up — golden trace `06-no-eof-never-starts` records
// exactly that (1.5s of waiting, zero bytes of stdout).
//
// Deliberately NOT `process_stop`: stopping removes the table row and
// kills the process tree. Closing input must leave stdout streaming,
// the killer armed, and the reaper's exit attribution intact, or the
// runner could never learn the exit code of a run it just started.

use tauri::State;

use crate::commands::error::{io_error, CommandError};
use crate::commands::process_state::ProcessState;

/// Close the child's stdin. Idempotent: closing an already-closed stdin
/// is a no-op success, so a runner may call it from a retry path
/// without tracking whether it already ran.
#[tauri::command]
pub async fn process_close_input(
    id: String,
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
    proc.close_input();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::process_state::{ProcessEntry, ProcessMetadata, ProcessState};
    use std::collections::HashMap;
    use std::io::Write;
    use std::sync::{Arc, Mutex};

    /// A writer that records whether it was dropped (stdin closed).
    struct DropFlag {
        dropped: Arc<Mutex<bool>>,
    }
    impl Write for DropFlag {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    impl Drop for DropFlag {
        fn drop(&mut self) {
            *self.dropped.lock().unwrap() = true;
        }
    }

    fn entry_with(writer: Option<Box<dyn Write + Send>>) -> ProcessEntry {
        ProcessEntry {
            writer,
            killer: Box::new(|| Ok(())),
            stop_state: crate::commands::process_state::ProcessStopState::Running,
            label: "test".to_owned(),
            pid: 1,
            metadata: ProcessMetadata::default(),
        }
    }

    #[test]
    fn close_input_takes_the_writer_and_drops_it() {
        let dropped = Arc::new(Mutex::new(false));
        let mut entry = entry_with(Some(Box::new(DropFlag {
            dropped: Arc::clone(&dropped),
        })));
        assert!(entry.writer.is_some());
        entry.close_input();
        assert!(entry.writer.is_none());
        assert!(
            *dropped.lock().unwrap(),
            "writer must be dropped = stdin closed"
        );

        // Idempotent: the second close is a no-op, not a panic.
        entry.close_input();
        assert!(entry.writer.is_none());
    }

    #[test]
    fn close_input_on_already_closed_is_a_noop() {
        let mut entry = entry_with(None);
        entry.close_input();
        assert!(entry.writer.is_none());
    }

    #[test]
    fn close_input_leaves_the_killer_armed() {
        // The whole point: closing stdin must not disarm cancellation.
        // `killer` is untouched by close_input, so `process_stop` still
        // terminates the tree after EOF.
        let killed = Arc::new(Mutex::new(false));
        let mut entry = ProcessEntry {
            writer: Some(Box::new(DropFlag {
                dropped: Arc::new(Mutex::new(false)),
            })),
            killer: Box::new({
                let k = Arc::clone(&killed);
                move || {
                    *k.lock().unwrap() = true;
                    Ok(())
                }
            }),
            stop_state: crate::commands::process_state::ProcessStopState::Running,
            label: "test".to_owned(),
            pid: 1,
            metadata: ProcessMetadata::default(),
        };
        entry.close_input();
        entry.request_stop().unwrap();
        assert!(*killed.lock().unwrap(), "killer must survive close_input");
    }

    #[test]
    fn unknown_process_is_reported_not_silently_ignored() {
        // A runner closing stdin on a process that already reaped must
        // learn the id was stale — silently OK would hide a real bug
        // (closing the wrong child, or a double-close after exit).
        let state = ProcessState {
            processes: Arc::new(Mutex::new(HashMap::new())),
        };
        let mut table = state.processes.lock().unwrap();
        let result = table.get_mut("nope").ok_or_else(|| {
            io_error(
                "(process)",
                std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    "process 'nope' not found".to_owned(),
                ),
            )
        });
        assert!(result.is_err());
    }
}
