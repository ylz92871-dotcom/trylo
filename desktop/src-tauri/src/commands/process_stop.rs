// Trylo Desktop — process_stop Tauri command. See ARCHITECTURE.md
// §2.2 + §3 Phase 2 task #3+#4.

use tauri::State;

use crate::commands::error::{io_error, CommandError};
use crate::commands::process_state::ProcessState;

#[tauri::command]
pub async fn process_stop(id: String, state: State<'_, ProcessState>) -> Result<(), CommandError> {
    let owned = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || stop_registered_process(&id, &owned))
        .await
        .map_err(|error| {
            io_error(
                "(process stop worker)",
                std::io::Error::other(error.to_string()),
            )
        })?
}

fn stop_registered_process(id: &str, state: &ProcessState) -> Result<(), CommandError> {
    let processes = state.processes.lock().map_err(|_| {
        io_error(
            "(process)",
            std::io::Error::other("process state poisoned".to_string()),
        )
    })?;
    let stop = processes
        .get(id)
        .map(|entry| std::sync::Arc::clone(&entry.stop));
    drop(processes);
    if let Some(stop) = stop {
        stop.request_stop()
            .map_err(|error| io_error("(process stop)", error))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::process_state::{
        ProcessEntry, ProcessMetadata, ProcessStopControl, ProcessStopState,
    };
    use std::io::Write;
    use std::sync::{Arc, Mutex};

    struct TrackedInput(Arc<Mutex<bool>>);

    #[cfg(feature = "preview-ipc-tests")]
    #[test]
    fn the_stop_command_yields_before_blocking_termination_io() {
        use std::future::Future;
        use std::sync::mpsc;
        use std::time::Duration;
        use tauri::Manager;
        let (release, held) = mpsc::channel();
        let (finished, completion) = mpsc::channel();
        let held = Mutex::new(held);
        let state = ProcessState::default();
        state.processes.lock().unwrap().insert(
            "blocked-async-stop".into(),
            ProcessEntry {
                input: crate::commands::process_state::ProcessInputControl::new(None),
                stop: ProcessStopControl::new(move || {
                    held.lock()
                        .unwrap()
                        .recv_timeout(Duration::from_secs(5))
                        .unwrap();
                    finished.send(()).unwrap();
                    Ok(())
                }),
                label: "owned-test-stop".into(),
                pid: 1,
                metadata: ProcessMetadata::default(),
            },
        );
        let app = tauri::test::mock_builder()
            .manage(state)
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let managed = app.state::<ProcessState>();
        std::thread::scope(|scope| {
            let (polled, result) = mpsc::channel();
            let worker = scope.spawn(move || {
                let mut stop = Box::pin(process_stop("blocked-async-stop".into(), managed));
                let mut context = std::task::Context::from_waker(std::task::Waker::noop());
                polled
                    .send(stop.as_mut().poll(&mut context).is_pending())
                    .unwrap();
            });
            let yielded = result.recv_timeout(Duration::from_secs(1)).unwrap_or(false);
            release.send(()).unwrap();
            worker.join().unwrap();
            completion.recv_timeout(Duration::from_secs(5)).unwrap();
            assert!(
                yielded,
                "async process_stop blocked its caller on termination IO"
            );
        });
    }

    #[test]
    fn a_blocked_termination_does_not_hold_the_process_registry() {
        use std::sync::mpsc;
        use std::time::Duration;
        let state = ProcessState::default();
        let (entered, observed) = mpsc::channel();
        let (release, held) = mpsc::channel();
        let held = Mutex::new(held);
        state.processes.lock().unwrap().insert(
            "blocked".into(),
            ProcessEntry {
                input: crate::commands::process_state::ProcessInputControl::new(None),
                stop: ProcessStopControl::new(move || {
                    entered.send(()).unwrap();
                    held.lock()
                        .unwrap()
                        .recv_timeout(Duration::from_secs(5))
                        .unwrap();
                    Ok(())
                }),
                label: "blocked".into(),
                pid: 1,
                metadata: ProcessMetadata::default(),
            },
        );
        std::thread::scope(|scope| {
            let stopping = scope.spawn(|| stop_registered_process("blocked", &state));
            observed.recv_timeout(Duration::from_secs(3)).unwrap();
            let readable = state.processes.try_lock().is_ok();
            release.send(()).unwrap();
            stopping.join().unwrap().unwrap();
            assert!(
                readable,
                "termination IO retained the registry lock and blocked all native process queries"
            );
        });
    }

    #[test]
    fn a_reaper_can_release_input_before_a_late_termination_receipt() {
        use std::sync::mpsc;
        use std::time::Duration;
        let state = ProcessState::default();
        let dropped = Arc::new(Mutex::new(false));
        let (entered, observed) = mpsc::channel();
        let (release, held) = mpsc::channel();
        let held = Mutex::new(held);
        let stop = ProcessStopControl::new(move || {
            entered.send(()).unwrap();
            held.lock()
                .unwrap()
                .recv_timeout(Duration::from_secs(5))
                .unwrap();
            Err(std::io::ErrorKind::PermissionDenied.into())
        });
        state.processes.lock().unwrap().insert(
            "exiting".into(),
            ProcessEntry {
                input: crate::commands::process_state::ProcessInputControl::new(Some(Box::new(
                    TrackedInput(Arc::clone(&dropped)),
                ))),
                stop: Arc::clone(&stop),
                label: "exiting".into(),
                pid: 1,
                metadata: ProcessMetadata::default(),
            },
        );
        std::thread::scope(|scope| {
            let stopping = scope.spawn(|| stop_registered_process("exiting", &state));
            observed.recv_timeout(Duration::from_secs(3)).unwrap();
            // These are the real reaper's operations after child.wait succeeds.
            stop.mark_exited();
            state.processes.lock().unwrap().remove("exiting");
            let input_released = *dropped.lock().unwrap();
            release.send(()).unwrap();
            stopping.join().unwrap().unwrap();
            assert!(
                input_released,
                "actual exit cleanup waited for a termination helper receipt"
            );
        });
        stop_registered_process("exiting", &state).unwrap();
        assert_eq!(stop.state(), ProcessStopState::Exited);
    }
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
                input: crate::commands::process_state::ProcessInputControl::new(Some(Box::new(
                    TrackedInput(Arc::clone(&dropped)),
                ))),
                stop: ProcessStopControl::new(|| Ok(())),
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
                input: crate::commands::process_state::ProcessInputControl::new(Some(Box::new(
                    TrackedInput(Arc::clone(&dropped)),
                ))),
                stop: ProcessStopControl::new(move || {
                    let mut calls = attempts_for_killer.lock().unwrap();
                    *calls += 1;
                    if *calls == 1 {
                        return Err(std::io::Error::from(std::io::ErrorKind::PermissionDenied));
                    }
                    Ok(())
                }),
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
            assert_eq!(entry.stop.state(), ProcessStopState::Running);
            entry.input.send_line("approval\n".into()).unwrap();
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
