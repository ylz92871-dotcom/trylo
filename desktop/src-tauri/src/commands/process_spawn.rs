// Trylo Desktop — process_spawn Tauri command. See the architecture doc
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
use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::State;

use crate::commands::error::{io_error, CommandError};
use crate::commands::process_state::{ProcessEntry, ProcessMetadata, ProcessState};

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

/// Terminate the child process tree by OS pid. `Child::kill` is
/// not usable from the killer closure because the reaper thread
/// owns the `Child`; killing by pid lets `wait()` observe it and
/// keeps grandchildren from surviving (spec §5.3 #3).
#[cfg(windows)]
fn terminate_tree(pid: u32) -> std::io::Result<()> {
    Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .status()
        .map(|_| ())
}

#[cfg(not(windows))]
fn terminate_tree(pid: u32) -> std::io::Result<()> {
    Command::new("kill")
        .args(["-KILL", &pid.to_string()])
        .status()
        .map(|_| ())
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
    on_output: Channel<String>,
    state: State<'_, ProcessState>,
) -> Result<ProcessHandleDto, CommandError> {
    eprintln!(
        "[rust] process_spawn: label={label} command={command} args=[{}] env=[{}]",
        redact_args(&args),
        redact_env(env.as_ref())
    );

    let mut cmd = Command::new(&command);
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
    // Pipe stderr? No — the CLI also floods its debug logging to
    // stderr (dozens of lines/sec during a stream); stdout carries
    // the data we need. stderr stays null; real errors surface via
    // the exit control frame below.
    cmd.stdin(Stdio::piped());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::null());

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
    let seq = NEXT_PROCESS_SEQ.fetch_add(1, Ordering::Relaxed) + 1;
    let id = format!("proc-{seq}");

    // Keep stdin open — the CLI reads the user prompt from stdin
    // as a stream-json user message AND uses stdin for permission
    // prompts. Wrapped in MutexWriter so process_send can write.
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
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            match line {
                Ok(text) => {
                    if channel_for_read.send(text).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        eprintln!("[rust]   stdout reader thread exiting");
    });

    // MutexWriter is the same pattern as lsp_spawn: the writer
    // trait-object can't be &mut ChildStdin directly, so we wrap
    // it in a Mutex<W> where W: Write + Send.
    struct MutexWriter<W: Write + Send> {
        inner: Mutex<W>,
    }
    impl<W: Write + Send> Write for MutexWriter<W> {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.inner
                .lock()
                .expect("process writer mutex poisoned")
                .write(buf)
        }
        fn flush(&mut self) -> std::io::Result<()> {
            self.inner
                .lock()
                .expect("process writer mutex poisoned")
                .flush()
        }
    }

    // The killer terminates the child TREE by pid. It does not
    // own the Child (the reaper thread does); it signals the OS
    // and lets the reaper's wait() observe the exit.
    let killer_pid = pid;
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
                writer: Box::new(MutexWriter {
                    inner: Mutex::new(stdin),
                }),
                killer: Box::new(move || {
                    let _ = terminate_tree(killer_pid);
                }),
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
    std::thread::spawn(move || {
        let (code, signal) = match child.wait() {
            Ok(status) => (status.code(), exit_signal(status)),
            Err(_) => (None, None),
        };
        if let Ok(mut table) = table_for_exit.lock() {
            let _ = table.remove(&id_for_exit);
        }
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
        });
        let _ = channel_for_exit.send(format!("##TRYLO_PROC_EXIT##{frame}"));
    });

    eprintln!("[rust]   process {id} registered, returning DTO");
    Ok(ProcessHandleDto {
        id,
        pid,
        label,
        command: format!("{command} {cmd_args}", cmd_args = redact_args(&args)),
    })
}

#[cfg(test)]
mod tests {
    use super::{redact_args, redact_env};
    use std::collections::HashMap;

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
