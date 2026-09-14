// Trylo Desktop — Service Host Tauri commands. See
// docs/TRYLO-MIGRATION-EXECUTION-SPEC-2026-08-28.md §5.3 and
// docs/TRYLO-WORK-PHASE1-PHASE2-RUNTIME-AUDIT-AND-REMEDIATION-2026-08-28.md §3.
//
// Wires the desktop-services NDJSON stdio sidecar into the Tauri shell:
//
//   - servicehost_spawn  — spawn `<node> <host.bundle.mjs>` with piped
//                          stdin/stdout/stderr, wait for the sidecar's
//                          `ready` event on stdout, then register.
//                          Idempotent + single-flight. stdout lines are
//                          forwarded as the Tauri event
//                          `servicehost://frame`; sanitised stderr is
//                          forwarded as `servicehost://diagnostics`.
//   - servicehost_send   — write one NDJSON frame string to stdin.
//   - servicehost_stop   — kill the host. Idempotent: Ok(()) if none.
//   - servicehost_status — report running/pid/generation.
//
// Audit §3.2 fixes carried here:
//   SH-P0-1 readiness only succeeds on a real `topic:"ready"` frame — EOF
//           before that is a failure, never a success.
//   SH-P0-2 every cleanup path (stdout EOF reaper, heartbeat timeout, stop)
//           is scoped to a monotonically increasing generation id, so a
//           stale thread can never clear a replacement host.
//   SH-P0-3 `spawn_lock` serialises check → spawn → ready → register.
//   SH-P0-4 the RUST SHELL owns the heartbeat: it writes `ping` every 10s
//           and treats 30s without a `pong` as dead. The sidecar's own
//           outbound ping is disabled (TRYLO_SERVICEHOST_SIDECAR_PING=1
//           re-enables it for standalone debugging).
//   SH-P0-5 stderr is piped into a bounded, redacted tail and projected to
//           the renderer — never raw, never unbounded.

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::commands::error::{io_error, CommandError};
use crate::commands::node_runtime;
use crate::commands::servicehost_state::{
    stderr_tail, Heartbeat, ServiceHostProcess, ServiceHostState, StdinHandle,
};

/// Parent→child ping cadence (audit §3.2 SH-P0-4).
const DEFAULT_PING_MS: u64 = 10_000;
/// No pong for this long ⇒ the host is dead.
const DEFAULT_PONG_TIMEOUT_MS: u64 = 30_000;
/// Watchdog granularity. Small enough to notice a timeout promptly, large
/// enough that an idle app spends ~nothing here.
const WATCHDOG_TICK_MS: u64 = 1_000;
/// Minimum gap between two `servicehost://diagnostics` emissions. Typed as
/// `u128` to match `Duration::as_millis()` without a lossy cast.
const DIAGNOSTICS_THROTTLE_MS: u128 = 400;

/// Stable, renderer-facing reason codes (audit §3.2 SH-P0-2).
mod reason {
    pub const EXITED: &str = "servicehost_exited";
    pub const HEARTBEAT_TIMEOUT: &str = "servicehost_heartbeat_timeout";
}

fn env_ms(name: &str, default: u64, min: u64, max: u64) -> u64 {
    std::env::var(name)
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .map_or(default, |ms| ms.clamp(min, max))
}

fn ping_interval() -> Duration {
    Duration::from_millis(env_ms(
        "TRYLO_SERVICEHOST_PING_MS",
        DEFAULT_PING_MS,
        200,
        600_000,
    ))
}

fn pong_timeout() -> Duration {
    Duration::from_millis(env_ms(
        "TRYLO_SERVICEHOST_PONG_TIMEOUT_MS",
        DEFAULT_PONG_TIMEOUT_MS,
        500,
        600_000,
    ))
}

/// Resolve the host bundle path. Packaged: the bundled
/// `resources/desktop-services/dist/host.bundle.mjs`. Dev: the unbundled
/// `src/host.mjs`, falling back to the same names two levels above
/// `src-tauri` (the repo root).
///
/// The repo-root `dist/host.bundle.mjs` is only rebuilt by
/// `prepare-sidecars` (packaging); between sidecar source changes it goes
/// stale, and a dev shell that loaded it would answer every `tooling.*`
/// request with UNKNOWN_METHOD while the sidecar itself looks healthy
/// (A02/A03 of the 2026-09-02 manual acceptance). Debug builds therefore
/// always run the source directly; a release build from this repo keeps
/// bundle-first for checkouts without a sidecar dev environment.
fn resolve_host_script(resource_dir: Option<&std::path::Path>) -> Option<PathBuf> {
    let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let repo_root = manifest.ancestors().nth(2)?;
    let unbundled = repo_root
        .join("desktop-services")
        .join("src")
        .join("host.mjs");
    let bundled = repo_root
        .join("desktop-services")
        .join("dist")
        .join("host.bundle.mjs");
    if cfg!(debug_assertions) {
        if unbundled.is_file() {
            return Some(unbundled);
        }
        if bundled.is_file() {
            return Some(bundled);
        }
    } else {
        if let Some(dir) = resource_dir {
            let candidate = dir
                .join("desktop-services")
                .join("dist")
                .join("host.bundle.mjs");
            if candidate.is_file() {
                return Some(candidate);
            }
        }
        if bundled.is_file() {
            return Some(bundled);
        }
        if unbundled.is_file() {
            return Some(unbundled);
        }
    }
    None
}

#[derive(Debug, Serialize)]
pub struct ServiceHostSpawnDto {
    pub pid: u32,
    pub script: String,
    /// Generation id of this host instance; every later cleanup is scoped
    /// to it (audit §3.2 SH-P0-2).
    pub generation: u64,
}

#[derive(Debug, Serialize)]
pub struct ServiceHostStatusDto {
    pub running: bool,
    pub pid: Option<u32>,
    pub generation: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceHostPathsDto {
    pub sidecars_dir: String,
    pub app_data_dir: String,
}

/// Resolve the sidecars root (the bridge's `extensionPath`): packaged
/// builds carry it under `resource_dir/sidecars`, dev falls back to
/// `<repo>/desktop/sidecars` — same strategy as `resolve_host_script`.
fn resolve_sidecars_dir(app: &AppHandle) -> String {
    if let Ok(resource_dir) = app.path().resource_dir() {
        let candidate = resource_dir.join("sidecars");
        if candidate.exists() {
            return candidate.to_string_lossy().to_string();
        }
    }
    let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    if let Some(repo_root) = manifest.ancestors().nth(2) {
        let candidate = repo_root.join("desktop").join("sidecars");
        if candidate.exists() {
            return candidate.to_string_lossy().to_string();
        }
    }
    String::new()
}

/// Renderer-facing path resolution for the service host env vars. Only the
/// shell knows where resources live (packaged) or where the repo sits
/// (dev); the sidecar's bridge needs the real absolute sidecars path.
// Tauri commands must take `AppHandle` by value — `&AppHandle` does not
// implement `CommandArg`.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn servicehost_paths(app: AppHandle) -> Result<ServiceHostPathsDto, CommandError> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| io_error("(servicehost)", std::io::Error::other(e.to_string())))?;
    Ok(ServiceHostPathsDto {
        sidecars_dir: resolve_sidecars_dir(&app),
        app_data_dir: app_data_dir.to_string_lossy().to_string(),
    })
}

/// Terminate the child process tree by OS pid.
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

/// The D→S ping frame. Matches what `host.mjs` answers with `pong`.
fn ping_frame() -> String {
    format!("{}\n", serde_json::json!({ "version": 1, "type": "ping" }))
}

fn is_ready_frame(text: &str) -> bool {
    match serde_json::from_str::<serde_json::Value>(text) {
        Ok(v) => {
            v.get("type").and_then(|t| t.as_str()) == Some("event")
                && v.get("topic").and_then(|t| t.as_str()) == Some("ready")
        }
        Err(_) => false,
    }
}

/// The S→D pong the sidecar sends in answer to our ping.
fn is_pong_frame(text: &str) -> bool {
    match serde_json::from_str::<serde_json::Value>(text) {
        Ok(v) => v.get("type").and_then(|t| t.as_str()) == Some("pong"),
        Err(_) => false,
    }
}

#[allow(clippy::too_many_lines)]
#[tauri::command]
pub async fn servicehost_spawn(
    app: AppHandle,
    sidecars_dir: Option<String>,
    app_data_dir: Option<String>,
    hermes_python: Option<String>,
    state: State<'_, ServiceHostState>,
) -> Result<ServiceHostSpawnDto, CommandError> {
    // Hold the gate for the entire check → spawn → ready → register chain.
    // React StrictMode and future windows may call this concurrently.
    let _spawn_guard = state.spawn_lock.lock().await;

    // Idempotent: return an already-live host's pid without cloning the
    // writer/kill.
    if let Ok(guard) = state.daemon.lock() {
        if let Some(proc) = guard.as_ref() {
            return Ok(ServiceHostSpawnDto {
                pid: proc.pid,
                script: "<running>".to_string(),
                generation: proc.generation,
            });
        }
    }

    let resource_dir = app.path().resource_dir().ok();
    let script = resolve_host_script(resource_dir.as_deref()).ok_or_else(|| {
        io_error(
            "(servicehost)",
            std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "host script not found (resources/desktop-services/dist/host.bundle.mjs)",
            ),
        )
    })?;

    // SH-P0-5 / audit §2.3 W4: one resolver shared with workd.rs. The
    // installed app must use the bundled interpreter, never PATH `node`.
    let node = node_runtime::resolve_node(resource_dir.as_deref());

    let mut cmd = Command::new(&node.program);
    cmd.arg(&script);
    cmd.env(
        "TRYLO_SIDECARS_DIR",
        sidecars_dir.unwrap_or_else(|| resolve_sidecars_dir(&app)),
    );
    cmd.env("TRYLO_APP_DATA_DIR", app_data_dir.unwrap_or_default());
    if let Some(hp) = hermes_python {
        if !hp.is_empty() {
            cmd.env("HERMES_PYTHON", hp);
        }
    }
    // The shell owns the heartbeat direction now; leave the sidecar's own
    // outbound ping off unless someone is debugging it standalone.
    if std::env::var("TRYLO_SERVICEHOST_SIDECAR_PING").is_err() {
        cmd.env("TRYLO_SERVICEHOST_SIDECAR_PING", "0");
    }
    cmd.stdin(Stdio::piped());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| {
        io_error(
            "(servicehost)",
            std::io::Error::other(format!(
                "failed to spawn service host with {}: {e}",
                node_runtime::describe(&node)
            )),
        )
    })?;
    let pid = child.id();
    let generation = state.next_generation();
    // This generation gets a fresh, empty stderr tail.
    stderr_tail().clear();

    let stdout = child.stdout.take().ok_or_else(|| {
        io_error(
            "(servicehost)",
            std::io::Error::other("no stdout from host"),
        )
    })?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| io_error("(servicehost)", std::io::Error::other("no stdin from host")))?;
    let stderr = child.stderr.take();

    // SH-P0-5: stderr is piped (was `Stdio::null()`) into a bounded,
    // redacted tail and throttled out as `servicehost://diagnostics`.
    if let Some(stderr) = stderr {
        let app_handle = app.clone();
        let pid_for_thread = pid;
        let generation_for_thread = generation;
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stderr);
            let mut buffer = Vec::new();
            // Emit the first line immediately, then throttle.
            let mut last_emit: Option<Instant> = None;
            let mut saw_any = false;
            loop {
                buffer.clear();
                match reader.read_until(b'\n', &mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {}
                }
                let text = String::from_utf8_lossy(&buffer).to_string();
                stderr_tail().push_chunk(&text);
                saw_any = true;
                let now = Instant::now();
                let due = last_emit.map_or(true, |last| {
                    now.saturating_duration_since(last).as_millis() >= DIAGNOSTICS_THROTTLE_MS
                });
                if due {
                    last_emit = Some(now);
                    emit_diagnostics(
                        &app_handle,
                        pid_for_thread,
                        generation_for_thread,
                        &stderr_tail().snapshot(),
                    );
                }
            }
            // Always flush once more at EOF so the last crash line lands.
            if saw_any {
                emit_diagnostics(
                    &app_handle,
                    pid_for_thread,
                    generation_for_thread,
                    &stderr_tail().snapshot(),
                );
            }
        });
    }

    // Readiness timeout: TRYLO_SERVICEHOST_READY_TIMEOUT_MS clamped 3–60s.
    let ready_timeout = env_ms("TRYLO_SERVICEHOST_READY_TIMEOUT_MS", 15_000, 500, 60_000);

    // Read thread owns the Child: wait for the `ready` event, forward every
    // stdout line, observe pongs, and clean up only its own generation.
    let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<(), String>>();
    let app_handle = app.clone();
    let script_for_thread = script.to_string_lossy().to_string();
    let exited = Arc::new(AtomicBool::new(false));
    let exited_for_thread = Arc::clone(&exited);
    let heartbeat = Heartbeat::new();
    let heartbeat_for_thread = heartbeat.clone();
    let generation_for_thread = generation;

    std::thread::spawn(move || {
        let mut child = child;
        let mut announced_ready = false;
        let stdout_reader = BufReader::new(stdout);
        for line in stdout_reader.lines() {
            let text = match line {
                Ok(text) => text,
                Err(error) => {
                    // SH-P0-1: a read error before readiness is a failure,
                    // never a success signal.
                    if !announced_ready {
                        let _ = ready_tx.send(Err(format!("failed to read host stdout: {error}")));
                    }
                    break;
                }
            };
            if text.is_empty() {
                continue;
            }
            if is_pong_frame(&text) {
                heartbeat_for_thread.mark_alive();
                continue;
            }
            if !announced_ready && is_ready_frame(&text) {
                announced_ready = true;
                let _ = ready_tx.send(Ok(()));
            }
            let _ = app_handle.emit("servicehost://frame", text);
        }
        let status = child.wait().ok();
        exited_for_thread.store(true, Ordering::Release);
        if !announced_ready {
            // SH-P0-1: EOF before a real ready frame is a spawn failure.
            let code = status.as_ref().and_then(std::process::ExitStatus::code);
            let _ = ready_tx.send(Err(format!(
                "host exited before ready (code={code:?}); stderr: {}",
                join_tail(&stderr_tail().snapshot())
            )));
        }

        heartbeat_for_thread.stop();
        // If the watchdog already terminated this generation it has emitted
        // the timeout exit; don't emit a second, contradictory one.
        if heartbeat_for_thread.was_killed() {
            return;
        }
        // Only clear OUR generation — a replacement may already own the slot.
        let managed = app_handle.state::<ServiceHostState>();
        if managed.clear_generation(generation_for_thread) {
            let code = status.as_ref().and_then(std::process::ExitStatus::code);
            emit_exit(&app_handle, pid, generation_for_thread, code, reason::EXITED);
        }
    });

    // Wait for readiness (bounded). Only `Ready` breaks the loop; `Err`
    // (read failure, EOF-before-ready) and the timeout are both failures.
    let ready_deadline = Instant::now() + Duration::from_millis(ready_timeout);
    let mut pending_error: Option<String> = None;
    loop {
        match ready_rx.recv_timeout(Duration::from_millis(50)) {
            Ok(Ok(())) => break,
            Ok(Err(reason_text)) => {
                pending_error = Some(reason_text);
                break;
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) if Instant::now() <= ready_deadline => {}
            Err(_) => {
                pending_error = Some(format!(
                    "host did not emit ready within {ready_timeout}ms; stderr: {}",
                    join_tail(&stderr_tail().snapshot())
                ));
                break;
            }
        }
    }
    if let Some(error) = pending_error {
        heartbeat.stop();
        let _ = terminate_tree(pid);
        return Err(io_error("(servicehost)", std::io::Error::other(error)));
    }

    // Register the send side + kill closure; the Child itself is owned by the
    // read thread (which waits on it), so we only store writer/kill/pid.
    let stdin_handle = StdinHandle::new(stdin);
    let killer: Box<dyn FnMut() + Send + Sync> = Box::new(move || {
        let _ = terminate_tree(pid);
    });
    *state.daemon.lock().map_err(|_| {
        io_error(
            "(servicehost)",
            std::io::Error::other("servicehost state poisoned".to_string()),
        )
    })? = Some(ServiceHostProcess {
        writer: stdin_handle.clone(),
        killer,
        pid,
        generation,
        heartbeat: heartbeat.clone(),
    });

    // Close the narrow ready→register race: if the reaper observed exit
    // before the slot was populated it could not clear it. Re-check now.
    if exited.load(Ordering::Acquire) {
        state.clear_generation(generation);
        heartbeat.stop();
        return Err(io_error(
            "(servicehost)",
            std::io::Error::other("host exited immediately after ready"),
        ));
    }

    // SH-P0-4: the shell owns the heartbeat. Ping every 10s; kill on 30s
    // without a pong, scoped to this generation.
    let watchdog_app = app.clone();
    let watchdog_heartbeat = heartbeat.clone();
    std::thread::spawn(move || {
        let interval = ping_interval();
        let timeout = pong_timeout();
        let tick = Duration::from_millis(WATCHDOG_TICK_MS);
        let mut since_ping = Duration::ZERO;
        loop {
            std::thread::sleep(tick);
            if watchdog_heartbeat.is_stopped() {
                return;
            }
            since_ping += tick;
            if since_ping >= interval {
                since_ping = Duration::ZERO;
                if stdin_handle.write_frame(&ping_frame()).is_err() {
                    // Broken pipe: the host is gone. The exit reaper owns
                    // the cleanup, so just retire this watchdog.
                    return;
                }
            }
            let timeout_ms = u64::try_from(timeout.as_millis()).unwrap_or(u64::MAX);
            if watchdog_heartbeat.age_ms() >= timeout_ms && watchdog_heartbeat.claim_kill() {
                let _ = terminate_tree(pid);
                let managed = watchdog_app.state::<ServiceHostState>();
                if managed.clear_generation(generation) {
                    emit_exit(
                        &watchdog_app,
                        pid,
                        generation,
                        None,
                        reason::HEARTBEAT_TIMEOUT,
                    );
                }
                watchdog_heartbeat.stop();
                return;
            }
        }
    });

    Ok(ServiceHostSpawnDto {
        pid,
        script: script_for_thread,
        generation,
    })
}

fn join_tail(lines: &[String]) -> String {
    if lines.is_empty() {
        return "(no stderr)".to_string();
    }
    lines.join(" | ")
}

fn emit_diagnostics(app: &AppHandle, pid: u32, generation: u64, lines: &[String]) {
    if lines.is_empty() {
        return;
    }
    let _ = app.emit(
        "servicehost://diagnostics",
        serde_json::json!({
            "pid": pid,
            "generation": generation,
            "lines": lines,
        }),
    );
}

/// Structured exit: a Tauri event for tooling plus a typed NDJSON frame on
/// the existing channel, so ServicesClient/ServiceManager need no second
/// listener.
fn emit_exit(app: &AppHandle, pid: u32, generation: u64, exit_code: Option<i32>, reason_code: &str) {
    let payload = serde_json::json!({
        "pid": pid,
        "generation": generation,
        "exitCode": exit_code,
        "reasonCode": reason_code,
    });
    let _ = app.emit("servicehost://exit", payload.clone());
    let _ = app.emit(
        "servicehost://frame",
        serde_json::json!({
            "version": 1,
            "type": "event",
            "topic": "servicehost.exit",
            "payload": payload,
        })
        .to_string(),
    );
}

/// Write one NDJSON frame string to the sidecar's stdin.
#[tauri::command]
pub async fn servicehost_send(
    frame: String,
    state: State<'_, ServiceHostState>,
) -> Result<(), CommandError> {
    // Clone the handle out of the slot so the write never holds the daemon
    // lock (a blocked child must not block `servicehost_stop`).
    let writer = {
        let Ok(guard) = state.daemon.lock() else {
            return Err(io_error(
                "(servicehost)",
                std::io::Error::other("servicehost state poisoned".to_string()),
            ));
        };
        let Some(proc) = guard.as_ref() else {
            return Err(io_error(
                "(servicehost)",
                std::io::Error::new(
                    std::io::ErrorKind::NotConnected,
                    "service host is not running",
                ),
            ));
        };
        proc.writer.clone()
    };
    writer.write_frame(&frame).map_err(|e| {
        io_error(
            "(servicehost)",
            std::io::Error::other(format!("failed to write to host stdin: {e}")),
        )
    })
}

/// Kill the host. Idempotent: Ok(()) if no host is running.
#[tauri::command]
pub async fn servicehost_stop(state: State<'_, ServiceHostState>) -> Result<(), CommandError> {
    servicehost_shutdown_now(&state);
    Ok(())
}

/// §6.5 exit sequence, callable from sync contexts (window close):
/// best-effort `pet.disable` request (the sidecar's bridge sends the
/// UDP `detach`), then kill the child tree and clear the slot. The
/// short grace window lets the sidecar's stdin-close handler run the
/// same disable path before the force kill.
pub fn servicehost_shutdown_now(state: &ServiceHostState) {
    let Ok(mut guard) = state.daemon.lock() else {
        return;
    };
    if let Some(mut proc) = guard.take() {
        // Retire this generation's watchdog first: otherwise it would keep
        // pinging (or kill the NEXT host after its pong timeout).
        proc.heartbeat.stop();
        let frame = format!(
            "{}\n",
            serde_json::json!({
                "version": 1,
                "type": "request",
                "id": "shutdown",
                "method": "pet.disable"
            })
        );
        let _ = proc.writer.write_all(frame.as_bytes());
        let _ = proc.writer.flush();
        std::thread::sleep(Duration::from_millis(150));
        (proc.killer)();
    }
}

/// Bounded, redacted stderr diagnostics for the CURRENT/most recent host.
/// The renderer polls this after a failed spawn or an unexpected exit so the
/// user sees a real cause instead of "the pet did not appear".
#[tauri::command]
pub async fn servicehost_diagnostics() -> Result<Vec<String>, CommandError> {
    Ok(stderr_tail().snapshot())
}

/// Report whether a host is running + its pid/generation.
#[tauri::command]
pub async fn servicehost_status(
    state: State<'_, ServiceHostState>,
) -> Result<ServiceHostStatusDto, CommandError> {
    let guard = state.daemon.lock().map_err(|_| {
        io_error(
            "(servicehost)",
            std::io::Error::other("servicehost state poisoned".to_string()),
        )
    })?;
    match guard.as_ref() {
        Some(proc) => Ok(ServiceHostStatusDto {
            running: true,
            pid: Some(proc.pid),
            generation: Some(proc.generation),
        }),
        None => Ok(ServiceHostStatusDto {
            running: false,
            pid: None,
            generation: None,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ready_detection_requires_a_ready_topic() {
        let ready = serde_json::json!({"version":1,"type":"event","topic":"ready","payload":{}});
        assert!(is_ready_frame(&ready.to_string()));
        assert!(!is_ready_frame(
            &serde_json::json!({"version":1,"type":"event","topic":"pet.status"}).to_string()
        ));
        assert!(!is_ready_frame("not json"));
        // A pong is NOT readiness — SH-P0-1.
        assert!(!is_ready_frame(
            &serde_json::json!({"version":1,"type":"pong"}).to_string()
        ));
    }

    #[test]
    fn pong_detection() {
        assert!(is_pong_frame(
            &serde_json::json!({"version":1,"type":"pong"}).to_string()
        ));
        assert!(!is_pong_frame(
            &serde_json::json!({"version":1,"type":"ping"}).to_string()
        ));
        assert!(!is_pong_frame("garbage"));
    }

    #[test]
    fn ping_frame_is_a_single_ndjson_line() {
        let frame = ping_frame();
        assert!(frame.ends_with('\n'));
        assert_eq!(frame.matches('\n').count(), 1);
        let parsed: serde_json::Value =
            serde_json::from_str(frame.trim_end()).expect("valid json");
        assert_eq!(parsed["type"], "ping");
        assert_eq!(parsed["version"], 1);
    }

    #[test]
    fn generation_scoped_cleanup_never_removes_a_replacement() {
        let state = ServiceHostState::default();
        let first = state.next_generation();
        let second = state.next_generation();
        assert_eq!(first, 1);
        assert_eq!(second, 2);
        // Nothing is registered, so no generation can be cleared. With a
        // live slot, `clear_generation` compares ids — see the state module
        // tests for the two-host race.
        assert!(!state.clear_generation(first));
        assert!(!state.clear_generation(second));
    }

    #[test]
    fn heartbeat_timeout_and_liveness() {
        let heartbeat = Heartbeat::new();
        assert!(heartbeat.age_ms() < 1_000);
        assert!(!heartbeat.was_killed());
        assert!(heartbeat.claim_kill());
        // Exactly one owner may terminate a generation (SH-P0-4).
        assert!(!heartbeat.claim_kill());
        assert!(heartbeat.was_killed());
    }

    #[test]
    fn watchdog_env_clamps_are_sane() {
        assert!(ping_interval() >= Duration::from_millis(200));
        assert!(pong_timeout() >= Duration::from_millis(500));
    }

    #[test]
    fn join_tail_reports_an_empty_tail() {
        assert_eq!(join_tail(&[]), "(no stderr)");
        assert_eq!(join_tail(&["a".to_string(), "b".to_string()]), "a | b");
    }
}
