// Trylo Desktop — trylo-workd daemon state. See ../../../work/README.md
// and ../../../work/STRUCTURE.md (Phase 0).
//
// Holds the single spawned instance of the Trylo Work daemon
// (Node sidecar, see `trylo/work/`). One daemon per Tauri app
// lifetime; spawn on demand, kill on app exit or on explicit
// `workd_stop`.
//
// The daemon speaks HTTP/WS to the Tauri renderer; the Tauri
// commands in `workd.rs` only manage the sidecar lifecycle
// (spawn, stop, status). The renderer talks to the Control
// Plane directly via `fetch()` — no HTTP proxying through
// Tauri commands, which keeps this state small and the IPC
// contract minimal.
//
// Phase 0 keeps the daemon as a stub (3 endpoints). Phase 1
// replaces the stub with the real CoWork-OS coworker daemon
// (see work/STRUCTURE.md). The state shape doesn't change.

use std::process::Child;
use std::sync::Mutex;

/// v1.16.5+ (Phase A of the M1 lifecycle milestone):
/// `tokio::sync::Mutex` used as a single-flight gate for
/// `workd_spawn`. Multiple concurrent invocations (React 18
/// `StrictMode` fires the mount effect twice in dev; a
/// `handleSettingsSave` may overlap the auto-spawn; future
/// windows could race) must result in **at most one** real
/// daemon startup. The lock is held for the entire
/// spawn + readiness-poll duration (~7s in real mode).
/// `workd_stop` does NOT acquire this lock; it operates
/// only on the already-spawned `Child` and therefore
/// does not block on an in-progress spawn.
use tokio::sync::Mutex as AsyncMutex;

pub struct WorkdEntry {
    /// Held purely to keep the child process alive. The
    /// `Child` value is taken out and killed in `workd_stop`.
    pub child: Option<Child>,
    pub pid: u32,
    pub host: String,
    pub port: u16,
    /// Per-launch Control Plane credential shared only with the renderer.
    /// Keeping it beside the child handle makes idempotent spawn calls and
    /// supervised restarts return the exact credential the live daemon uses.
    pub token: String,
}

#[derive(Default)]
pub struct WorkdState {
    pub daemon: Mutex<Option<WorkdEntry>>,
    /// v1.16.5+ (Phase A): see struct-level note on
    /// `WorkdEntry` for the single-flight contract.
    pub spawn_lock: AsyncMutex<()>,
}
