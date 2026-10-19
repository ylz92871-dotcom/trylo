// Trylo Desktop — process_stop Tauri command. See ARCHITECTURE.md
// §2.2 + §3 Phase 2 task #3+#4.

use tauri::State;

use crate::commands::error::{io_error, CommandError};
use crate::commands::process_state::ProcessState;

#[tauri::command]
pub async fn process_stop(id: String, state: State<'_, ProcessState>) -> Result<(), CommandError> {
    stop_registered_process(&id, &state)
}

fn stop_registered_process(id: &str, state: &ProcessState) -> Result<(), CommandError> {
    let mut processes = state.processes.lock().map_err(|_| {
        io_error(
            "(process)",
            std::io::Error::other("process state poisoned".to_string()),
        )
    })?;
    if let Some(proc) = processes.get_mut(id) {
        proc.request_stop()
            .map_err(|error| io_error("(process stop)", error))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::process_state::{ProcessEntry, ProcessMetadata, ProcessStopState};
    use std::io::Write;
    use std::sync::{Arc, Mutex};

    struct TrackedInput(Arc<Mutex<bool>>);
    impl Write for TrackedInput {
        fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
            Ok(data.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    impl Drop for TrackedInput {
        fn drop(&mut self) {
            *self.0.lock().unwrap() = true;
        }
    }

    #[test]
    fn stop_keeps_input_and_ownership_until_exit_is_observed() {
        let state = ProcessState::default();
        let dropped = Arc::new(Mutex::new(false));
        state.processes.lock().unwrap().insert(
            "fixture".into(),
            ProcessEntry {
                writer: Some(Box::new(TrackedInput(Arc::clone(&dropped)))),
                killer: Box::new(|| Ok(())),
                stop_state: ProcessStopState::Running,
                label: "fixture".into(),
                pid: 1,
                metadata: ProcessMetadata::default(),
            },
        );
        stop_registered_process("fixture", &state).unwrap();
        assert!(
            !*dropped.lock().unwrap(),
            "a stop request is not an observed exit; stdin must stay owned"
        );
        assert!(state.processes.lock().unwrap().contains_key("fixture"));
    }

    #[test]
    fn refused_stop_keeps_the_channel_and_can_be_retried_without_double_killing() {
        let state = ProcessState::default();
        let dropped = Arc::new(Mutex::new(false));
        let attempts = Arc::new(Mutex::new(0));
        let attempts_for_killer = Arc::clone(&attempts);
        state.processes.lock().unwrap().insert(
            "fixture".into(),
            ProcessEntry {
                writer: Some(Box::new(TrackedInput(Arc::clone(&dropped)))),
                killer: Box::new(move || {
                    let mut calls = attempts_for_killer.lock().unwrap();
                    *calls += 1;
                    if *calls == 1 {
                        return Err(std::io::Error::from(std::io::ErrorKind::PermissionDenied));
                    }
                    Ok(())
                }),
                stop_state: ProcessStopState::Running,
                label: "fixture".into(),
                pid: 1,
                metadata: ProcessMetadata::default(),
            },
        );
        assert!(stop_registered_process("fixture", &state).is_err());
        assert!(!*dropped.lock().unwrap());
        {
            let mut table = state.processes.lock().unwrap();
            let entry = table.get_mut("fixture").unwrap();
            assert_eq!(entry.stop_state, ProcessStopState::Running);
            entry
                .writer
                .as_mut()
                .unwrap()
                .write_all(b"approval\n")
                .unwrap();
        }
        stop_registered_process("fixture", &state).unwrap();
        stop_registered_process("fixture", &state).unwrap();
        assert_eq!(*attempts.lock().unwrap(), 2);
        assert!(!*dropped.lock().unwrap());
        // Reproduce the real reaper's ownership release, then an idempotent stop.
        state.processes.lock().unwrap().remove("fixture");
        assert!(*dropped.lock().unwrap());
        stop_registered_process("fixture", &state).unwrap();
        assert_eq!(*attempts.lock().unwrap(), 2);
    }
}
