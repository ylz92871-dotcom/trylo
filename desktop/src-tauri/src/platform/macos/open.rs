use std::path::Path;
use std::process::Command;

pub(crate) fn open_with_default_app(path: &Path) -> Result<(), String> {
    macos_open(&[], path)
}

pub(crate) fn launch_with_app(path: &Path, app_identifier: &str) -> Result<(), String> {
    macos_open(&["-a", app_identifier], path)
}

fn macos_open(options: &[&str], path: &Path) -> Result<(), String> {
    let output = Command::new("/usr/bin/open")
        .args(options).arg("--").arg(path).output().map_err(|error| error.to_string())?;
    if output.status.success() { Ok(()) }
    else { Err(String::from_utf8_lossy(&output.stderr).trim().to_string()) }
}

pub(crate) fn reveal_in_folder(path: &Path) -> Result<(), String> {
    macos_open(&["-R"], path)
}
