use std::path::Path;
use std::process::Command;

pub(crate) fn open_with_default_app(path: &Path) -> Result<(), String> {
    Command::new("open")
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

pub(crate) fn launch_with_app(path: &Path, app_identifier: &str) -> Result<(), String> {
    Command::new("open")
        .args(["-a", app_identifier])
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}
