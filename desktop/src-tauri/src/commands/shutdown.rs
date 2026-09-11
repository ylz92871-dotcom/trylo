// Trylo Desktop — global shutdown contract. See audit §3.2 (SH-P1-2 /
// PET-P1-3) and migration spec §6.5.
//
// ONE owner, ONE order. Before this module existed, teardown was a partial
// loop inlined in `lib.rs`'s window-close hook: it killed `ProcessState`
// children and the service host, and silently leaked every PTY, LSP server
// and the workd daemon — plus the WPF pet, which the Node sidecar spawns
// DETACHED and therefore nobody in this process can reap by pid.
//
// The contract:
//   1. Children the shell spawned itself die first (Code/Work CLI, PTY, LSP,
//      workd). Each is removed from its table as it is killed, so a second
//      shutdown is a no-op rather than a double-kill.
//   2. The service host dies last among the sidecars: its graceful
//      `pet.disable` frame is what tells the WPF pet to exit, so killing it
//      first would orphan the pet window.
//   3. Whatever is still alive after that is killed BY IMAGE NAME as a last
//      resort. That is the only way to reach a detached grandchild. This
//      step is the shell's, and only the shell's — "single owner" means one
//      place is allowed to do it.
//
// Every step is best-effort and idempotent: a shutdown that fails halfway
// must still be safe to run again.

use std::process::Command;

use tauri::{AppHandle, Manager};

use crate::commands::lsp_state::LspState;
use crate::commands::process_state::ProcessState;
use crate::commands::pty::PtyState;
use crate::commands::servicehost::servicehost_shutdown_now;
use crate::commands::servicehost_state::ServiceHostState;
use crate::commands::workd_state::WorkdState;

/// The WPF companion's image name. The pet is spawned detached by the
/// Node sidecar, so the shell's only handle on it is its image name.
pub const COMPANION_IMAGE: &str = "TryloDesktopPet.exe";

/// Kill every registered Trylo CLI / CC CLI child. Returns how many were
/// terminated; the table is left empty.
pub fn kill_all_processes(state: &ProcessState) -> usize {
    let Ok(mut processes) = state.processes.lock() else {
        return 0;
    };
    let ids: Vec<String> = processes.keys().cloned().collect();
    let mut killed = 0;
    for id in ids {
        // `remove` (not `values_mut`): a killed entry must not survive to be
        // killed again by a second shutdown pass.
        if let Some(mut entry) = processes.remove(&id) {
            (entry.killer)();
            killed += 1;
        }
    }
    killed
}

/// Kill every PTY child. Returns how many were terminated.
pub fn kill_all_ptys(state: &PtyState) -> usize {
    let Ok(mut processes) = state.processes.lock() else {
        return 0;
    };
    let ids: Vec<String> = processes.keys().cloned().collect();
    let mut killed = 0;
    for id in ids {
        if let Some(mut entry) = processes.remove(&id) {
            (entry.killer)();
            killed += 1;
        }
    }
    killed
}

/// Kill every LSP server. Returns how many were terminated.
pub fn kill_all_lsps(state: &LspState) -> usize {
    let Ok(mut processes) = state.processes.lock() else {
        return 0;
    };
    let ids: Vec<String> = processes.keys().cloned().collect();
    let mut killed = 0;
    for id in ids {
        if let Some(mut entry) = processes.remove(&id) {
            (entry.killer)();
            killed += 1;
        }
    }
    killed
}

/// Stop the workd daemon: take the child, kill it, and reap it so the pid
/// is not left a zombie. Returns true if a daemon was actually running.
pub fn stop_workd(state: &WorkdState) -> bool {
    let Ok(mut guard) = state.daemon.lock() else {
        return false;
    };
    let Some(mut entry) = guard.take() else {
        return false;
    };
    if let Some(mut child) = entry.child.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
    true
}

/// Last resort: kill the companion by image name, because it was spawned
/// DETACHED and no pid in this process can reach it.
///
/// Returns true only if the kill command ran successfully. "Nothing was
/// running" also reports success — the desired end state either way.
#[cfg(windows)]
pub fn kill_companion_by_image() -> bool {
    Command::new("taskkill")
        .args(["/IM", COMPANION_IMAGE, "/T", "/F"])
        .status()
        .is_ok_and(|status| status.success())
}

/// Non-Windows has no pet (the bridge refuses to launch), so there is
/// nothing to reap. Kept as a real function so the call site is cfg-free.
#[cfg(not(windows))]
pub fn kill_companion_by_image() -> bool {
    true
}

/// The full teardown, in contract order. Safe to call more than once and
/// safe to call from a sync context (window close, `RunEvent::Exit`).
///
/// Returns the per-step counts so the caller can emit a diagnostic.
pub fn shutdown_all(app: &AppHandle) -> ShutdownReport {
    let processes = kill_all_processes(&app.state::<ProcessState>());
    let ptys = kill_all_ptys(&app.state::<PtyState>());
    let lsps = kill_all_lsps(&app.state::<LspState>());
    let workd = stop_workd(&app.state::<WorkdState>());
    // Deliberately AFTER the other children and BEFORE the image-name
    // sweep: the host's graceful `pet.disable` is what asks the pet to
    // exit, so it must get the chance before we force-kill anything.
    servicehost_shutdown_now(&app.state::<ServiceHostState>());
    let companion_reaped = kill_companion_by_image();
    ShutdownReport {
        processes,
        ptys,
        lsps,
        workd,
        companion_reaped,
    }
}

/// What `shutdown_all` did. Renderer-agnostic: no paths, no pids.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ShutdownReport {
    pub processes: usize,
    pub ptys: usize,
    pub lsps: usize,
    /// Whether a workd daemon was running and was stopped.
    pub workd: bool,
    /// Whether the last-resort companion sweep ran.
    pub companion_reaped: bool,
}

impl ShutdownReport {
    /// True when nothing needed killing — the clean-exit case.
    #[must_use]
    pub fn was_clean(&self) -> bool {
        self.processes == 0 && self.ptys == 0 && self.lsps == 0 && !self.workd
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A killer that records that it ran. Boxed so each registered child
    /// gets its own flag.
    fn spy_killer(flag: &'static std::sync::atomic::AtomicUsize) -> Box<dyn FnMut() + Send + Sync> {
        Box::new(move || {
            flag.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        })
    }

    static SPAWN_KILLS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    static PTY_KILLS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    static LSP_KILLS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

    fn seed_process_state() -> ProcessState {
        let state = ProcessState::default();
        {
            let mut map = state.processes.lock().expect("process lock");
            map.insert(
                "a".to_string(),
                crate::commands::process_state::ProcessEntry {
                    writer: Box::new(Vec::new()),
                    killer: spy_killer(&SPAWN_KILLS),
                    label: "trylo-core".to_string(),
                    pid: 100,
                    metadata: crate::commands::process_state::ProcessMetadata::default(),
                },
            );
            map.insert(
                "b".to_string(),
                crate::commands::process_state::ProcessEntry {
                    writer: Box::new(Vec::new()),
                    killer: spy_killer(&SPAWN_KILLS),
                    label: "cc-cli".to_string(),
                    pid: 101,
                    metadata: crate::commands::process_state::ProcessMetadata::default(),
                },
            );
        }
        state
    }

    #[test]
    fn every_registered_child_is_killed_exactly_once() {
        SPAWN_KILLS.store(0, std::sync::atomic::Ordering::SeqCst);
        let state = seed_process_state();
        assert_eq!(kill_all_processes(&state), 2);
        assert_eq!(SPAWN_KILLS.load(std::sync::atomic::Ordering::SeqCst), 2);
        // Idempotent: the table is empty, so a second pass kills nothing.
        assert_eq!(kill_all_processes(&state), 0);
        assert_eq!(SPAWN_KILLS.load(std::sync::atomic::Ordering::SeqCst), 2);
    }

    #[test]
    fn pty_children_are_killed_and_removed() {
        PTY_KILLS.store(0, std::sync::atomic::Ordering::SeqCst);
        let state = PtyState::default();
        {
            let mut map = state.processes.lock().expect("pty lock");
            map.insert(
                "t1".to_string(),
                crate::commands::pty::PtyProcess {
                    writer: Box::new(Vec::new()),
                    killer: spy_killer(&PTY_KILLS),
                },
            );
        }
        assert_eq!(kill_all_ptys(&state), 1);
        assert_eq!(kill_all_ptys(&state), 0);
        assert_eq!(PTY_KILLS.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[test]
    fn lsp_servers_are_killed_and_removed() {
        LSP_KILLS.store(0, std::sync::atomic::Ordering::SeqCst);
        let state = LspState::default();
        {
            let mut map = state.processes.lock().expect("lsp lock");
            map.insert(
                "l1".to_string(),
                crate::commands::lsp_state::LspProcess {
                    writer: Box::new(Vec::new()),
                    killer: spy_killer(&LSP_KILLS),
                },
            );
        }
        assert_eq!(kill_all_lsps(&state), 1);
        assert_eq!(kill_all_lsps(&state), 0);
        assert_eq!(LSP_KILLS.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[test]
    fn workd_stop_is_idempotent_and_reports_whether_it_ran() {
        let state = WorkdState::default();
        // No daemon: nothing to stop, and it must not panic.
        assert!(!stop_workd(&state));
        assert!(!stop_workd(&state));
    }

    #[test]
    fn a_poisoned_mutex_degrades_instead_of_panicking() {
        // A panic inside a killer would poison the table; shutdown must
        // still return rather than take the whole app down with it.
        let state = ProcessState::default();
        let cloned = std::sync::Arc::clone(&state.processes);
        let _ = std::thread::spawn(move || {
            let _guard = cloned.lock().expect("lock");
            panic!("poison the table");
        })
        .join();
        // The table is now poisoned — `lock()` returns Err.
        assert!(state.processes.lock().is_err());
        // The real assertion: shutdown degrades to 0 instead of panicking.
        assert_eq!(kill_all_processes(&state), 0);
    }

    #[test]
    fn a_report_with_nothing_to_kill_is_clean() {
        let report = ShutdownReport {
            processes: 0,
            ptys: 0,
            lsps: 0,
            workd: false,
            companion_reaped: true,
        };
        assert!(report.was_clean());
        let dirty = ShutdownReport {
            processes: 1,
            ..report
        };
        assert!(!dirty.was_clean());
    }

    #[test]
    fn the_companion_image_name_is_stable() {
        // The renderer and the packaging scripts both name this binary.
        assert_eq!(COMPANION_IMAGE, "TryloDesktopPet.exe");
    }
}
