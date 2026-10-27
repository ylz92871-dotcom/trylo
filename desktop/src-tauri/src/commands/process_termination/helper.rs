use std::io::{self, Read};
use std::process::{Child, ChildStderr, Command, ExitStatus, Output, Stdio};
use std::time::{Duration, Instant};

use super::OwnedTreeTerminator;

const DIAGNOSTIC_BYTES: usize = 1000;
const POLL_INTERVAL: Duration = Duration::from_millis(5);
const REAP_BUDGET: Duration = Duration::from_millis(500);

/// The root identity outlives any helper that could still act on its PID.
pub(super) fn run_termination_helper(
    command: &mut Command,
    budget: Duration,
    identity: Option<OwnedTreeTerminator>,
) -> io::Result<()> {
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()?;
    let mut diagnostic = Vec::new();
    let result = observe_helper(&mut child, &mut diagnostic, budget);
    match result {
        Ok(status) => require_termination_success(&Output {
            status,
            stdout: Vec::new(),
            stderr: diagnostic,
        }),
        Err(error) => {
            // Timeout is not termination of the original root. Stop remains
            // retryable; this cleanup owns only the helper we just spawned.
            let kill_error = child.kill().err();
            if !reap_within(&mut child, REAP_BUDGET) {
                retain_unreaped_helper(child, identity);
            }
            match kill_error {
                Some(cleanup) => Err(io::Error::new(
                    error.kind(),
                    format!("{error}; helper cleanup: {cleanup}"),
                )),
                None => Err(error),
            }
        }
    }
}

fn observe_helper(
    child: &mut Child,
    diagnostic: &mut Vec<u8>,
    budget: Duration,
) -> io::Result<ExitStatus> {
    let deadline = Instant::now() + budget;
    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| io::Error::other("helper stderr is missing"))?;
    #[cfg(unix)]
    prepare_stderr(&stderr)?;
    loop {
        capture_available_stderr(&mut stderr, diagnostic)?;
        if let Some(status) = child.try_wait()? {
            return Ok(status);
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "process tree termination helper timed out",
            ));
        }
        std::thread::sleep(POLL_INTERVAL.min(remaining));
    }
}

/// Cap work per poll as well as retained bytes, so continuous output cannot
/// monopolize the deadline. Inherited open pipes never require EOF.
fn capture_available_stderr(stderr: &mut ChildStderr, diagnostic: &mut Vec<u8>) -> io::Result<()> {
    let mut buffer = [0_u8; 4096];
    for _ in 0..16 {
        #[cfg(windows)]
        let available = available_stderr(stderr)?.min(buffer.len());
        #[cfg(unix)]
        let available = buffer.len();
        if available == 0 {
            return Ok(());
        }
        match stderr.read(&mut buffer[..available]) {
            Ok(0) => return Ok(()),
            Ok(count) => {
                let retained = count.min(DIAGNOSTIC_BYTES.saturating_sub(diagnostic.len()));
                diagnostic.extend_from_slice(&buffer[..retained]);
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => return Ok(()),
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

#[cfg(unix)]
fn prepare_stderr(stderr: &ChildStderr) -> io::Result<()> {
    use std::os::fd::AsRawFd;
    // ChildStderr owns this descriptor; preserve its other flags.
    let flags = unsafe { libc::fcntl(stderr.as_raw_fd(), libc::F_GETFL) };
    if flags == -1
        || unsafe { libc::fcntl(stderr.as_raw_fd(), libc::F_SETFL, flags | libc::O_NONBLOCK) } == -1
    {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(windows)]
fn available_stderr(stderr: &ChildStderr) -> io::Result<usize> {
    use std::os::windows::io::AsRawHandle;
    let mut available = 0;
    // Peek does not wait for bytes or EOF on the owned pipe handle.
    let result = unsafe {
        windows_sys::Win32::System::Pipes::PeekNamedPipe(
            stderr.as_raw_handle(),
            std::ptr::null_mut(),
            0,
            std::ptr::null_mut(),
            &mut available,
            std::ptr::null_mut(),
        )
    };
    if result == 0 {
        let error = io::Error::last_os_error();
        if error
            .raw_os_error()
            .and_then(|code| u32::try_from(code).ok())
            == Some(windows_sys::Win32::Foundation::ERROR_BROKEN_PIPE)
        {
            return Ok(0);
        }
        return Err(error);
    }
    Ok(available as usize)
}

fn reap_within(child: &mut Child, budget: Duration) -> bool {
    let deadline = Instant::now() + budget;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return true,
            Err(_) => return false, // Retained cleanup owner retries observation.
            Ok(None) => {}
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return false;
        }
        std::thread::sleep(POLL_INTERVAL.min(remaining));
    }
}

fn retain_unreaped_helper(mut child: Child, identity: Option<OwnedTreeTerminator>) {
    std::thread::spawn(move || {
        let _identity = identity;
        // Only this background owner may wait without a caller deadline.
        // Keep the Child and root pin on transient observation failures.
        while child.wait().is_err() {
            std::thread::sleep(Duration::from_millis(50));
        }
    });
}

pub(super) fn require_termination_success(output: &Output) -> io::Result<()> {
    if output.status.success() {
        return Ok(());
    }
    let detail: String = String::from_utf8_lossy(&output.stderr)
        .trim()
        .chars()
        .take(DIAGNOSTIC_BYTES)
        .collect();
    Err(io::Error::other(format!(
        "process tree termination failed ({}): {detail}",
        output.status
    )))
}
