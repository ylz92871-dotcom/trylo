//! Private profiles are unique per native view, including repeated token use.
use std::path::Path;
#[cfg(not(target_os = "macos"))]
use std::path::PathBuf;

fn remove_owned(root: &Path, profile: &Path) -> std::io::Result<()> {
    if !profile.exists() { return Ok(()); }
    let base = std::fs::canonicalize(root)?;
    let target = std::fs::canonicalize(profile)?;
    let Some(name) = profile.file_name() else { return Err(std::io::Error::from(std::io::ErrorKind::PermissionDenied)); };
    // Resolve the final deletion target and reject a redirected profile.
    if base != root || target.parent() != Some(base.as_path()) || target != base.join(name) {
        return Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "redirected web preview profile"));
    }
    std::fs::remove_dir_all(target)
}
#[cfg(not(target_os = "macos"))]
pub(super) fn retire(root: PathBuf, profile: PathBuf) {
    std::thread::spawn(move || {
        for delay in [0, 250, 1000] {
            std::thread::sleep(std::time::Duration::from_millis(delay));
            if remove_owned(&root, &profile).is_ok() { return; }
        }
        eprintln!("[preview] closed web profile remains locked; retained in application cache");
    });
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn removes_only_the_registered_direct_child_and_keeps_other_data() {
        let fixture = std::env::temp_dir().join(format!("trylo-web-profile-{}", std::process::id()));
        std::fs::create_dir(&fixture).unwrap();
        let root = fixture.join("profiles"); let own = root.join("owned"); let other = fixture.join("other");
        std::fs::create_dir_all(&own).unwrap(); std::fs::create_dir(&other).unwrap();
        std::fs::write(own.join("cache"), "temporary").unwrap();
        std::fs::write(other.join("keep"), "user data").unwrap();
        let canonical_root = std::fs::canonicalize(&root).unwrap();
        assert!(remove_owned(&canonical_root, &other).is_err());
        assert_eq!(std::fs::read(other.join("keep")).unwrap(), b"user data");
        remove_owned(&canonical_root, &own).unwrap(); assert!(!own.exists());
        std::fs::remove_dir_all(fixture).unwrap();
    }
}
