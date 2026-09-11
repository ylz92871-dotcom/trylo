// Trylo Desktop — trylo-workd Tauri commands. See
// ../../../work/README.md and ../../../work/STRUCTURE.md (Phase 0), plus
// docs/TRYLO-WORK-PHASE1-PHASE2-RUNTIME-AUDIT-AND-REMEDIATION-2026-08-28.md §2.
//
// Three commands wire the Work sub-app into the Tauri shell:
//
//   workd_spawn  — start the daemon (Node sidecar). Idempotent + single
//                  flight: if a daemon is already running, returns its
//                  existing URL/PID instead of erroring. Blocks until the
//                  daemon actually binds its port, so the renderer can
//                  connect immediately after the call resolves.
//   workd_stop   — kill the daemon. Idempotent: returns Ok(()) if none.
//   workd_status — report whether a daemon is running + its
//                  URL/PID. Used by the renderer to decide
//                  whether to call `workd_spawn` first.
//   workd_diagnostics — bounded, redacted stderr tail of the most recent
//                  daemon (W-P0-3: the installed user has no terminal).
//
// The renderer calls the daemon's Control Plane endpoints
// directly via fetch()/WebSocket (the daemon binds 127.0.0.1 by
// default). No HTTP proxying through Tauri commands — that
// would just add latency and a second serialization layer.
//
// Resource resolution (§2.3 Task W4): the installed app runs
// `<resource_dir>/work/bin/trylo-workd.mjs` with the bundled
// `<resource_dir>/runtime/node/win-x64/node.exe`. Neither the source repo
// nor a system-wide Node is required at runtime. Dev runs fall back to the
// repo checkout and the PATH `node`.

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::OnceLock;

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::commands::diagnostics::DiagnosticTail;
use crate::commands::error::{io_error, CommandError};
use crate::commands::node_runtime;
use crate::commands::workd_state::{WorkdEntry, WorkdState};

const DEFAULT_PORT: u16 = 47821;
const DEFAULT_HOST: &str = "127.0.0.1";

#[cfg(target_os = "windows")]
fn fill_secure_random(bytes: &mut [u8]) -> std::io::Result<()> {
    use std::ffi::c_void;

    #[link(name = "bcrypt")]
    extern "system" {
        fn BCryptGenRandom(algorithm: *mut c_void, buffer: *mut u8, length: u32, flags: u32)
            -> i32;
    }

    const USE_SYSTEM_PREFERRED_RNG: u32 = 0x0000_0002;
    let length = u32::try_from(bytes.len())
        .map_err(|_| std::io::Error::other("random buffer is too large"))?;
    // SAFETY: BCryptGenRandom writes exactly `length` bytes to the valid,
    // mutable buffer and accepts a null algorithm handle with this flag.
    let status = unsafe {
        BCryptGenRandom(
            std::ptr::null_mut(),
            bytes.as_mut_ptr(),
            length,
            USE_SYSTEM_PREFERRED_RNG,
        )
    };
    if status == 0 {
        Ok(())
    } else {
        Err(std::io::Error::other(format!(
            "BCryptGenRandom failed with status {status:#x}"
        )))
    }
}

#[cfg(not(target_os = "windows"))]
fn fill_secure_random(bytes: &mut [u8]) -> std::io::Result<()> {
    use std::io::Read;

    std::fs::File::open("/dev/urandom")?.read_exact(bytes)
}

fn generate_control_plane_token() -> std::io::Result<String> {
    use std::fmt::Write as _;

    let mut bytes = [0_u8; 32];
    fill_secure_random(&mut bytes)?;
    Ok(bytes
        .iter()
        .fold(String::with_capacity(bytes.len() * 2), |mut token, byte| {
            let _ = write!(token, "{byte:02x}");
            token
        }))
}

/// Stable, renderer-facing reason codes (audit §2.3 Task W1).
mod reason {
    pub const SCRIPT_MISSING: &str = "workd_script_missing";
    pub const NODE_MISSING: &str = "workd_node_missing";
    pub const SPAWN_FAILED: &str = "workd_spawn_failed";
    pub const EXITED_BEFORE_READY: &str = "workd_exited_before_ready";
    pub const READY_TIMEOUT: &str = "workd_ready_timeout";
    pub const PORT_BUSY: &str = "workd_port_busy";
}

/// Bounded, redacted stderr tail shared by the pumping thread and the
/// spawn command's failure paths. Cleared at the start of every spawn.
static STDERR_TAIL: OnceLock<DiagnosticTail> = OnceLock::new();

fn stderr_tail() -> &'static DiagnosticTail {
    STDERR_TAIL.get_or_init(DiagnosticTail::new)
}

fn join_tail() -> String {
    let lines = stderr_tail().snapshot();
    if lines.is_empty() {
        return "(no stderr)".to_string();
    }
    lines.join(" | ")
}

/// Fail with a stable reason code AND the sanitised stderr tail attached.
fn fail(reason_code: &str, detail: impl Into<String>) -> CommandError {
    io_error(
        "(workd)",
        std::io::Error::other(format!(
            "[{reason_code}] {}; stderr: {}",
            detail.into(),
            join_tail()
        )),
    )
}

#[derive(Debug, Serialize)]
pub struct WorkdSpawnDto {
    pub pid: u32,
    pub host: String,
    pub port: u16,
    pub url: String,
    pub version: String,
    /// Opaque per-launch credential for the local WebSocket handshake. Never
    /// written to diagnostics or process output.
    pub token: String,
    /// Where the script + interpreter were resolved from
    /// (`bundled` | `dev-checkout` | `system-path` | `env`). Diagnostics
    /// only — never used for control flow.
    pub source: String,
}

#[derive(Debug, Serialize)]
pub struct WorkdStatusDto {
    pub running: bool,
    pub pid: Option<u32>,
    pub host: Option<String>,
    pub port: Option<u16>,
    pub url: Option<String>,
}

/// Pump one stdio stream into the sanitised tail. Runs on its own thread so
/// a chatty daemon can never block the readiness loop.
fn pump_stream<R: std::io::Read + Send + 'static>(stream: R) {
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stream);
        let mut buffer = Vec::new();
        loop {
            buffer.clear();
            match reader.read_until(b'\n', &mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
            let line = String::from_utf8_lossy(&buffer);
            // The Control Plane emits one of these for every status poll. It
            // is a transport heartbeat, not task progress, and printing it
            // made a paused task look busy while flooding the terminal.
            if line.trim() == "[ControlPlane] request" {
                continue;
            }
            stderr_tail().push_chunk(&line);
            // Dev aid: the terminal that launched Tauri still sees the
            // sanitised line. Installed builds have no terminal, so this
            // is a no-op in practice.
            eprintln!("(workd) {}", line.trim_end());
        }
    });
}

#[allow(clippy::too_many_arguments, clippy::too_many_lines)]
#[tauri::command]
pub async fn workd_spawn(
    app: AppHandle,
    port: Option<u16>,
    host: Option<String>,
    // "stub" (default) runs the in-process HTTP stub. "real"
    // shells out to vendor/cowork-os/bin/coworkd-node.js, which
    // builds and runs CoWork-OS's full agent daemon. Requires
    // `npm install` in vendor/cowork-os/ first.
    mode: Option<String>,
    workd_path: Option<String>,
    env: Option<std::collections::HashMap<String, String>>,
    // Reuse the current credential during a supervised restart. Initial
    // launches omit this and receive a cryptographically random token.
    token: Option<String>,
    state: State<'_, WorkdState>,
) -> Result<WorkdSpawnDto, CommandError> {
    // Single-flight gate. Held for the entire spawn + readiness-poll so
    // concurrent callers (React 18 StrictMode mount-twice in dev, a
    // `handleSettingsSave` overlapping the auto-spawn, future windows)
    // result in exactly one real daemon startup.
    let _spawn_guard = state.spawn_lock.lock().await;

    let port = port.unwrap_or(DEFAULT_PORT);
    let host = host.unwrap_or_else(|| DEFAULT_HOST.to_string());
    let mode = mode.unwrap_or_else(|| "stub".to_string());

    // Idempotent only for a process that is still alive. A crashed child used
    // to remain in WorkdState forever, so every later spawn returned
    // "running" while the renderer received ERR_CONNECTION_REFUSED.
    let mut retained_token: Option<String> = None;
    {
        let Ok(mut guard) = state.daemon.lock() else {
            return Err(io_error(
                "(workd)",
                std::io::Error::other("workd state poisoned".to_string()),
            ));
        };
        let mut stale_process = false;
        if let Some(entry) = guard.as_mut() {
            if let Some(child) = entry.child.as_mut() {
                match child.try_wait() {
                    Ok(None) if daemon_alive(entry.port, entry.host.as_str()) => {
                        return Ok(WorkdSpawnDto {
                            pid: entry.pid,
                            host: entry.host.clone(),
                            port: entry.port,
                            url: format!("http://{}:{}", entry.host, entry.port),
                            version: "phase1-stub-or-real".to_string(),
                            token: entry.token.clone(),
                            source: "running".to_string(),
                        });
                    }
                    Ok(None | Some(_)) | Err(_) => stale_process = true,
                }
            } else {
                stale_process = true;
            }
        }
        if stale_process {
            // A live wrapper without a listening Control Plane is not useful
            // and must not be orphaned when its handle is cleared.
            if let Some(mut entry) = guard.take() {
                retained_token = Some(entry.token.clone());
                if let Some(mut child) = entry.child.take() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
        }
    }

    let requested_token = token
        .filter(|value| !value.trim().is_empty())
        .or(retained_token);
    let control_plane_token = if let Some(value) = requested_token {
        if value.len() < 32 {
            return Err(fail(
                reason::SPAWN_FAILED,
                "Control Plane token must be at least 32 bytes",
            ));
        }
        value
    } else {
        generate_control_plane_token().map_err(|error| {
            fail(
                reason::SPAWN_FAILED,
                format!("failed to generate Control Plane credential: {error}"),
            )
        })?
    };

    stderr_tail().clear();
    let resource_dir = app.path().resource_dir().ok();

    // §2.3 Task W4: resolve the wrapper from the packaged resources first.
    let resolved_script: Option<PathBuf> = match workd_path {
        Some(explicit) if !explicit.trim().is_empty() => Some(PathBuf::from(explicit)),
        _ => node_runtime::resolve_workd_script(resource_dir.as_deref()).map(|r| r.program),
    };
    let Some(script_path) = resolved_script else {
        return Err(fail(
            reason::SCRIPT_MISSING,
            "trylo-workd.mjs not found in resources/work/bin or <repo>/work/bin",
        ));
    };
    if !script_path.exists() {
        return Err(fail(
            reason::SCRIPT_MISSING,
            format!("trylo-workd script not found at {}", script_path.display()),
        ));
    }

    // An unknown listener cannot be adopted safely: its authentication token
    // is unknowable, so returning success here only creates an endless
    // reconnect loop. Surface the occupied port instead.
    if daemon_alive(port, host.as_str()) {
        return Err(fail(
            reason::PORT_BUSY,
            format!("port {port} is already occupied by an unmanaged process"),
        ));
    }

    let node = node_runtime::resolve_node(resource_dir.as_deref());
    let mut cmd = Command::new(&node.program);
    cmd.arg(&script_path);
    // Pass port/host via env so the daemon picks them up.
    cmd.env("TRYLO_WORKD_PORT", port.to_string());
    cmd.env("TRYLO_WORKD_HOST", &host);
    // Pass mode (stub|real) so the wrapper picks the right backend.
    cmd.env("TRYLO_WORKD_MODE", &mode);
    // Forward caller-provided env vars (LLM keys, model, endpoint) so the
    // real-mode daemon authenticates with the same provider as Code.
    if let Some(extra_env) = &env {
        for (key, value) in extra_env {
            cmd.env(key, value);
        }
    }
    // Set this after caller-provided environment variables so credentials from
    // settings can never desynchronise the renderer and the child process.
    cmd.env("COWORK_CONTROL_PLANE_TOKEN", &control_plane_token);
    // §2.3 W-P0-3: pipe BOTH streams. stdout/stderr used to be inherited,
    // which meant an installed user saw nothing when the daemon died.
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => {
            return Err(fail(
                reason::PORT_BUSY,
                format!("port {port} is busy and no daemon is responding"),
            ));
        }
        Err(e) => {
            let code = if node.source == node_runtime::RuntimeSource::SystemPath
                && e.kind() == std::io::ErrorKind::NotFound
            {
                reason::NODE_MISSING
            } else {
                reason::SPAWN_FAILED
            };
            return Err(fail(
                code,
                format!(
                    "failed to spawn trylo-workd with {}: {e}",
                    node_runtime::describe(&node)
                ),
            ));
        }
    };
    let pid = child.id();

    if let Some(stdout) = child.stdout.take() {
        pump_stream(stdout);
    }
    if let Some(stderr) = child.stderr.take() {
        pump_stream(stderr);
    }

    // Wait for the child to actually bind its port before returning.
    // Baseline measurements: ~7.5s warm in real mode, ~82s cold (shim
    // build + better-sqlite3 + full service init), so the default ceiling
    // is 120s. Override with TRYLO_WORKD_READY_TIMEOUT_MS (5s..600s).
    let ready_timeout = std::env::var("TRYLO_WORKD_READY_TIMEOUT_MS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .map_or(120_000, |ms| ms.clamp(5_000, 600_000));
    let ready_deadline =
        std::time::Instant::now() + std::time::Duration::from_millis(ready_timeout);
    loop {
        if daemon_alive(port, host.as_str()) {
            break;
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                return Err(fail(
                    reason::EXITED_BEFORE_READY,
                    format!(
                        "trylo-workd exited before becoming ready (code={:?})",
                        status.code()
                    ),
                ));
            }
            Ok(None) => {} // still running
            Err(e) => {
                return Err(fail(
                    reason::EXITED_BEFORE_READY,
                    format!("failed to poll trylo-workd status: {e}"),
                ));
            }
        }
        if std::time::Instant::now() > ready_deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(fail(
                reason::READY_TIMEOUT,
                format!(
                    "trylo-workd did not bind {host}:{port} within {}s",
                    ready_timeout / 1000
                ),
            ));
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }

    let entry = WorkdEntry {
        child: Some(child),
        pid,
        host: host.clone(),
        port,
        token: control_plane_token.clone(),
    };

    let mut guard = state.daemon.lock().map_err(|_| {
        io_error(
            "(workd)",
            std::io::Error::other("workd state poisoned".to_string()),
        )
    })?;
    *guard = Some(entry);

    Ok(WorkdSpawnDto {
        pid,
        url: format!("http://{host}:{port}"),
        host,
        port,
        version: format!("phase1-{mode}"),
        token: control_plane_token,
        source: node.source.as_str().to_string(),
    })
}

#[tauri::command]
pub async fn workd_stop(state: State<'_, WorkdState>) -> Result<(), CommandError> {
    let mut guard = state.daemon.lock().map_err(|_| {
        io_error(
            "(workd)",
            std::io::Error::other("workd state poisoned".to_string()),
        )
    })?;
    if let Some(mut entry) = guard.take() {
        if let Some(mut child) = entry.child.take() {
            // Best-effort kill. We don't care about the exit
            // status — the renderer doesn't await it.
            let _ = child.kill();
            let _ = child.wait();
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn workd_status(state: State<'_, WorkdState>) -> Result<WorkdStatusDto, CommandError> {
    let mut guard = state.daemon.lock().map_err(|_| {
        io_error(
            "(workd)",
            std::io::Error::other("workd state poisoned".to_string()),
        )
    })?;
    if let Some(entry) = guard.as_mut() {
        if let Some(child) = entry.child.as_mut() {
            if matches!(child.try_wait(), Ok(None)) && daemon_alive(entry.port, entry.host.as_str())
            {
                return Ok(WorkdStatusDto {
                    running: true,
                    pid: Some(entry.pid),
                    host: Some(entry.host.clone()),
                    port: Some(entry.port),
                    url: Some(format!("http://{}:{}", entry.host, entry.port)),
                });
            }
        }
        if let Some(mut entry) = guard.take() {
            if let Some(mut child) = entry.child.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
    Ok(WorkdStatusDto {
        running: false,
        pid: None,
        host: None,
        port: None,
        url: None,
    })
}

/// Bounded, redacted stderr tail of the most recent daemon attempt. The
/// renderer shows this after a failed spawn so the user gets a real cause
/// instead of "WebSocket refused".
#[tauri::command]
pub async fn workd_diagnostics() -> Result<Vec<String>, CommandError> {
    Ok(stderr_tail().snapshot())
}

/// TCP probe — returns true if *something* is listening on
/// `port`. Used by `workd_spawn` to reject unmanaged listeners and by the
/// supervisor to verify that its owned child is actually ready. We don't send an HTTP request because
/// the coworker daemon (real mode) only speaks WebSocket;
/// a plain `GET /health` would 426 on it. TCP-connect is
/// enough: if 47821 is open, *something* is there.
fn daemon_alive(port: u16, host: &str) -> bool {
    use std::net::TcpStream;
    use std::time::Duration;
    let Ok(addr) = format!("{host}:{port}").parse::<std::net::SocketAddr>() else {
        return false;
    };
    TcpStream::connect_timeout(&addr, Duration::from_millis(500)).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reason_codes_are_stable() {
        // Renderer branches on these strings; they are part of the contract.
        assert_eq!(reason::SCRIPT_MISSING, "workd_script_missing");
        assert_eq!(reason::NODE_MISSING, "workd_node_missing");
        assert_eq!(reason::SPAWN_FAILED, "workd_spawn_failed");
        assert_eq!(reason::EXITED_BEFORE_READY, "workd_exited_before_ready");
        assert_eq!(reason::READY_TIMEOUT, "workd_ready_timeout");
        assert_eq!(reason::PORT_BUSY, "workd_port_busy");
    }

    #[test]
    fn failure_messages_carry_the_reason_code() {
        let error = fail(reason::SCRIPT_MISSING, "nothing here");
        assert!(error.to_string().contains("[workd_script_missing]"));
    }

    #[test]
    fn daemon_alive_rejects_a_closed_port() {
        // Port 1 is privileged and unused on dev/CI machines; if something
        // really listens there the assertion is skipped rather than flaky.
        if !daemon_alive(1, "127.0.0.1") {
            assert!(!daemon_alive(1, "127.0.0.1"));
        }
    }

    #[test]
    fn default_endpoint_constants_unchanged() {
        assert_eq!(DEFAULT_PORT, 47821);
        assert_eq!(DEFAULT_HOST, "127.0.0.1");
    }

    #[test]
    fn control_plane_tokens_are_strong_and_unique() {
        let first = generate_control_plane_token().expect("system RNG should be available");
        let second = generate_control_plane_token().expect("system RNG should be available");
        assert_eq!(first.len(), 64);
        assert!(first.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert_ne!(first, second);
    }
}
