use std::io;
use std::process::Command;

mod helper;
use helper::run_termination_helper;
#[cfg(test)]
use {helper::require_termination_success, std::process::Output};

/// Keeps the Windows process object alive until every stop caller has released
/// its control, so an in-flight taskkill cannot follow a reused numeric PID.
#[derive(Clone)]
pub struct OwnedTreeTerminator {
    #[cfg(windows)]
    identity: std::sync::Arc<std::os::windows::io::OwnedHandle>,
    #[cfg(not(windows))]
    pid: u32,
}

impl OwnedTreeTerminator {
    pub fn capture(child: &std::process::Child) -> io::Result<Self> {
        #[cfg(windows)]
        {
            use std::os::windows::io::AsHandle;
            Ok(Self {
                identity: std::sync::Arc::new(child.as_handle().try_clone_to_owned()?),
            })
        }
        #[cfg(not(windows))]
        {
            Ok(Self { pid: child.id() })
        }
    }

    fn pid(&self) -> io::Result<u32> {
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            // The retained handle is owned, valid, and has the Child's rights.
            let pid = unsafe {
                windows_sys::Win32::System::Threading::GetProcessId(self.identity.as_raw_handle())
            };
            if pid == 0 {
                Err(io::Error::last_os_error())
            } else {
                Ok(pid)
            }
        }
        #[cfg(not(windows))]
        {
            Ok(self.pid)
        }
    }

    pub fn terminate(&self) -> io::Result<()> {
        let mut command = termination_command(self.pid()?)?;
        run_termination_helper(
            &mut command,
            std::time::Duration::from_secs(2),
            Some(self.clone()),
        )
    }
}

/// Send termination only to the tree this shell owns. An executed helper is
/// not evidence of success: taskkill/kill may have returned Access denied.
fn termination_command(pid: u32) -> io::Result<Command> {
    #[cfg(windows)]
    let command = {
        use std::os::windows::process::CommandExt;
        let root = std::env::var_os("SystemRoot")
            .ok_or_else(|| io::Error::other("SystemRoot is missing"))?;
        let mut command = Command::new(std::path::Path::new(&root).join("System32/taskkill.exe"));
        command.args(["/PID", &pid.to_string(), "/T", "/F"]);
        command.creation_flags(0x0800_0000);
        command
    };
    #[cfg(not(windows))]
    let command = {
        let mut command = Command::new("kill");
        command.args(["-KILL", &pid.to_string()]);
        command
    };
    Ok(command)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    fn fixed_node() -> std::path::PathBuf {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("resources/runtime/node/win-x64/node.exe")
    }

    #[test]
    #[cfg(windows)]
    fn a_stalled_helper_is_bounded_and_reaped_without_waiting_for_its_stdout() {
        use std::sync::mpsc;
        use std::time::Duration;
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "trylo-helper-budget-{}-{nonce}",
            std::process::id()
        ));
        std::fs::create_dir(&directory).unwrap();
        let release = directory.join("release.txt");
        let child_release = release.clone();
        let (finished, result) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            use std::os::windows::process::CommandExt;
            let mut command = Command::new(fixed_node());
            command.creation_flags(0x0800_0000);
            command.args(["-e", "setInterval(()=>{if(require('fs').existsSync(process.argv[1]))process.exit(0)},20)"]);
            command.arg(child_release);
            let outcome = run_termination_helper(&mut command, Duration::from_millis(250), None);
            finished.send(outcome).unwrap();
        });
        let observed = result.recv_timeout(Duration::from_secs(2));
        // The original unbounded implementation must still finish its owned
        // child and worker before this negative test can fail.
        std::fs::write(&release, "release").unwrap();
        let outcome = if let Ok(outcome) = observed {
            Some(outcome)
        } else {
            let _ = result.recv_timeout(Duration::from_secs(5)).unwrap();
            None
        };
        worker.join().unwrap();
        std::fs::remove_file(release).unwrap();
        std::fs::remove_dir(directory).unwrap();
        assert!(
            outcome.is_some(),
            "termination helper ignored its execution budget"
        );
        assert_eq!(
            outcome.unwrap().unwrap_err().kind(),
            io::ErrorKind::TimedOut
        );
    }

    #[test]
    #[cfg(windows)]
    fn a_large_helper_diagnostic_is_drained_but_retained_with_a_bound() {
        use std::os::windows::process::CommandExt;
        let mut command = Command::new(fixed_node());
        command.creation_flags(0x0800_0000);
        command.args([
            "-e",
            "process.stderr.write('denied-'.repeat(200000),()=>process.exit(7))",
        ]);
        let error = run_termination_helper(&mut command, std::time::Duration::from_secs(2), None)
            .unwrap_err();
        assert!(error.to_string().contains("denied-"));
        assert!(error.to_string().len() < 1200);
    }

    #[test]
    fn nonzero_helper_status_is_an_error_even_when_the_helper_started() {
        #[cfg(windows)]
        let status = {
            use std::os::windows::process::ExitStatusExt;
            std::process::ExitStatus::from_raw(5)
        };
        #[cfg(not(windows))]
        let status = {
            use std::os::unix::process::ExitStatusExt;
            std::process::ExitStatus::from_raw(5 << 8)
        };
        let output = Output {
            status,
            stdout: Vec::new(),
            stderr: b"Access is denied".to_vec(),
        };
        assert!(require_termination_success(&output).is_err());
    }

    #[test]
    fn real_termination_reaps_only_a_child_created_by_this_test() {
        use std::process::Stdio;
        #[cfg(windows)]
        let mut command = {
            use std::os::windows::process::CommandExt;
            let mut command = Command::new("cmd");
            command.args(["/d", "/c", "set /p TRYLO_TEST_INPUT="]);
            command.creation_flags(0x0800_0000);
            command
        };
        #[cfg(not(windows))]
        let mut command = {
            let mut command = Command::new("sh");
            command.args(["-c", "read value"]);
            command
        };
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let terminator = OwnedTreeTerminator::capture(&child).unwrap();
        let original_pid = child.id();
        let result = terminator.terminate();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        let mut observed = false;
        while std::time::Instant::now() < deadline {
            if child.try_wait().unwrap().is_some() {
                observed = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        if !observed {
            // This test owns the fixture and must not leak it after a failure.
            let _ = child.kill();
        }
        let _ = child.wait();
        result.unwrap();
        assert!(
            observed,
            "a successful helper must result in an observed fixture exit"
        );
        // The original Child's handle may be dropped while stop IO is pending.
        drop(child);
        assert_eq!(terminator.pid().unwrap(), original_pid);
    }
}
