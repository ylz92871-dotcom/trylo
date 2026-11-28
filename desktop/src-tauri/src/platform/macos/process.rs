use std::ffi::OsStr;
use std::process::Command;

pub(crate) fn configure_background(command: &mut Command) {
    if let Ok(path) = macos_path(std::env::var_os("PATH").as_deref(), std::env::var_os("HOME").as_deref()) {
        command.env("PATH", path);
    }
}

fn macos_path(inherited: Option<&OsStr>, home: Option<&OsStr>) -> Result<std::ffi::OsString, std::env::JoinPathsError> {
    use std::path::{Path, PathBuf};

    let mut directories = inherited.into_iter().flat_map(std::env::split_paths).collect::<Vec<_>>();
    let mut fallbacks = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
        .map(PathBuf::from).to_vec();
    if let Some(home) = home.map(Path::new).filter(|path| path.is_absolute()) {
        fallbacks.extend([home.join(".local/bin"), home.join(".cargo/bin")]);
    }
    for fallback in fallbacks {
        if !directories.contains(&fallback) {
            directories.push(fallback);
        }
    }
    std::env::join_paths(directories)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn macos_gui_path_keeps_explicit_order_and_appends_tool_locations() {
        let path = macos_path(Some(OsStr::new("/usr/bin:/opt/custom/bin")), Some(OsStr::new("/Users/trylo"))).unwrap();
        let directories = std::env::split_paths(&path).collect::<Vec<_>>();
        assert_eq!(&directories[..3], ["/usr/bin", "/opt/custom/bin", "/opt/homebrew/bin"].map(PathBuf::from));
        assert!(directories.ends_with(&["/Users/trylo/.local/bin", "/Users/trylo/.cargo/bin"].map(PathBuf::from)));
        assert_eq!(directories.iter().filter(|path| path.as_os_str() == "/usr/bin").count(), 1);
    }
}
