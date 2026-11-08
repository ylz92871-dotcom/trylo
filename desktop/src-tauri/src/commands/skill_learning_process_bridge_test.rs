//! Explicit, local QA of the production Rust pipe transport against a frozen CLI.
//! The mock Tauri app supplies state only; Node and the CLI run as real processes.
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

use tauri::{ipc::Channel, Manager};

use crate::commands::process_state::ProcessState;

#[test]
#[ignore = "requires explicit frozen candidate, Node, and fresh evidence directory"]
fn pinned_candidate_help_and_skills_list_use_real_rust_pipes() {
    let cli = PathBuf::from(std::env::var_os("TRYLO_SKILL_LEARNING_QA_CLI").expect("pinned CLI"));
    let node = PathBuf::from(std::env::var_os("TRYLO_SKILL_LEARNING_QA_NODE").expect("pinned Node"));
    let root = PathBuf::from(std::env::var_os("TRYLO_SKILL_LEARNING_QA_BRIDGE_DIR").expect("fresh QA directory"));
    assert!(cli.is_absolute() && cli.is_file());
    assert!(node.is_absolute() && node.is_file());
    assert!(root.is_absolute());
    std::fs::create_dir(&root).expect("QA directory must be new; preserve earlier evidence");
    let workspace = root.join("workspace with spaces");
    let profile = root.join("profile");
    std::fs::create_dir(&workspace).unwrap();
    std::fs::create_dir(&profile).unwrap();
    let candidate_root = cli.parent().unwrap().ancestors().nth(3).unwrap();
    let manifest: serde_json::Value = serde_json::from_slice(
        &std::fs::read(candidate_root.join("candidate-manifest.json")).unwrap(),
    ).unwrap();
    assert_eq!(manifest["status"], "ready");
    assert_eq!(PathBuf::from(manifest["entrypoint"].as_str().unwrap()), cli);
    let app = tauri::test::mock_builder()
        .manage(ProcessState::default())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let mut receipts = Vec::new();
    for (name, arguments) in [("help", vec!["--help"]), ("skills-list", vec!["skills", "list", "--json"])] {
        let (sent, received) = mpsc::channel();
        let stdout = Channel::<String>::new(move |body| {
            sent.send(body.deserialize::<String>().unwrap()).unwrap();
            Ok(())
        });
        let errors = Arc::new(Mutex::new(Vec::<String>::new()));
        let capture = Arc::clone(&errors);
        let stderr = Channel::<String>::new(move |body| {
            capture.lock().unwrap().push(body.deserialize::<String>().unwrap());
            Ok(())
        });
        let mut args = vec![cli.to_string_lossy().into_owned()];
        args.extend(arguments.into_iter().map(str::to_owned));
        let handle = tauri::async_runtime::block_on(super::process_spawn(
            node.to_string_lossy().into_owned(), args, format!("skill-learning-{name}-qa"),
            Some(workspace.to_string_lossy().into_owned()),
            Some(HashMap::from([("TRYLO_HOME".to_owned(), profile.to_string_lossy().into_owned())])),
            None, None, None, None, stdout, stderr, Some(true), app.state(),
        )).unwrap();
        let mut lines = Vec::new();
        let exit = loop {
            let line = received.recv_timeout(Duration::from_secs(30)).expect("actual child completion");
            if let Some(frame) = line.strip_prefix("##TRYLO_PROC_EXIT##") {
                break serde_json::from_str::<serde_json::Value>(frame).unwrap();
            }
            lines.push(line);
        };
        assert_eq!(exit["id"], handle.id);
        assert_eq!(exit["code"], 0);
        assert_eq!(exit["outputComplete"], true);
        assert!(errors.lock().unwrap().is_empty(), "CLI stderr must be separate and empty");
        assert!(!app.state::<ProcessState>().processes.lock().unwrap().contains_key(&handle.id));
        let output = lines.join("\n");
        if name == "help" {
            assert!(output.contains("skills"));
        } else {
            let reply: serde_json::Value = serde_json::from_str(&output).unwrap();
            assert_eq!(reply["schemaVersion"], 1);
            assert_eq!(reply["ok"], true);
            assert_eq!(reply["skills"], serde_json::json!([]));
        }
        std::fs::write(root.join(format!("{name}.stdout.log")), output).unwrap();
        receipts.push(serde_json::json!({ "name": name, "pid": handle.pid, "exit": exit }));
    }
    let report = serde_json::json!({ "schemaVersion": 1, "candidateSourceHash": manifest["sourceHash"],
        "cli": cli, "node": node, "tauriState": "mock", "processTransport": "production Rust process_spawn",
        "cliExecution": "real", "workspace": workspace, "receipts": receipts });
    std::fs::write(root.join("bridge-result.json"), serde_json::to_vec_pretty(&report).unwrap()).unwrap();
}
