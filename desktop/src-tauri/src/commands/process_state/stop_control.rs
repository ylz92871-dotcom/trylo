use std::io;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Arc, Mutex};

type Killer = Box<dyn FnMut() -> io::Result<()> + Send + Sync>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum ProcessStopState {
    Running = 0,
    Requested = 1,
    Exited = 2,
}

/// One command owner per native registration. IO is serialized here, never
/// under the registry lock. The reaper may mark exit while IO is still pending.
pub struct ProcessStopControl {
    killer: Mutex<Killer>,
    state: AtomicU8,
}

impl ProcessStopControl {
    pub fn new(killer: impl FnMut() -> io::Result<()> + Send + Sync + 'static) -> Arc<Self> {
        Arc::new(Self {
            killer: Mutex::new(Box::new(killer)),
            state: AtomicU8::new(ProcessStopState::Running as u8),
        })
    }

    pub fn state(&self) -> ProcessStopState {
        match self.state.load(Ordering::Acquire) {
            0 => ProcessStopState::Running,
            1 => ProcessStopState::Requested,
            2 => ProcessStopState::Exited,
            _ => unreachable!("stop control state is only written with ProcessStopState values"),
        }
    }

    pub fn mark_exited(&self) {
        self.state
            .store(ProcessStopState::Exited as u8, Ordering::Release);
    }

    pub fn request_stop(&self) -> io::Result<bool> {
        if self.state() != ProcessStopState::Running {
            return Ok(false);
        }
        let mut killer = self
            .killer
            .lock()
            .map_err(|_| io::Error::other("process stop control poisoned"))?;
        if self.state() != ProcessStopState::Running {
            return Ok(false);
        }
        match (*killer)() {
            Ok(()) => {
                // An actual exit wins a race with a late helper receipt.
                let _ = self.state.compare_exchange(
                    ProcessStopState::Running as u8,
                    ProcessStopState::Requested as u8,
                    Ordering::AcqRel,
                    Ordering::Acquire,
                );
                Ok(true)
            }
            Err(_) if self.state() == ProcessStopState::Exited => Ok(false),
            Err(error) => Err(error),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    #[test]
    fn concurrent_requests_run_the_killer_once() {
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let observed = Arc::clone(&calls);
        let control = ProcessStopControl::new(move || {
            calls.fetch_add(1, Ordering::SeqCst);
            Ok(())
        });
        std::thread::scope(|scope| {
            let handles: Vec<_> = (0..8)
                .map(|_| {
                    let control = Arc::clone(&control);
                    scope.spawn(move || control.request_stop().unwrap())
                })
                .collect();
            assert_eq!(
                handles
                    .into_iter()
                    .filter_map(|thread| thread.join().unwrap().then_some(()))
                    .count(),
                1
            );
        });
        assert_eq!(observed.load(Ordering::SeqCst), 1);
        assert_eq!(control.state(), ProcessStopState::Requested);
    }

    #[test]
    fn reaper_exit_wins_a_late_success_or_refusal_and_prevents_a_queued_retry() {
        for refused in [false, true] {
            let (entered, observed) = mpsc::channel();
            let (release, held) = mpsc::channel();
            let held = Mutex::new(held);
            let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let total = Arc::clone(&calls);
            let control = ProcessStopControl::new(move || {
                total.fetch_add(1, Ordering::SeqCst);
                entered.send(()).unwrap();
                held.lock()
                    .unwrap()
                    .recv_timeout(Duration::from_secs(5))
                    .unwrap();
                if refused {
                    Err(io::ErrorKind::PermissionDenied.into())
                } else {
                    Ok(())
                }
            });
            std::thread::scope(|scope| {
                let first = scope.spawn(|| control.request_stop());
                observed.recv_timeout(Duration::from_secs(3)).unwrap();
                let second = scope.spawn(|| control.request_stop());
                control.mark_exited();
                assert_eq!(control.state(), ProcessStopState::Exited);
                release.send(()).unwrap();
                first.join().unwrap().unwrap();
                assert!(!second.join().unwrap().unwrap());
            });
            assert_eq!(calls.load(Ordering::SeqCst), 1);
            assert_eq!(control.state(), ProcessStopState::Exited);
            assert!(!control.request_stop().unwrap());
        }
    }
}
