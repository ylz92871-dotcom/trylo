use super::process_spawn;
use crate::commands::process_recovery::{process_read_output, RecoveryIdentity};
use crate::commands::process_state::ProcessState;
use tauri::{ipc::Channel, Manager};

#[test]
fn ordinary_turn_output_survives_renderer_loss_without_a_fabricated_team() {
    let app = tauri::test::mock_builder()
        .manage(ProcessState::default())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let disconnected = || {
        Channel::<String>::new(|_| {
            Err(tauri::Error::Io(std::io::Error::new(
                std::io::ErrorKind::BrokenPipe,
                "isolated ordinary display disconnected",
            )))
        })
    };
    let node = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("resources/runtime/node/win-x64/node.exe");
    let identity: RecoveryIdentity = serde_json::from_value(serde_json::json!({
        "kind": "conversation", "runId": "ordinary-run", "turnId": "ordinary-user-turn"
    }))
    .unwrap();
    let handle = tauri::async_runtime::block_on(process_spawn(
        node.to_string_lossy().into_owned(),
        vec!["-e".into(), "process.stdout.write('ordinary result\\n');process.stderr.write('ordinary diagnostic\\n');".into()],
        "ordinary-retained-output-proof".into(), None, None,
        Some("ordinary-workspace".into()), Some("ordinary-chat".into()),
        Some("ordinary-run".into()), Some(identity), disconnected(), disconnected(),
        Some(true), app.state(),
    )).unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    let snapshot = loop {
        let json =
            serde_json::to_value(process_read_output(&handle.id, 0, app.state()).unwrap()).unwrap();
        if json["finished"] == true {
            break json;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "isolated ordinary root did not exit"
        );
        std::thread::sleep(std::time::Duration::from_millis(10));
    };
    assert_eq!(snapshot["process"]["identity"]["kind"], "conversation");
    assert_eq!(snapshot["process"]["identity"]["runId"], "ordinary-run");
    assert_eq!(
        snapshot["process"]["identity"]["turnId"],
        "ordinary-user-turn"
    );
    assert!(snapshot["process"]["identity"].get("teamRunId").is_none());
    assert_eq!(snapshot["captureComplete"], true);
    assert_eq!(snapshot["gap"], false);
    assert_eq!(snapshot["exit"]["code"], 0);
    let records = snapshot["records"].as_array().unwrap();
    assert_eq!(records.len(), 2);
    assert!(records
        .iter()
        .any(|row| row["stream"] == "stdout" && row["line"] == "ordinary result"));
    assert!(records
        .iter()
        .any(|row| row["stream"] == "stderr" && row["line"] == "ordinary diagnostic"));
    assert!(!app
        .state::<ProcessState>()
        .processes
        .lock()
        .unwrap()
        .contains_key(&handle.id));
}

#[test]
fn ordinary_disconnected_root_accepts_graceful_interrupt_over_real_ipc() {
    use tauri::test::{get_ipc_response, INVOKE_KEY};

    let app = tauri::test::mock_builder()
        .manage(ProcessState::default())
        .invoke_handler(tauri::generate_handler![
            crate::commands::process_send::process_send,
            crate::commands::process_recovery::process_read_output
        ])
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let main = tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::default())
        .build()
        .unwrap();
    let invoke = |command: &str, body: serde_json::Value| -> serde_json::Value {
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
        .unwrap()
        .deserialize()
        .unwrap()
    };
    let disconnected = || {
        Channel::<String>::new(|_| {
            Err(tauri::Error::Io(std::io::Error::new(
                std::io::ErrorKind::BrokenPipe,
                "isolated interrupt display disconnected",
            )))
        })
    };
    let node = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("resources/runtime/node/win-x64/node.exe");
    // A fixed stdin-only protocol fixture: no provider, workspace or service.
    // Its own failure exit prevents an orphan if an assertion rejects the IPC.
    let script = r#"
const input = require('node:readline').createInterface({ input: process.stdin });
const failure = setTimeout(() => process.exit(91), 5000);
input.on('line', line => {
  const frame = JSON.parse(line);
  if (frame.type !== 'control_request' || frame.request?.subtype !== 'interrupt') return;
  clearTimeout(failure);
  input.close();
  process.stdout.write('ordinary interrupt received:' + frame.request_id + '\n', () => {
    process.stderr.write('ordinary interrupt diagnostic\n', () => process.exit(0));
  });
});
process.stdout.write('ordinary interrupt ready\n');
"#;
    let identity: RecoveryIdentity = serde_json::from_value(serde_json::json!({
        "kind": "conversation", "runId": "interrupt-run", "turnId": "interrupt-user-turn"
    }))
    .unwrap();
    let handle = tauri::async_runtime::block_on(process_spawn(
        node.to_string_lossy().into_owned(),
        vec!["-e".into(), script.into()],
        "ordinary-graceful-interrupt-proof".into(),
        None,
        None,
        Some("isolated-interrupt-workspace".into()),
        Some("isolated-interrupt-chat".into()),
        Some("interrupt-run".into()),
        Some(identity),
        disconnected(),
        disconnected(),
        Some(true),
        app.state(),
    ))
    .unwrap();
    let read = || {
        invoke(
            "process_read_output",
            serde_json::json!({"id":handle.id,"afterSequence":0}),
        )
    };
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        let snapshot = read();
        assert_eq!(
            snapshot["finished"], false,
            "fixture exited before interrupt"
        );
        if snapshot["records"]
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["stream"] == "stdout" && row["line"] == "ordinary interrupt ready")
        {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "fixture was not ready"
        );
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    {
        let state = app.state::<ProcessState>();
        let processes = state.processes.lock().unwrap();
        assert_eq!(processes.len(), 1);
        assert!(processes.contains_key(&handle.id));
    }
    let request_id = format!("interrupt-{}", handle.id);
    let frame = serde_json::json!({
        "type":"control_request", "request_id":request_id,
        "request":{"subtype":"interrupt"}
    });
    assert_eq!(
        invoke(
            "process_send",
            serde_json::json!({"id":handle.id,"message":frame.to_string()})
        ),
        serde_json::Value::Null
    );
    let snapshot = loop {
        let snapshot = read();
        if snapshot["finished"] == true {
            break snapshot;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "interrupted fixture did not exit"
        );
        std::thread::sleep(std::time::Duration::from_millis(10));
    };
    assert_eq!(snapshot["process"]["identity"]["kind"], "conversation");
    assert!(snapshot["process"]["identity"].get("teamRunId").is_none());
    assert_eq!(snapshot["captureComplete"], true);
    assert_eq!(snapshot["gap"], false);
    assert_eq!(snapshot["exit"]["code"], 0);
    let records = snapshot["records"].as_array().unwrap();
    assert_eq!(records.len(), 3);
    let received = format!("ordinary interrupt received:{request_id}");
    assert!(records
        .iter()
        .any(|row| row["stream"] == "stdout" && row["line"] == received));
    assert!(records.iter().any(|row| {
        row["stream"] == "stderr" && row["line"] == "ordinary interrupt diagnostic"
    }));
    assert!(app
        .state::<ProcessState>()
        .processes
        .lock()
        .unwrap()
        .is_empty());
}
