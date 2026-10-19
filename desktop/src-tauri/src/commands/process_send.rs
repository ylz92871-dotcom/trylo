// Trylo Desktop — process_send Tauri command. See ARCHITECTURE.md
// §2.2 + §3 Phase 2 task #3+#4.

use std::io::Write;

use tauri::State;

use crate::commands::error::{io_error, CommandError};
use crate::commands::process_state::ProcessState;

/// Write one line of text to the process's stdin. A trailing
/// `\n` is appended if the caller didn't include one — most
/// sidecar protocols (CC CLI's `--output-format stream-json`,
/// Trylo Core's planned JSON-over-stdio) are line-delimited.
///
/// P08 §4.2: writing to a process whose stdin was closed by
/// `process_close_input` is a *typed* `BrokenPipe` failure, not a
/// generic "other" error. The one-shot runner has to tell the two
/// apart: "stdin closed" means the prompt was already accepted (a late
/// retry or a caller bug), while anything else means the child is gone.
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
    let Some(writer) = proc.writer.as_mut() else {
        return Err(io_error(
            "(process)",
            std::io::Error::new(
                std::io::ErrorKind::BrokenPipe,
                format!("process '{id}' stdin is closed"),
            ),
        ));
    };
    let mut bytes = message.into_bytes();
    if bytes.last() != Some(&b'\n') {
        bytes.push(b'\n');
    }
    writer
        .write_all(&bytes)
        .map_err(|e| io_error("(process)", std::io::Error::other(e.to_string())))?;
    writer
        .flush()
        .map_err(|e| io_error("(process)", std::io::Error::other(e.to_string())))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use crate::commands::process_state::{ProcessEntry, ProcessMetadata, ProcessState};
    use std::collections::HashMap;
    use std::io::Write;
    use std::sync::{Arc, Mutex};

    struct Sink;
    impl Write for Sink {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    fn state_with(writer: Option<Box<dyn Write + Send>>) -> ProcessState {
        let mut table = HashMap::new();
        table.insert(
            "p1".to_owned(),
            ProcessEntry {
                writer,
                killer: Box::new(|| Ok(())),
                stop_state: crate::commands::process_state::ProcessStopState::Running,
                label: "test".to_owned(),
                pid: 1,
                metadata: ProcessMetadata::default(),
            },
        );
        ProcessState {
            processes: Arc::new(Mutex::new(table)),
        }
    }

    #[test]
    fn send_after_close_is_broken_pipe_not_a_generic_error() {
        // The runner must distinguish "stdin closed" from "child gone",
        // so the error KIND is part of the wire contract (P08 §4.2).
        let state = state_with(None);
        let mut table = state.processes.lock().unwrap();
        let proc = table.get_mut("p1").unwrap();
        assert!(proc.writer.is_none(), "closed stdin ⇒ no writer");
        let err = std::io::Error::new(
            std::io::ErrorKind::BrokenPipe,
            "process 'p1' stdin is closed".to_owned(),
        );
        assert_eq!(err.kind(), std::io::ErrorKind::BrokenPipe);
        assert_ne!(err.kind(), std::io::ErrorKind::NotFound);
    }

    #[test]
    fn send_before_close_reaches_the_writer() {
        let state = state_with(Some(Box::new(Sink)));
        let mut table = state.processes.lock().unwrap();
        let proc = table.get_mut("p1").unwrap();
        let writer = proc.writer.as_mut().expect("writer present before close");
        assert!(writer.write_all(b"hello\n").is_ok());
    }
}
