// Trylo Desktop — process_send Tauri command. See ARCHITECTURE.md
// §2.2 + §3 Phase 2 task #3+#4.

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
    let owned = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || send_registered_input(&id, message, &owned))
        .await
        .map_err(|error| {
            io_error(
                "(process input worker)",
                std::io::Error::other(error.to_string()),
            )
        })?
}

fn send_registered_input(
    id: &str,
    message: String,
    state: &ProcessState,
) -> Result<(), CommandError> {
    let input = state
        .input_for(id)
        .map_err(|error| io_error("(process)", error))?;
    let answered_request = super::process_recovery::answer_id(&message);
    input
        .send_line(message)
        .map_err(|error| io_error("(process)", error))?;
    if let Some(request_id) = answered_request {
        super::process_recovery::record_answer(&state.recovery, id, &request_id);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::send_registered_input;
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
                input: crate::commands::process_state::ProcessInputControl::new(writer),
                stop: crate::commands::process_state::ProcessStopControl::new(|| Ok(())),
                label: "test".to_owned(),
                pid: 1,
                metadata: ProcessMetadata::default(),
            },
        );
        ProcessState {
            processes: Arc::new(Mutex::new(table)),
            ..ProcessState::default()
        }
    }

    #[test]
    fn blocked_input_write_keeps_the_global_process_registry_available() {
        use crate::commands::process_state::test_input::{blocked_input, HoldAt};
        let fixture = blocked_input(HoldAt::Write);
        let state = Arc::new(state_with(Some(fixture.writer)));
        let sending = Arc::clone(&state);
        let worker =
            std::thread::spawn(move || send_registered_input("p1", "hello".into(), &sending));
        let entered = fixture
            .entered
            .recv_timeout(std::time::Duration::from_secs(2));
        let readable = state.processes.try_lock().is_ok();
        // Always release and join before the red assertion, including the old
        // implementation which still holds the registry during this write.
        let _ = fixture.release.send(());
        let result = worker.join().unwrap();
        assert!(entered.is_ok());
        result.unwrap();
        assert!(
            readable,
            "blocked stdin write holds the global process registry"
        );
    }

    #[test]
    fn send_after_close_is_broken_pipe_not_a_generic_error() {
        // The runner must distinguish "stdin closed" from "child gone",
        // so the error KIND is part of the wire contract (P08 §4.2).
        let state = state_with(None);
        let err = send_registered_input("p1", "late input".into(), &state).unwrap_err();
        let crate::commands::error::CommandError::Io { source, .. } = err else {
            panic!("expected IO error");
        };
        assert_eq!(source.kind(), std::io::ErrorKind::BrokenPipe);
        assert_ne!(source.kind(), std::io::ErrorKind::NotFound);
    }

    #[test]
    fn send_before_close_reaches_the_writer() {
        let state = state_with(Some(Box::new(Sink)));
        assert!(send_registered_input("p1", "hello".into(), &state).is_ok());
    }

    #[cfg(feature = "preview-ipc-tests")]
    #[test]
    fn ipc_send_and_close_use_the_owned_input_worker_and_preserve_eof_errors() {
        use tauri::test::{get_ipc_response, mock_builder, mock_context, noop_assets, INVOKE_KEY};
        struct RecordedInput(Arc<Mutex<Vec<u8>>>);
        impl Write for RecordedInput {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                self.0.lock().unwrap().extend_from_slice(bytes);
                Ok(bytes.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let bytes = Arc::new(Mutex::new(Vec::new()));
        let state = state_with(Some(Box::new(RecordedInput(Arc::clone(&bytes)))));
        let processes = Arc::clone(&state.processes);
        let app = mock_builder()
            .manage(state)
            .invoke_handler(tauri::generate_handler![
                crate::commands::process_send::process_send,
                crate::commands::process_close_input::process_close_input
            ])
            .build(mock_context(noop_assets()))
            .unwrap();
        let main = tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::default())
            .build()
            .unwrap();
        let invoke = |command: &str,
                      body: serde_json::Value|
         -> Result<serde_json::Value, serde_json::Value> {
            get_ipc_response(
                &main,
                tauri::webview::InvokeRequest {
                    cmd: command.into(),
                    callback: tauri::ipc::CallbackFn(0),
                    error: tauri::ipc::CallbackFn(1),
                    url: "http://tauri.localhost".parse().unwrap(),
                    body: body.into(),
                    headers: tauri::http::HeaderMap::default(),
                    invoke_key: INVOKE_KEY.into(),
                },
            )
            .map(|body| body.deserialize().unwrap())
        };
        assert_eq!(
            invoke(
                "process_send",
                serde_json::json!({"id":"p1", "message":"中文 input"})
            )
            .unwrap(),
            serde_json::Value::Null
        );
        assert_eq!(&*bytes.lock().unwrap(), "中文 input\n".as_bytes());
        invoke("process_close_input", serde_json::json!({"id":"p1"})).unwrap();
        invoke("process_close_input", serde_json::json!({"id":"p1"})).unwrap();
        let failure = invoke(
            "process_send",
            serde_json::json!({"id":"p1", "message":"must fail"}),
        )
        .unwrap_err();
        assert!(failure.as_str().unwrap().contains("stdin is closed"));
        assert!(!processes.lock().unwrap()["p1"].input.accepts_input());
        assert_eq!(&*bytes.lock().unwrap(), "中文 input\n".as_bytes());
        processes.lock().unwrap()["p1"].stop.request_stop().unwrap();
    }
}
