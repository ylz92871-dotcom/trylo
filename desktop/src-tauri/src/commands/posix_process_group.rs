//! Own a process group from spawn through shutdown without signalling the host's group.

use std::io;
use std::os::unix::process::CommandExt;
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::{Duration, Instant};

const GRACE: Duration = Duration::from_millis(250);
const SETTLE: Duration = Duration::from_millis(500);
const POLL: Duration = Duration::from_millis(20);

pub(crate) struct PosixProcessGroup {
    pgid: libc::pid_t,
    owned: Mutex<bool>,
}

impl PosixProcessGroup {
    pub(crate) fn spawn(command: &mut Command) -> io::Result<(Child, Self)> {
        let mut child = command.process_group(0).spawn()?;
        let Ok(pgid) = libc::pid_t::try_from(child.id()) else {
            let _ = child.kill();
            let _ = child.wait();
            return Err(io::Error::other("child PID is outside the process group range"));
        };
        Ok((child, Self { pgid, owned: Mutex::new(true) }))
    }

    /// An ordinary CLI turn that exited normally retains its own background-job policy.
    pub(crate) fn release_after_exit(&self) {
        *self.owned.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = false;
    }

    pub(crate) fn terminate(&self) -> io::Result<()> {
        let mut owned = self.owned.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if !*owned {
            return Ok(());
        }

        if !self.signal(libc::SIGTERM)? || self.wait_for_exit(GRACE)? {
            *owned = false;
            return Ok(());
        }

        if !self.signal(libc::SIGKILL)? || self.wait_for_exit(SETTLE)? {
            *owned = false;
            return Ok(());
        }

        Err(io::Error::new(io::ErrorKind::TimedOut, "process group still exists after SIGKILL"))
    }

    /// A negative PID addresses the dedicated group created by `spawn`.
    fn signal(&self, signal: libc::c_int) -> io::Result<bool> {
        // `pgid` is the positive PID returned for a child started with setpgid(0, 0).
        if unsafe { libc::kill(-self.pgid, signal) } == 0 {
            return Ok(true);
        }
        let error = io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ESRCH) { Ok(false) } else { Err(error) }
    }

    fn wait_for_exit(&self, timeout: Duration) -> io::Result<bool> {
        let deadline = Instant::now() + timeout;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            match self.signal(0) {
                Ok(false) => return Ok(true),
                Ok(true) if remaining.is_zero() => return Ok(false),
                Ok(true) => {}
                // Darwin may briefly report EPERM after a termination signal.
                Err(error) if cfg!(target_os = "macos") && error.raw_os_error() == Some(libc::EPERM)
                    && !remaining.is_zero() => {}
                Err(error) => return Err(error),
            }
            std::thread::sleep(POLL.min(remaining));
        }
    }
}

impl Drop for PosixProcessGroup {
    fn drop(&mut self) {
        if let Err(error) = self.terminate() {
            eprintln!("[process] could not release process group {}: {error}", self.pgid);
        }
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader};
    use std::process::Stdio;

    #[test]
    fn stopping_the_group_reaps_a_term_resistant_child_and_descendant() {
        let mut command = Command::new("/bin/sh");
        command
            .args(["-c", "trap '' TERM; /bin/sleep 60 & echo $!; wait"])
            .stdout(Stdio::piped());
        let (mut child, group) = PosixProcessGroup::spawn(&mut command).unwrap();
        let mut line = String::new();
        BufReader::new(child.stdout.take().unwrap()).read_line(&mut line).unwrap();
        let descendant: libc::pid_t = line.trim().parse().unwrap();

        std::thread::scope(|scope| {
            let reaper = scope.spawn(move || child.wait());
            group.terminate().unwrap();
            assert!(!reaper.join().unwrap().unwrap().success());
        });
        assert!(!group.signal(0).unwrap());
        // Signal 0 only observes the PID printed by the test's own shell.
        assert_eq!(unsafe { libc::kill(descendant, 0) }, -1);
        assert_eq!(io::Error::last_os_error().raw_os_error(), Some(libc::ESRCH));
        group.terminate().unwrap();
    }
}
