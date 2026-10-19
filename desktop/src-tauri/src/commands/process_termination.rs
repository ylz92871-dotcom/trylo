use std::io;
use std::process::{Command, Output};

fn require_termination_success(output: Output) -> io::Result<()> {
    if output.status.success() {
        return Ok(());
    }
    let detail: String = String::from_utf8_lossy(&output.stderr)
        .trim()
        .chars()
        .take(1000)
        .collect();
    Err(io::Error::other(format!(
        "process tree termination failed ({}): {detail}",
        output.status
    )))
}

/// Send termination only to the tree this shell owns. An executed helper is
/// not evidence of success: taskkill/kill may have returned Access denied.
pub fn terminate_tree(pid: u32) -> io::Result<()> {
    #[cfg(windows)]
    let mut command = {
        use std::os::windows::process::CommandExt;
        let root = std::env::var_os("SystemRoot")
            .ok_or_else(|| io::Error::other("SystemRoot is missing"))?;
        let mut command = Command::new(std::path::Path::new(&root).join("System32/taskkill.exe"));
        command.args(["/PID", &pid.to_string(), "/T", "/F"]);
        command.creation_flags(0x0800_0000);
        command
    };
    #[cfg(not(windows))]
    let mut command = {
        let mut command = Command::new("kill");
        command.args(["-KILL", &pid.to_string()]);
        command
    };
    require_termination_success(command.output()?)
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert!(require_termination_success(output).is_err());
    }

    #[test]
    #[ignore = "Windows desktop-token integration test; run explicitly outside the restricted runner"]
    fn real_termination_reaps_only_a_child_created_by_this_test() {
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
        use std::process::Stdio;
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let result = terminate_tree(child.id());
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
            let _ = child.wait();
        }
        result.unwrap();
        assert!(
            observed,
            "a successful helper must result in an observed fixture exit"
        );
    }
}
