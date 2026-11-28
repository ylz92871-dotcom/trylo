use std::path::Path;
use std::process::Command;

pub(crate) fn open_with_default_app(path: &Path) -> Result<(), String> {
    Command::new("xdg-open")
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

pub(crate) fn launch_with_app(path: &Path, _app_identifier: &str) -> Result<(), String> {
    open_with_default_app(path)
}

pub(crate) fn reveal_in_folder(path: &Path) -> Result<(), String> {
    open_with_default_app(path.parent().unwrap_or(path))
}
