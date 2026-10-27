// Trylo Desktop — process_spawn Tauri command. See ARCHITECTURE.md
// §2.2 + §3 Phase 2 task #3+#4.
//
// Spawns a long-running sidecar process (Trylo Core, CC CLI,
// future Hermes). The caller's Tauri Channel<String> receives
// stdout lines from the child ('##TRYLO_PROC_EXIT##' control
// frames emitted when the child exits). We spawn a thread that
// reads the child's stdout line-by-line and pushes each line into
// the channel. The child gets a fresh stdin pipe we can write to
// via process_send.
//
// v1.16.6 (M4-A runtime ownership, spec §5.3):
//   - every spawn gets a UNIQUE processId (atomic counter), not
//     `proc-{label}-{desktop_pid}` which collided for all
//     same-label children in one desktop process;
//   - the `killer` terminates the child process TREE (taskkill
//     /T /F on Windows) — the old entry had an EMPTY killer;
//   - a reaper thread owns the Child, calls wait(), then removes
//     its own row from ProcessState and emits `process.exited`;
//   - env values / API keys are never logged (see redact_env).

use std::collections::HashMap;
use std::io::BufReader;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::State;

use crate::commands::error::{io_error, CommandError};
use crate::commands::process_output::{await_output_completion, drain_observed_output};
use crate::commands::process_recovery::{self, RecoveryIdentity, RecoveryProcess};
use crate::commands::process_state::{
    ProcessEntry, ProcessInputControl, ProcessMetadata, ProcessState, ProcessStopControl,
};
use crate::commands::process_termination::OwnedTreeTerminator;

#[derive(Debug, Serialize)]
pub struct ProcessHandleDto {
    pub id: String,
    pub pid: u32,
    pub label: String,
    pub command: String,
}

/// Monotonic id source so two same-label children in one desktop
/// process never share a processId. Persists across spawns; safe
/// because it is only ever incremented.
static NEXT_PROCESS_SEQ: AtomicU64 = AtomicU64::new(0);

/// Log the env as `key=configured:true/false` ONLY — never the
/// value (the value may be an API key / Authorization header,
/// per spec §7.5).
fn redact_env(env: Option<&HashMap<String, String>>) -> String {
    let Some(env) = env else {
        return "none".to_owned();
    };
    if env.is_empty() {
        return "empty".to_owned();
    }
    let mut keys: Vec<&String> = env.keys().collect();
    keys.sort();
    keys.iter()
        .map(|key| format!("{key}=configured:{}", !env[*key].is_empty()))
        .collect::<Vec<_>>()
        .join(", ")
}

/// Redact any prompt-bearing arg value. `--append-system-prompt`
/// carries the user's system prompt text, which must not be
/// logged (spec §7.5).
fn redact_args(args: &[String]) -> String {
    let mut out = Vec::with_capacity(args.len());
    let mut redact_next = false;
    for arg in args {
        if redact_next {
            out.push("<redacted>".to_owned());
            redact_next = false;
        } else {
            if arg == "--append-system-prompt" {
                redact_next = true;
            }
            out.push(arg.clone());
        }
    }
    out.join(" ")
}

/// Terminating signal of an exit status. Windows has no signal
/// concept (termination is by exit code only), so signal is always
/// `None` there; on Unix it is `ExitStatus::signal()`.
#[cfg(unix)]
fn exit_signal(status: std::process::ExitStatus) -> Option<i32> {
    status.signal()
}

#[cfg(windows)]
fn exit_signal(_status: std::process::ExitStatus) -> Option<i32> {
    None
}

#[allow(
    clippy::too_many_lines,
    clippy::too_many_arguments,
    clippy::items_after_statements
)]
#[tauri::command]
pub async fn process_spawn(
    command: String,
    args: Vec<String>,
    label: String,
    cwd: Option<String>,
    env: Option<HashMap<String, String>>,
    project_key: Option<String>,
    conversation_id: Option<String>,
    run_id: Option<String>,
    recovery_identity: Option<RecoveryIdentity>,
    on_output: Channel<String>,
    // P08 §4.2: a SECOND, always-present channel for stderr.
    //
    // It cannot be `Option<Channel<_>>` — Tauri's `Channel` does not
    // implement `Deserialize`, so an optional one won't compile. Instead
    // the channel is always passed and `capture_stderr` decides whether
    // the child's stderr is piped into it at all. That keeps the legacy
    // CC CLI's debug flood from ever crossing IPC: with
    // `capture_stderr: false` the child gets `Stdio::null()` and the
    // channel simply never fires.
    on_stderr: Channel<String>,
    capture_stderr: Option<bool>,
    state: State<'_, ProcessState>,
) -> Result<ProcessHandleDto, CommandError> {
    let team_owner = if recovery_identity.is_some() {
        Some(crate::commands::process_team_owner::acquire(
            cwd.as_deref().ok_or_else(|| CommandError::Validation {
                reason: "team owner requires workspace cwd".into(),
            })?,
            conversation_id
                .as_deref()
                .ok_or_else(|| CommandError::Validation {
                    reason: "team owner requires conversation identity".into(),
                })?,
        )?)
    } else {
        None
    };
    eprintln!(
        "[rust] process_spawn: label={label} command={command} args=[{}] env=[{}]",
        redact_args(&args),
        redact_env(env.as_ref())
    );

    let mut cmd = Command::new(&command);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // Piped CLI workers must not open a console window.
    }
    cmd.args(&args);
    if let Some(cwd) = &cwd {
        eprintln!("[rust]   cwd={cwd}");
        cmd.current_dir(cwd);
    }
    if let Some(extra_env) = &env {
        for (key, value) in extra_env {
            cmd.env(key, value);
        }
    }
    // Stderr: NULL unless the caller asked for it.
    //
    // P08 §4.2 requires a channel that is SEPARATE from the JSONL
    // stdout — a pre-run failure (bad session id, missing credential)
    // exits with a code and writes only to stderr, so without this the
    // UI would hang in `busy` waiting for a `run_result` that can never
    // arrive (golden trace 04-prerun-config-failure: exit 52, stdout
    // empty).
    //
    // It stays opt-in on purpose: the legacy CC CLI floods stderr with
    // debug logging, and a piped-but-unread pipe would eventually block
    // the child. Legacy callers pass no channel and keep `Stdio::null()`.
    let want_stderr = capture_stderr.unwrap_or(false);
    cmd.stdin(Stdio::piped());
    cmd.stdout(Stdio::piped());
    if want_stderr {
        cmd.stderr(Stdio::piped());
    } else {
        cmd.stderr(Stdio::null());
    }

    let mut child = match cmd.spawn() {
        Ok(c) => {
            eprintln!("[rust]   spawn ok, pid={}", c.id());
            c
        }
        Err(e) => {
            eprintln!("[rust]   spawn FAILED: {e}");
            return Err(io_error(
                &format!("(process) {command}"),
                std::io::Error::other(e.to_string()),
            ));
        }
    };

    let pid = child.id();
    let team_tree = if team_owner.is_some() {
        match crate::commands::process_team_guard::TeamProcessGuard::capture(&child) {
            Ok(guard) => Some(guard),
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(io_error("(team process ownership)", error));
            }
        }
    } else {
        None
    };
    let terminator = match OwnedTreeTerminator::capture(&child) {
        Ok(terminator) => terminator,
        Err(error) => {
            // No registration has escaped yet. This command still owns and
            // reaps its failed startup rather than dropping a live Child.
            let _ = child.kill();
            let _ = child.wait();
            return Err(io_error("(process identity)", error));
        }
    };
    let seq = NEXT_PROCESS_SEQ.fetch_add(1, Ordering::Relaxed) + 1;
    let id = format!("proc-{seq}");
    let journal = recovery_identity
        .zip(project_key.as_ref())
        .zip(conversation_id.as_ref())
        .map(|((identity, project), conversation)| {
            process_recovery::register(
                &state.recovery,
                RecoveryProcess {
                    id: id.clone(),
                    pid,
                    project_key: project.clone(),
                    conversation_id: conversation.clone(),
                    identity,
                },
            )
        });

    // Keep stdin open — the CLI reads the user prompt from stdin
    // as a stream-json user message AND uses stdin for permission
    // prompts. The per-process input control serializes complete frames.
    let Some(stdout) = child.stdout.take() else {
        return Err(io_error(
            &format!("(process) {command}"),
            std::io::Error::other("no stdout from process"),
        ));
    };
    let Some(stdin) = child.stdin.take() else {
        return Err(io_error(
            &format!("(process) {command}"),
            std::io::Error::other("no stdin from process"),
        ));
    };

    // Stdout reader thread: each line is one event. Push to the
    // channel; on read error / EOF (child exit), exit.
    let channel_for_read = on_output.clone();
    let (stdout_done, stdout_receipt) = std::sync::mpsc::channel();
    let mut output_receipts = vec![stdout_receipt];
    let (stdout_captured, stdout_capture_receipt) = std::sync::mpsc::channel();
    let mut capture_receipts = vec![stdout_capture_receipt];
    let stdout_journal = journal.clone();
    let stderr_lines = Arc::new(AtomicU64::new(0));
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        let result = drain_observed_output(
            reader,
            |text| channel_for_read.send(text).is_ok(),
            |line| {
                if let Some(journal) = &stdout_journal {
                    if let Ok(mut journal) = journal.lock() {
                        journal.record("stdout", line);
                    }
                }
            },
        );
        let _ = stdout_captured.send(result.is_ok());
        let _ = stdout_done.send(matches!(result, Ok(0)));
        match result {
            Ok(discarded) if discarded > 0 => eprintln!(
                "[rust] stdout display disconnected; drained {discarded} undelivered lines"
            ),
            Ok(_) => {}
            Err(error) => eprintln!("[rust] stdout read failed: {error}"),
        }
        eprintln!("[rust]   stdout reader thread exiting");
    });

    // P08 §4.2: stderr gets its OWN channel and is never merged into the
    // stdout JSONL stream — a `warning: ...` line from the runtime is not
    // an event, and feeding it to the translator would either drop it or
    // corrupt the line framing.
    if want_stderr {
        let Some(stderr) = child.stderr.take() else {
            // Defensive: we only ask for a pipe when capture was requested,
            // so this cannot happen. Kill the child rather than leak it.
            let _ = child.kill();
            return Err(io_error(
                &format!("(process) {command}"),
                std::io::Error::other("no stderr from process"),
            ));
        };
        let (stderr_done, stderr_receipt) = std::sync::mpsc::channel();
        output_receipts.push(stderr_receipt);
        let (stderr_captured, stderr_capture_receipt) = std::sync::mpsc::channel();
        capture_receipts.push(stderr_capture_receipt);
        let stderr_journal = journal.clone();
        let stderr_lines_for_read = Arc::clone(&stderr_lines);
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            let result = drain_observed_output(
                reader,
                |text| {
                    let queued = on_stderr.send(text).is_ok();
                    if queued {
                        stderr_lines_for_read.fetch_add(1, Ordering::Release);
                    }
                    queued
                },
                |line| {
                    if let Some(journal) = &stderr_journal {
                        if let Ok(mut journal) = journal.lock() {
                            journal.record("stderr", line);
                        }
                    }
                },
            );
            let _ = stderr_captured.send(result.is_ok());
            let _ = stderr_done.send(matches!(result, Ok(0)));
            match result {
                Ok(discarded) if discarded > 0 => eprintln!(
                    "[rust] stderr display disconnected; drained {discarded} undelivered lines"
                ),
                Ok(_) => {}
                Err(error) => eprintln!("[rust] stderr read failed: {error}"),
            }
        });
    }

    let input = ProcessInputControl::new(Some(Box::new(stdin)));
    let input_for_exit = Arc::clone(&input);
    // Team roots use their pinned Windows job; other roots retain the bounded
    // identity-pinned helper. The reaper alone confirms either kind of exit.
    #[cfg(windows)]
    let team_stop = team_tree.clone();
    let stop_control = ProcessStopControl::new(move || {
        #[cfg(windows)]
        if let Some(guard) = &team_stop {
            return guard.terminate();
        }
        terminator.terminate()
    });
    state
        .processes
        .lock()
        .map_err(|_| {
            io_error(
                "(process)",
                std::io::Error::other("process state poisoned".to_string()),
            )
        })?
        .insert(
            id.clone(),
            ProcessEntry {
                input,
                stop: Arc::clone(&stop_control),
                label: label.clone(),
                pid,
                metadata: ProcessMetadata {
                    project_key,
                    conversation_id,
                    run_id,
                },
            },
        );

    // Reaper thread: the only true owner of the Child. On exit it
    // removes its own entry (no fake-lively table rows) and emits
    // a structured `process.exited` control frame so the React
    // supervisor can end the run even if it was never `stop`ped.
    let channel_for_exit = on_output.clone();
    let table_for_exit = Arc::clone(&state.processes);
    let id_for_exit = id.clone();
    let label_for_exit = label.clone();
    let recovery_for_exit = Arc::clone(&state.recovery);
    std::thread::spawn(move || {
        let _team_owner = team_owner;
        // Retain crash ownership while awaiting the root; observed exit below
        // restores the CLI's normal background-process policy.
        let tree_owner = team_tree;
        let mut reported_wait_failure = false;
        let status = wait_for_observed_exit(
            || child.wait(),
            |error| {
                if !reported_wait_failure {
                    eprintln!("[rust] process {id_for_exit}: exit observation failed, retaining ownership: {error}");
                    reported_wait_failure = true;
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            },
        );
        stop_control.mark_exited();
        #[cfg(windows)]
        if let Some(guard) = &tree_owner {
            if let Err(error) = guard.release_after_exit() {
                eprintln!("[rust] process {id_for_exit}: observed exit, background policy release failed: {error}");
            }
        }
        input_for_exit.mark_exited();
        let (code, signal) = (status.code(), exit_signal(status));
        if let Ok(mut table) = table_for_exit.lock() {
            let _ = table.remove(&id_for_exit);
        }
        // Real exit releases native ownership immediately, but its notification
        // must not overtake the last terminal/stdout or diagnostic/stderr lines.
        let output_complete =
            await_output_completion(output_receipts, std::time::Duration::from_millis(500));
        eprintln!("[rust]   process {id_for_exit} ({label_for_exit}) exited: code={code:?}");
        // Structured `process.exited` control frame (spec §5.3 #5):
        // id/pid/code/signal. `signal` is `null` on Windows (ExitStatus
        // reports code only) and always emitted so the wire format is
        // stable across platforms.
        let frame = serde_json::json!({
            "id": id_for_exit,
            "pid": pid,
            "code": code,
            "signal": signal,
            "outputComplete": output_complete,
            "stderrLines": stderr_lines.load(Ordering::Acquire),
        });
        if let Some(journal) = journal {
            let captured = await_output_completion(capture_receipts, std::time::Duration::ZERO);
            if let Ok(mut journal) = journal.lock() {
                journal.finish(frame.clone(), captured);
            }
            process_recovery::mark_completed(&recovery_for_exit, &id_for_exit);
        }
        let _ = channel_for_exit.send(format!("##TRYLO_PROC_EXIT##{frame}"));
        drop(tree_owner);
    });

    eprintln!("[rust]   process {id} registered, returning DTO");
    Ok(ProcessHandleDto {
        id,
        pid,
        label,
        command: format!("{command} {cmd_args}", cmd_args = redact_args(&args)),
    })
}

fn wait_for_observed_exit(
    mut wait: impl FnMut() -> std::io::Result<std::process::ExitStatus>,
    mut retry: impl FnMut(std::io::Error),
) -> std::process::ExitStatus {
    loop {
        match wait() {
            Ok(status) => return status,
            // The reaper keeps the Child and registration while observation is
            // unavailable. A wait failure cannot manufacture an exit receipt.
            Err(error) => retry(error),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{redact_args, redact_env};
    use std::collections::HashMap;

    #[cfg(all(windows, feature = "preview-ipc-tests"))]
    #[test]
    fn retained_team_output_survives_disconnected_channels_and_actual_exit() {
        use crate::commands::process_recovery::{process_read_output, RecoveryIdentity};
        use crate::commands::process_state::ProcessState;
        use tauri::{ipc::Channel, Manager};
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let workspace = std::env::temp_dir().join(format!(
            "trylo-output-recovery-{}-{nonce}",
            std::process::id()
        ));
        std::fs::create_dir(&workspace).unwrap();
        let app = tauri::test::mock_builder()
            .manage(ProcessState::default())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let disconnected = || {
            Channel::<String>::new(|_| {
                Err(tauri::Error::Io(std::io::Error::new(
                    std::io::ErrorKind::BrokenPipe,
                    "isolated disconnected display",
                )))
            })
        };
        let node = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("resources/runtime/node/win-x64/node.exe");
        let occupied =
            crate::commands::process_team_owner::acquire(workspace.to_str().unwrap(), "proof-chat")
                .unwrap();
        let blocked = tauri::async_runtime::block_on(super::process_spawn(
            node.to_string_lossy().into_owned(),
            vec!["-e".into(), "process.exit(0)".into()],
            "duplicate-root-must-not-spawn".into(),
            Some(workspace.to_string_lossy().into_owned()),
            None,
            Some("proof-workspace".into()),
            Some("proof-chat".into()),
            Some("denied-runtime-owner".into()),
            Some(RecoveryIdentity {
                team_run_id: "blocked-team".into(),
                turn_id: "blocked-turn".into(),
            }),
            disconnected(),
            disconnected(),
            Some(true),
            app.state(),
        ));
        drop(occupied);
        assert!(
            matches!(
                blocked,
                Err(crate::commands::error::CommandError::Validation { .. })
            ),
            "a duplicate root escaped its OS lease"
        );
        assert!(app
            .state::<ProcessState>()
            .processes
            .lock()
            .unwrap()
            .is_empty());
        let handle = tauri::async_runtime::block_on(super::process_spawn(
            node.to_string_lossy().into_owned(),
            vec!["-e".into(), "process.stdout.write('retained one\\nretained two\\n');process.stderr.write('retained diagnostic\\n');".into()],
            "retained-output-proof".into(), Some(workspace.to_string_lossy().into_owned()), None, Some("proof-workspace".into()), Some("proof-chat".into()),
            Some("runtime-owner".into()), Some(RecoveryIdentity { team_run_id: "proof-team".into(), turn_id: "proof-turn".into() }),
            disconnected(), disconnected(), Some(true), app.state(),
        )).unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        let snapshot = loop {
            let output = process_read_output(&handle.id, 0, app.state()).unwrap();
            let json = serde_json::to_value(output).unwrap();
            if json["finished"] == true {
                break json;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "owned fixture did not exit"
            );
            std::thread::sleep(std::time::Duration::from_millis(10));
        };
        assert_eq!(snapshot["process"]["identity"]["teamRunId"], "proof-team");
        assert_eq!(snapshot["captureComplete"], true);
        assert_eq!(snapshot["gap"], false);
        assert_eq!(snapshot["exit"]["outputComplete"], false);
        let records = snapshot["records"].as_array().unwrap();
        assert_eq!(records.len(), 3);
        assert!(records
            .iter()
            .any(|row| row["stream"] == "stderr" && row["line"] == "retained diagnostic"));
        let stdout: Vec<_> = records
            .iter()
            .filter(|row| row["stream"] == "stdout")
            .map(|row| row["line"].as_str().unwrap())
            .collect();
        assert_eq!(stdout, ["retained one", "retained two"]);
        assert!(!app
            .state::<ProcessState>()
            .processes
            .lock()
            .unwrap()
            .contains_key(&handle.id));
        let release_deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while crate::commands::process_team_owner::process_team_owner_status(
            workspace.to_str().unwrap(),
            "proof-chat",
        )
        .unwrap()
        {
            assert!(
                std::time::Instant::now() < release_deadline,
                "exited root retained its lease"
            );
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        let actual = std::fs::canonicalize(&workspace).unwrap();
        assert!(actual.starts_with(std::fs::canonicalize(std::env::temp_dir()).unwrap()));
        assert!(actual
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("trylo-output-recovery-"));
        std::fs::remove_dir_all(actual).unwrap();
    }

    #[cfg(all(windows, feature = "preview-ipc-tests"))]
    #[derive(Clone, Copy)]
    enum TailProbe {
        Stdout,
        Stderr,
        StalledStdout,
    }

    #[cfg(all(windows, feature = "preview-ipc-tests"))]
    fn assert_exit_follows_delayed_output(probe: TailProbe) {
        use std::sync::{mpsc, Mutex};
        use std::time::Duration;
        use tauri::ipc::Channel;
        use tauri::Manager;
        let stderr = matches!(probe, TailProbe::Stderr);
        let deadline_expires = matches!(probe, TailProbe::StalledStdout);
        let (entered, observed) = mpsc::channel();
        let (release, held) = mpsc::channel();
        let held = Mutex::new(held);
        let (delivered, received) = mpsc::channel();
        let delayed_delivery = delivered.clone();
        let delayed = Channel::<String>::new(move |body| {
            let line: String = body.deserialize().unwrap();
            if line == "FINAL_TAIL_PROOF" {
                entered.send(()).unwrap();
                held.lock()
                    .unwrap()
                    .recv_timeout(Duration::from_secs(5))
                    .unwrap();
            }
            delayed_delivery.send(line).unwrap();
            Ok(())
        });
        let output = Channel::<String>::new(move |body| {
            delivered
                .send(body.deserialize::<String>().unwrap())
                .unwrap();
            Ok(())
        });
        let (stdout, stderr_channel) = if stderr {
            (output, delayed)
        } else {
            (delayed, output)
        };
        let app = tauri::test::mock_builder()
            .manage(crate::commands::process_state::ProcessState::default())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let node = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("resources/runtime/node/win-x64/node.exe");
        let script = format!(
            "process.{}.write('FINAL_TAIL_PROOF\\n',()=>process.exit(0));",
            if stderr { "stderr" } else { "stdout" }
        );
        let handle = tauri::async_runtime::block_on(super::process_spawn(
            node.to_string_lossy().into_owned(),
            vec!["-e".into(), script],
            "native-tail-order-proof".into(),
            None,
            None,
            None,
            None,
            None,
            None,
            stdout,
            stderr_channel,
            Some(stderr),
            app.state(),
        ))
        .unwrap();
        let paused = observed.recv_timeout(Duration::from_secs(3));
        let early_exit = received
            .recv_timeout(if deadline_expires {
                Duration::from_secs(2)
            } else {
                Duration::from_millis(200)
            })
            .ok();
        // Always release and collect the child's receipts before asserting.
        let _ = release.send(());
        let mut lines: Vec<String> = early_exit.iter().cloned().collect();
        while lines.len() < 2 {
            let Ok(line) = received.recv_timeout(Duration::from_secs(3)) else {
                break;
            };
            lines.push(line);
        }
        assert!(
            paused.is_ok(),
            "real output did not enter the delayed native channel"
        );
        assert_tail_delivery(&lines, early_exit.as_deref(), probe);
        assert!(!app
            .state::<crate::commands::process_state::ProcessState>()
            .processes
            .lock()
            .unwrap()
            .contains_key(&handle.id));
    }

    #[cfg(all(windows, feature = "preview-ipc-tests"))]
    fn assert_tail_delivery(lines: &[String], early_exit: Option<&str>, probe: TailProbe) {
        let deadline_expires = matches!(probe, TailProbe::StalledStdout);
        assert_eq!(
            lines.len(),
            2,
            "expected actual tail plus a single exit receipt"
        );
        let receipt = if deadline_expires {
            assert!(
                early_exit.is_some(),
                "actual exit waited forever for a stalled display"
            );
            assert_eq!(lines[1], "FINAL_TAIL_PROOF");
            &lines[0]
        } else {
            assert!(
                early_exit.is_none(),
                "exit overtook pending tail output: {early_exit:?}"
            );
            assert_eq!(lines[0], "FINAL_TAIL_PROOF");
            &lines[1]
        };
        let facts: serde_json::Value =
            serde_json::from_str(receipt.strip_prefix("##TRYLO_PROC_EXIT##").unwrap()).unwrap();
        assert_eq!(facts["outputComplete"], !deadline_expires);
        assert_eq!(
            facts["stderrLines"],
            u64::from(matches!(probe, TailProbe::Stderr))
        );
    }

    #[cfg(all(windows, feature = "preview-ipc-tests"))]
    #[test]
    fn exit_receipt_follows_delayed_stdout_from_a_real_child() {
        assert_exit_follows_delayed_output(TailProbe::Stdout);
    }

    #[cfg(all(windows, feature = "preview-ipc-tests"))]
    #[test]
    fn exit_receipt_follows_delayed_stderr_from_a_real_child() {
        assert_exit_follows_delayed_output(TailProbe::Stderr);
    }

    #[cfg(all(windows, feature = "preview-ipc-tests"))]
    #[test]
    fn a_stalled_stdout_display_cannot_hold_the_real_exit_receipt_forever() {
        assert_exit_follows_delayed_output(TailProbe::StalledStdout);
    }

    #[test]
    fn failed_waits_are_not_converted_into_an_exit_receipt() {
        #[cfg(not(windows))]
        use std::os::unix::process::ExitStatusExt;
        #[cfg(windows)]
        use std::os::windows::process::ExitStatusExt;
        let attempts = std::cell::Cell::new(0);
        let retries = std::cell::Cell::new(0);
        let status = super::wait_for_observed_exit(
            || {
                attempts.set(attempts.get() + 1);
                if attempts.get() <= 2 {
                    Err(std::io::ErrorKind::Interrupted.into())
                } else {
                    Ok(std::process::ExitStatus::from_raw(0))
                }
            },
            |_| {
                retries.set(retries.get() + 1);
            },
        );
        assert!(status.success());
        assert_eq!(attempts.get(), 3);
        assert_eq!(retries.get(), 2);
    }

    #[test]
    fn redact_env_never_prints_values() {
        // spec §11.4: log-redaction regression — API key / auth /
        // env values must never appear in output, only their
        // configured flag.
        let mut env = HashMap::new();
        env.insert("ANTHROPIC_API_KEY".to_owned(), "sk-ant-secret".to_owned());
        env.insert("Authorization".to_owned(), "Bearer secret-token".to_owned());
        env.insert("PLAIN".to_owned(), String::new());
        let out = redact_env(Some(&env));
        assert!(out.contains("ANTHROPIC_API_KEY=configured:true"));
        assert!(out.contains("Authorization=configured:true"));
        assert!(out.contains("PLAIN=configured:false"));
        assert!(!out.contains("sk-ant-secret"));
        assert!(!out.contains("Bearer"));
        assert!(!out.contains("secret-token"));
    }

    #[test]
    fn redact_env_none_is_none() {
        assert_eq!(redact_env(None), "none");
    }

    #[test]
    fn redact_args_blanks_system_prompt_value() {
        // The value of `--append-system-prompt` is user prompt text
        // and must be redacted from logs (spec §7.5).
        let args = [
            "-p".to_owned(),
            "--append-system-prompt".to_owned(),
            "be terse and do not leak".to_owned(),
            "--verbose".to_owned(),
        ];
        let out = redact_args(&args);
        assert!(!out.contains("be terse"));
        assert!(!out.contains("leak"));
        assert!(out.contains("<redacted>"));
        assert!(out.contains("--append-system-prompt"));
        assert!(out.contains("--verbose"));
    }
}
