#![cfg_attr(windows, windows_subsystem = "windows")]

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::time::{Duration, Instant};

const PREPARATION_BUDGET: Duration = Duration::from_secs(90);

fn background_command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    #[allow(unused_mut)]
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW; GUI children retain their normal UI.
    }
    command
}

fn wait_for_preparation(child: &mut Child) -> Result<ExitStatus, String> {
    let deadline = Instant::now() + PREPARATION_BUDGET;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status),
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(25));
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("Runtime preparation timed out after 90 seconds.".into());
            }
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("Cannot observe runtime preparation: {error}"));
            }
        }
    }
}

fn launch(root: &Path, prepare_only: bool, log: &mut File) -> Result<(), String> {
    let script = root.join("Start-Trylo.ps1");
    let desktop = root.join("trylo-desktop.exe");
    if !script.is_file() || !desktop.is_file() {
        return Err("Extract the complete portable archive before starting Trylo.".into());
    }
    let system_root = std::env::var_os("SystemRoot").ok_or("Windows SystemRoot is unavailable.")?;
    let powershell = Path::new(&system_root).join("System32/WindowsPowerShell/v1.0/powershell.exe");
    // Preparation never launches the app itself: the GUI launcher owns that
    // decision, so a failed preparation cannot still leave a Desktop running.
    let mut child = background_command(powershell)
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
        ])
        .arg(script)
        .arg("-PrepareOnly")
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log.try_clone().map_err(|e| e.to_string())?))
        .stderr(Stdio::from(log.try_clone().map_err(|e| e.to_string())?))
        .spawn()
        .map_err(|e| format!("Cannot start runtime preparation: {e}"))?;
    let status = wait_for_preparation(&mut child)?;
    if !status.success() {
        return Err(format!(
            "Runtime preparation failed (exit {:?}).",
            status.code()
        ));
    }
    if !prepare_only {
        let child = background_command(desktop)
            .current_dir(root)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("Cannot start Trylo Desktop: {e}"))?;
        writeln!(log, "Desktop started, pid={}", child.id()).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn run(prepare_only: bool) -> Result<(), String> {
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    let root = executable
        .parent()
        .ok_or("The portable directory is unavailable.")?;
    let mut log = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(root.join("Start-Trylo.log"))
        .map_err(|e| format!("Cannot write Start-Trylo.log: {e}"))?;
    let result = launch(root, prepare_only, &mut log);
    if let Err(error) = &result {
        // Preserve the original preparation diagnostics even if app startup fails.
        let _ = writeln!(log, "Startup failed: {error}");
    }
    result
}

#[cfg(windows)]
fn show_error(error: &str) {
    #[link(name = "user32")]
    unsafe extern "system" {
        fn MessageBoxW(
            window: *mut std::ffi::c_void,
            text: *const u16,
            title: *const u16,
            flags: u32,
        ) -> i32;
    }
    let text: Vec<u16> =
        format!("Trylo 启动失败。\n\n{error}\n\n请查看便携目录中的 Start-Trylo.log。")
            .encode_utf16()
            .chain(Some(0))
            .collect();
    let title: Vec<u16> = "Trylo".encode_utf16().chain(Some(0)).collect();
    unsafe {
        MessageBoxW(std::ptr::null_mut(), text.as_ptr(), title.as_ptr(), 0x10);
    }
}

#[cfg(not(windows))]
fn show_error(error: &str) {
    eprintln!("{error}");
}

fn main() {
    // This diagnostic mode never opens either a Desktop or an error window.
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    let prepare_only = arguments.iter().any(|arg| arg == "--prepare-only");
    let quiet_errors = prepare_only || arguments.iter().any(|arg| arg == "--no-error-dialog");
    if let Err(error) = run(prepare_only) {
        if !quiet_errors {
            show_error(&error);
        }
        std::process::exit(1);
    }
}
