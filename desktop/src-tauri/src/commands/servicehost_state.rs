// Trylo Desktop — Service Host (desktop-services sidecar) state.
// See docs/TRYLO-MIGRATION-EXECUTION-SPEC-2026-08-28.md §5 and
// docs/TRYLO-WORK-PHASE1-PHASE2-RUNTIME-AUDIT-AND-REMEDIATION-2026-08-28.md §3.
//
// Holds the single spawned instance of the NDJSON stdio sidecar
// (host.mjs). Unlike workd (HTTP/WS) and process_spawn (line stdio),
// the Service Host speaks frame-delimited NDJSON over stdin/stdout.
//
// The spawn command in servicehost.rs holds the single-flight gate and the
// ready handshake; the three cleanup paths (stdout EOF reaper, heartbeat
// watchdog, explicit stop) are all scoped to a generation id so a stale
// thread can never tear down a replacement host (audit §3.2 SH-P0-2).
//
// The `Child` is NOT stored here — the stdout reaper thread owns
// `Child::wait()`. Storage mirrors lsp_state.rs.

use std::io::Write;
use std::process::ChildStdin;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

/// Cloneable handle over the child's stdin. `Arc<Mutex<_>>` lets the
/// heartbeat watchdog send pings from its own thread while
/// `servicehost_send` keeps frame writes atomic. The sink is a trait object
/// so tests can register a host without spawning a real process.
pub struct StdinHandle {
    inner: Arc<Mutex<dyn Write + Send>>,
}

// Manual impl: `#[derive(Clone)]` would add a `W: Clone` bound that
// `ChildStdin` does not satisfy. The handle is shared, not duplicated.
impl Clone for StdinHandle {
    fn clone(&self) -> Self {
        Self {
            inner: Arc::clone(&self.inner),
        }
    }
}

impl StdinHandle {
    /// Wrap any owned writer (a real `ChildStdin`, or a `Vec<u8>` sink in
    /// tests).
    #[must_use]
    pub fn over<W: Write + Send + 'static>(sink: W) -> Self {
        Self {
            inner: Arc::new(Mutex::new(sink)),
        }
    }

    #[must_use]
    pub fn new(stdin: ChildStdin) -> Self {
        Self::over(stdin)
    }

    /// Write one complete frame. A broken pipe means the host is gone — the
    /// caller decides whether that is fatal.
    ///
    /// # Errors
    /// Returns the underlying I/O error (including a poisoned mutex) so the
    /// caller can classify it as "host disappeared".
    pub fn write_frame(&self, frame: &str) -> std::io::Result<()> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| std::io::Error::other("servicehost stdin poisoned"))?;
        guard.write_all(frame.as_bytes())?;
        guard.flush()
    }
}

impl Write for StdinHandle {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.inner
            .lock()
            .map_err(|_| std::io::Error::other("servicehost stdin poisoned"))?
            .write(buf)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.inner
            .lock()
            .map_err(|_| std::io::Error::other("servicehost stdin poisoned"))?
            .flush()
    }
}

/// Shared heartbeat bookkeeping between the spawn command (watchdog owner)
/// and the stdout reader thread (pong observer). Audit §3.2 SH-P0-4: the
/// Rust shell owns parent→child ping; the renderer only consumes the health
/// projection.
#[derive(Clone)]
pub struct Heartbeat {
    /// Wall-clock stamp of the last observed pong, in milliseconds.
    last_pong_ms: Arc<AtomicU64>,
    /// Set when a generation ends, so its watchdog exits instead of killing
    /// the NEXT host.
    stopped: Arc<AtomicBool>,
    /// Set once by whichever path terminated this generation.
    killed: Arc<AtomicBool>,
}

impl Heartbeat {
    #[must_use]
    pub fn new() -> Self {
        Self {
            last_pong_ms: Arc::new(AtomicU64::new(now_ms())),
            stopped: Arc::new(AtomicBool::new(false)),
            killed: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Record that a pong arrived right now.
    pub fn mark_alive(&self) {
        self.last_pong_ms.store(now_ms(), Ordering::Release);
    }

    #[must_use]
    pub fn age_ms(&self) -> u64 {
        now_ms().saturating_sub(self.last_pong_ms.load(Ordering::Acquire))
    }

    pub fn stop(&self) {
        self.stopped.store(true, Ordering::Release);
    }

    #[must_use]
    pub fn is_stopped(&self) -> bool {
        self.stopped.load(Ordering::Acquire)
    }

    /// Claim responsibility for terminating this generation. Returns false
    /// when another path (exit reaper, stop) already acted.
    pub fn claim_kill(&self) -> bool {
        self.killed
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
    }

    #[must_use]
    pub fn was_killed(&self) -> bool {
        self.killed.load(Ordering::Acquire)
    }
}

impl Default for Heartbeat {
    fn default() -> Self {
        Self::new()
    }
}

/// Convert a `u128` millisecond value to `u64`, saturating instead of
/// truncating (a `u128` ms value cannot occur, but `as` casts are denied).
fn saturating_millis(value: u128) -> u64 {
    u64::try_from(value).unwrap_or(u64::MAX)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |duration| saturating_millis(duration.as_millis()))
}

pub struct ServiceHostProcess {
    /// Write NDJSON frames to the sidecar's stdin.
    pub writer: StdinHandle,
    /// Terminate the sidecar child process tree.
    pub killer: Box<dyn FnMut() + Send + Sync>,
    pub pid: u32,
    /// Monotonic identity of THIS host instance.
    pub generation: u64,
    /// Watchdog control for this generation; `stop()` retires it.
    pub heartbeat: Heartbeat,
}

/// Bounded, redacted stderr tail shared by the stderr reader thread and the
/// spawn command's failure paths (audit §3.2 SH-P0-5). Process-global
/// because there is exactly one Service Host per app instance; it is cleared
/// at the start of every spawn.
static STDERR_TAIL: std::sync::OnceLock<crate::commands::diagnostics::DiagnosticTail> =
    std::sync::OnceLock::new();

/// The shared stderr tail for the Service Host.
#[must_use]
pub fn stderr_tail() -> &'static crate::commands::diagnostics::DiagnosticTail {
    STDERR_TAIL.get_or_init(crate::commands::diagnostics::DiagnosticTail::new)
}

#[derive(Default)]
pub struct ServiceHostState {
    pub daemon: Mutex<Option<ServiceHostProcess>>,
    /// Serialises the complete check → spawn → ready → register sequence.
    /// The daemon mutex alone cannot prevent two callers from both observing
    /// an empty slot before either child is registered (audit §3.2 SH-P0-3).
    pub spawn_lock: tokio::sync::Mutex<()>,
    /// Monotonic generation counter. Every spawned host claims the next
    /// value; cleanup compares it before mutating the slot.
    pub generation: AtomicU64,
}

impl ServiceHostState {
    /// Claim the next generation id. Starts at 1 so `0` can never be a real
    /// generation.
    pub fn next_generation(&self) -> u64 {
        self.generation.fetch_add(1, Ordering::AcqRel) + 1
    }

    /// Remove the slot if — and only if — it still belongs to `generation`.
    /// Returns true when this call removed it.
    pub fn clear_generation(&self, generation: u64) -> bool {
        let Ok(mut guard) = self.daemon.lock() else {
            return false;
        };
        let Some(current) = guard.as_ref() else {
            return false;
        };
        if current.generation != generation {
            return false;
        }
        // Retire this generation's watchdog before dropping the slot.
        current.heartbeat.stop();
        *guard = None;
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Register a host without spawning a process. The sink is a throwaway
    /// in-memory writer: these tests only prove that cleanup is
    /// generation-scoped.
    fn register(state: &ServiceHostState, generation: u64, pid: u32) -> Heartbeat {
        let heartbeat = Heartbeat::new();
        let mut slot = state.daemon.lock().expect("daemon lock");
        *slot = Some(ServiceHostProcess {
            writer: StdinHandle::over(Vec::new()),
            killer: Box::new(|| {}),
            pid,
            generation,
            heartbeat: heartbeat.clone(),
        });
        heartbeat
    }

    #[test]
    fn a_stale_generation_cannot_clear_its_replacement() {
        let state = ServiceHostState::default();
        let first = state.next_generation();
        let _ = register(&state, first, 1000);
        // The first host died and was replaced BEFORE its reaper ran — the
        // exact race behind SH-P0-2.
        let second = state.next_generation();
        let second_heartbeat = register(&state, second, 2000);

        assert!(!state.clear_generation(first), "stale reaper must no-op");
        assert!(
            state.daemon.lock().expect("daemon lock").is_some(),
            "replacement host survived"
        );
        assert!(!second_heartbeat.is_stopped());

        // The replacement's own cleanup still works.
        assert!(state.clear_generation(second));
        assert!(state.daemon.lock().expect("daemon lock").is_none());
        assert!(second_heartbeat.is_stopped());
    }

    #[test]
    fn generations_are_unique_and_monotonic() {
        let state = ServiceHostState::default();
        let seen: Vec<u64> = (0..5).map(|_| state.next_generation()).collect();
        assert_eq!(seen, vec![1, 2, 3, 4, 5]);
    }

    #[test]
    fn heartbeat_kill_is_claimed_exactly_once() {
        let heartbeat = Heartbeat::new();
        assert!(heartbeat.claim_kill());
        assert!(!heartbeat.claim_kill(), "only one owner may terminate");
        assert!(heartbeat.was_killed());
    }

    #[test]
    fn pong_resets_the_liveness_age() {
        let heartbeat = Heartbeat::new();
        std::thread::sleep(std::time::Duration::from_millis(5));
        let aged = heartbeat.age_ms();
        heartbeat.mark_alive();
        assert!(heartbeat.age_ms() <= aged);
        assert!(heartbeat.age_ms() < 1_000);
    }
}
