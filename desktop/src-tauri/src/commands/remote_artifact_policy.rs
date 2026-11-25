//! The remote read boundary is narrower than the local preview filesystem API.
use std::fs::{self, File};
#[cfg(not(target_os = "macos"))]
use std::fs::OpenOptions;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

pub const MAX_REMOTE_ARTIFACT_BYTES: u64 = 12 * 1024 * 1024;
const MAX_REMOTE_ARTIFACT_FILES: usize = 500;
const MAX_REMOTE_ARTIFACT_DEPTH: usize = 8;
const MAX_REMOTE_ARTIFACT_ENTRIES: usize = 10_000;

pub struct RemoteArtifactFile {
    pub relative_path: String,
    pub size: u64,
    pub modified_ms: u128,
}

fn denied() -> io::Error { io::Error::new(io::ErrorKind::PermissionDenied, "Remote artifact must be a regular file inside workspace .trylo/out") }

fn relative_parts(relative: &str) -> io::Result<Vec<&str>> {
    if relative.is_empty() || relative.len() > 1024 || relative.contains(['\\', ':', '\0']) || relative.chars().any(char::is_control) { return Err(denied()); }
    let parts: Vec<_> = relative.split('/').collect();
    if parts.len() > 32 || parts.iter().any(|part| {
        let stem = part.split('.').next().unwrap_or("").to_ascii_uppercase();
        part.is_empty() || *part == "." || *part == ".." || part.ends_with(['.', ' ']) || matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL") || (stem.len() == 4 && (stem.starts_with("COM") || stem.starts_with("LPT")) && matches!(stem.as_bytes()[3], b'1'..=b'9'))
    }) { return Err(denied()); }
    Ok(parts)
}

fn reject_link(path: &Path) -> io::Result<fs::Metadata> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() { return Err(denied()); }
    #[cfg(windows)] {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 { return Err(denied()); }
    }
    Ok(metadata)
}

#[cfg(windows)]
fn opened_path(file: &File) -> io::Result<PathBuf> {
    use std::os::windows::ffi::OsStringExt;
    use std::os::windows::io::AsRawHandle;
    #[link(name = "kernel32")]
    extern "system" { fn GetFinalPathNameByHandleW(handle: *mut std::ffi::c_void, buffer: *mut u16, length: u32, flags: u32) -> u32; }
    let mut buffer = vec![0_u16; 32768];
    // The file handle is live and buffer points to length writable u16s.
    let length = unsafe { GetFinalPathNameByHandleW(file.as_raw_handle(), buffer.as_mut_ptr(), buffer.len() as u32, 0) };
    if length == 0 { return Err(io::Error::last_os_error()); }
    if length as usize >= buffer.len() { return Err(denied()); }
    Ok(PathBuf::from(std::ffi::OsString::from_wide(&buffer[..length as usize])))
}

#[cfg(target_os = "linux")]
fn opened_path(file: &File) -> io::Result<PathBuf> {
    use std::os::fd::AsRawFd;
    fs::canonicalize(format!("/proc/self/fd/{}", file.as_raw_fd()))
}

#[cfg(target_os = "macos")]
fn opened_path(file: &File) -> io::Result<PathBuf> {
    use std::os::fd::AsRawFd;
    use std::os::unix::ffi::OsStrExt;

    let mut buffer = [0_u8; libc::PATH_MAX as usize];
    // F_GETPATH writes at most PATH_MAX bytes for this live descriptor.
    if unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETPATH, buffer.as_mut_ptr()) } == -1 {
        return Err(io::Error::last_os_error());
    }
    let end = buffer.iter().position(|byte| *byte == 0).ok_or_else(denied)?;
    Ok(PathBuf::from(std::ffi::OsStr::from_bytes(&buffer[..end])))
}

#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
fn opened_path(_file: &File) -> io::Result<PathBuf> {
    Err(io::Error::new(io::ErrorKind::Unsupported, "Remote artifact handle verification is unavailable on this platform"))
}

fn regular_metadata(file: &File, directory: bool) -> io::Result<fs::Metadata> {
    let metadata = file.metadata()?;
    if metadata.file_type().is_symlink() { return Err(denied()); }
    #[cfg(windows)] {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 { return Err(denied()); }
    }
    if (directory && !metadata.is_dir()) || (!directory && !metadata.is_file()) { return Err(denied()); }
    Ok(metadata)
}

struct HeldDirectory {
    // On Windows this handle pins the directory against rename until the operation ends.
    #[cfg_attr(not(any(target_os = "linux", target_os = "macos")), allow(dead_code))]
    file: File,
    path: PathBuf,
}

#[cfg(target_os = "macos")]
fn open_macos_path(path: &Path, parent: Option<&HeldDirectory>, flags: libc::c_int) -> io::Result<File> {
    use std::ffi::CString;
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::ffi::OsStrExt;

    let directory_fd = parent.map_or(libc::AT_FDCWD, |parent| parent.file.as_raw_fd());
    let target = if parent.is_some() { path.file_name().ok_or_else(denied)? } else { path.as_os_str() };
    let target = CString::new(target.as_bytes())?;
    // Resolve each descendant from its already checked parent handle. Never
    // follow a symlink substituted after the preliminary metadata check.
    let fd = unsafe { libc::openat(directory_fd, target.as_ptr(), libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW | flags) };
    if fd == -1 {
        return Err(io::Error::last_os_error());
    }
    // A successful openat transfers ownership of the new descriptor.
    Ok(unsafe { File::from_raw_fd(fd) })
}

impl HeldDirectory {
    fn open(path: &Path, parent: Option<&Self>) -> io::Result<Self> {
        if !reject_link(path)?.is_dir() { return Err(denied()); }
        #[cfg(target_os = "macos")]
        let file = open_macos_path(path, parent, libc::O_DIRECTORY)?;
        #[cfg(not(target_os = "macos"))]
        let file = {
            let mut options = OpenOptions::new(); options.read(true);
            #[cfg(windows)] {
                use std::os::windows::fs::OpenOptionsExt;
                // Keep every ancestor open without DELETE sharing.
                options.share_mode(3).custom_flags(0x02000000 | 0x00200000); // BACKUP_SEMANTICS | OPEN_REPARSE_POINT.
            }
            options.open(path)?
        };
        regular_metadata(&file, true)?;
        let actual = opened_path(&file)?;
        if parent.is_some_and(|parent| actual.parent() != Some(parent.path.as_path())) { return Err(denied()); }
        Ok(Self { file, path: actual })
    }
    fn io_path(&self) -> PathBuf {
        #[cfg(target_os = "linux")] {
            use std::os::fd::AsRawFd;
            return PathBuf::from(format!("/proc/self/fd/{}", self.file.as_raw_fd()));
        }
        #[cfg(not(target_os = "linux"))] self.path.clone()
    }
    fn child(&self, name: &str) -> io::Result<Self> {
        Self::open(&self.io_path().join(name), Some(self))
    }
}

struct ArtifactRoot { directories: Vec<HeldDirectory> }
impl ArtifactRoot {
    fn open(workspace: &Path) -> io::Result<Self> {
        if !workspace.is_absolute() { return Err(denied()); }
        let workspace = HeldDirectory::open(&fs::canonicalize(workspace)?, None)?;
        let settings = workspace.child(".trylo")?;
        let output = settings.child("out")?;
        Ok(Self { directories: vec![workspace, settings, output] })
    }
    fn output(&self) -> &HeldDirectory { &self.directories[2] }
}

fn open_regular_file(directory: &HeldDirectory, name: &str, output: &Path) -> io::Result<(File, fs::Metadata)> {
    let target = directory.io_path().join(name);
    if !reject_link(&target)?.is_file() { return Err(denied()); }
    #[cfg(target_os = "macos")]
    let file = open_macos_path(&target, Some(directory), libc::O_NONBLOCK)?;
    #[cfg(not(target_os = "macos"))]
    let file = {
        let mut options = OpenOptions::new(); options.read(true);
        #[cfg(windows)] {
            use std::os::windows::fs::OpenOptionsExt;
            options.share_mode(1).custom_flags(0x00200000); // READ share only; OPEN_REPARSE_POINT.
        }
        options.open(&target)?
    };
    let actual = opened_path(&file)?;
    if !actual.starts_with(output) || actual.parent() != Some(directory.path.as_path()) { return Err(denied()); }
    let metadata = regular_metadata(&file, false)?;
    if metadata.len() > MAX_REMOTE_ARTIFACT_BYTES { return Err(io::Error::new(io::ErrorKind::InvalidData, "Remote artifact exceeds 12 MiB")); }
    Ok((file, metadata))
}

pub fn read_remote_artifact(workspace: &Path, relative: &str) -> io::Result<Vec<u8>> {
    let parts = relative_parts(relative)?;
    let root = ArtifactRoot::open(workspace)?;
    let mut ancestors = Vec::new();
    for part in &parts[..parts.len() - 1] {
        let parent = ancestors.last().unwrap_or(root.output());
        ancestors.push(parent.child(part)?);
    }
    let directory = ancestors.last().unwrap_or(root.output());
    let (file, metadata) = open_regular_file(directory, parts[parts.len() - 1], &root.output().path)?;
    let capacity = usize::try_from(metadata.len()).map_err(io::Error::other)?;
    let mut bytes = Vec::with_capacity(capacity);
    file.take(MAX_REMOTE_ARTIFACT_BYTES + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_REMOTE_ARTIFACT_BYTES { return Err(io::Error::new(io::ErrorKind::InvalidData, "Remote artifact exceeds 12 MiB")); }
    Ok(bytes)
}

pub fn list_remote_artifacts(workspace: &Path) -> io::Result<Vec<RemoteArtifactFile>> {
    fn walk(directory: &HeldDirectory, output: &Path, prefix: &str, depth: usize, files: &mut Vec<RemoteArtifactFile>, visited: &mut usize) -> io::Result<()> {
        for entry in fs::read_dir(directory.io_path())? {
            if files.len() >= MAX_REMOTE_ARTIFACT_FILES || *visited >= MAX_REMOTE_ARTIFACT_ENTRIES { break; }
            *visited += 1;
            let Ok(entry) = entry else { continue; };
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue; };
            let relative = if prefix.is_empty() { name.to_owned() } else { format!("{prefix}/{name}") };
            if relative_parts(&relative).is_err() { continue; }
            let Ok(metadata) = reject_link(&directory.io_path().join(name)) else { continue; };
            if metadata.is_dir() {
                if depth < MAX_REMOTE_ARTIFACT_DEPTH {
                    if let Ok(child) = directory.child(name) { let _ = walk(&child, output, &relative, depth + 1, files, visited); }
                }
            } else if let Ok((_file, metadata)) = open_regular_file(directory, name, output) {
                let modified_ms = metadata.modified().ok().and_then(|value| value.duration_since(SystemTime::UNIX_EPOCH).ok()).map_or(0, |value| value.as_millis());
                files.push(RemoteArtifactFile { relative_path: relative, size: metadata.len(), modified_ms });
            }
        }
        Ok(())
    }
    let root = ArtifactRoot::open(workspace)?;
    let mut files = Vec::new();
    let mut visited = 0;
    walk(root.output(), &root.output().path, "", 0, &mut files, &mut visited)?;
    Ok(files)
}

#[cfg(test)]
mod tests {
    use super::*;
    static NEXT_FIXTURE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let base = std::env::var_os("TRYLO_SECURITY_TEST_ROOT").map_or_else(std::env::temp_dir, PathBuf::from);
            let serial = NEXT_FIXTURE.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let root = base.join(format!("trylo-remote-artifact-{}-{}-{serial}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
            fs::create_dir_all(root.join(".trylo/out/nested")).unwrap(); Self(root)
        }
    }
    impl Drop for Fixture { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }

    #[cfg(windows)]
    fn directory_junction(link: &Path, target: &Path) {
        use std::os::windows::process::CommandExt;
        // This fixture uses the standard OS helper without a visible console.
        // The configurable test root cannot introduce cmd metacharacters.
        for path in [link, target] {
            assert!(!path.to_string_lossy().contains(['&', '|', '<', '>', '^', '%', '!', '"', '\r', '\n']), "Test root cannot contain cmd metacharacters");
        }
        let result = std::process::Command::new("cmd.exe")
            .args(["/D", "/C", "mklink", "/J"])
            .arg(link.to_string_lossy().replace('/', "\\"))
            .arg(target.to_string_lossy().replace('/', "\\"))
            .creation_flags(0x08000000)
            .output().unwrap();
        assert!(result.status.success(), "Could not create junction fixture: {}", String::from_utf8_lossy(&result.stderr));
    }

    #[test]
    fn regular_contained_file_is_read() {
        let fixture = Fixture::new();
        fs::write(fixture.0.join(".trylo/out/nested/report.txt"), b"contained").unwrap();
        assert_eq!(read_remote_artifact(&fixture.0, "nested/report.txt").unwrap(), b"contained");
    }
    #[test]
    fn invalid_remote_path_forms_are_rejected() {
        for value in ["", "/report.txt", "../report.txt", "nested/../report.txt", "nested\\report.txt", "report.txt:stream", "report.txt.", "report.txt ", "NUL.txt", "COM1.txt", "nested//report.txt", "report\0.txt"] { assert!(relative_parts(value).is_err(), "{value:?}"); }
    }
    #[test]
    fn large_files_are_rejected_before_allocation() {
        let fixture = Fixture::new();
        let file = File::create(fixture.0.join(".trylo/out/large.dat")).unwrap();
        file.set_len(MAX_REMOTE_ARTIFACT_BYTES + 1).unwrap(); drop(file);
        assert_eq!(read_remote_artifact(&fixture.0, "large.dat").unwrap_err().kind(), io::ErrorKind::InvalidData);
    }
    #[test]
    fn directories_are_not_remote_files() {
        let fixture = Fixture::new(); assert!(read_remote_artifact(&fixture.0, "nested").is_err());
    }
    #[test]
    fn empty_files_and_the_exact_size_limit_are_supported() {
        let fixture = Fixture::new();
        fs::write(fixture.0.join(".trylo/out/empty.txt"), b"").unwrap();
        assert!(read_remote_artifact(&fixture.0, "empty.txt").unwrap().is_empty());
        let file = File::create(fixture.0.join(".trylo/out/at-limit.dat")).unwrap();
        file.set_len(MAX_REMOTE_ARTIFACT_BYTES).unwrap(); drop(file);
        assert_eq!(read_remote_artifact(&fixture.0, "at-limit.dat").unwrap().len() as u64, MAX_REMOTE_ARTIFACT_BYTES);
    }
    #[test]
    fn missing_or_relative_workspaces_are_rejected() {
        let fixture = Fixture::new();
        assert!(read_remote_artifact(Path::new("relative-workspace"), "report.txt").is_err());
        assert!(read_remote_artifact(&fixture.0.join("missing"), "report.txt").is_err());
        assert!(read_remote_artifact(&fixture.0, "missing.txt").is_err());
        assert!(list_remote_artifacts(&fixture.0.join("missing")).is_err());
    }
    #[test]
    fn remote_listing_contains_only_bounded_relative_regular_file_metadata() {
        let fixture = Fixture::new();
        fs::write(fixture.0.join(".trylo/out/nested/report.txt"), b"report").unwrap();
        fs::write(fixture.0.join(".trylo/out/empty.txt"), b"").unwrap();
        let large = File::create(fixture.0.join(".trylo/out/large.dat")).unwrap();
        large.set_len(MAX_REMOTE_ARTIFACT_BYTES + 1).unwrap(); drop(large);
        let files = list_remote_artifacts(&fixture.0).unwrap();
        assert_eq!(files.len(), 2);
        assert!(files.iter().any(|file| file.relative_path == "nested/report.txt" && file.size == 6));
        assert!(files.iter().all(|file| Path::new(&file.relative_path).is_relative() && !file.relative_path.contains('\\') && file.modified_ms > 0));
    }
    #[test]
    fn remote_listing_limits_files_and_directory_depth() {
        let fixture = Fixture::new();
        let output = fixture.0.join(".trylo/out");
        for index in 0..=MAX_REMOTE_ARTIFACT_FILES {
            fs::write(output.join(format!("report-{index}.txt")), b"").unwrap();
        }
        assert_eq!(list_remote_artifacts(&fixture.0).unwrap().len(), MAX_REMOTE_ARTIFACT_FILES);
        let nested_fixture = Fixture::new();
        let mut current = nested_fixture.0.join(".trylo/out");
        for index in 0..=MAX_REMOTE_ARTIFACT_DEPTH {
            current.push(format!("level-{index}")); fs::create_dir(&current).unwrap();
            fs::write(current.join("report.txt"), b"").unwrap();
        }
        let files = list_remote_artifacts(&nested_fixture.0).unwrap();
        assert_eq!(files.len(), MAX_REMOTE_ARTIFACT_DEPTH);
        assert!(files.iter().all(|file| file.relative_path.split('/').count() <= MAX_REMOTE_ARTIFACT_DEPTH + 1));
    }
    #[cfg(any(unix, windows))]
    #[test]
    #[cfg_attr(windows, ignore = "Requires OS symbolic-link privilege or Windows Developer Mode")]
    fn links_to_otherwise_permitted_files_and_directories_are_rejected() {
        let fixture = Fixture::new();
        fs::write(fixture.0.join(".trylo/out/nested/report.txt"), b"regular test file").unwrap();
        let output = fixture.0.join(".trylo/out");
        #[cfg(unix)]
        let result = std::os::unix::fs::symlink(output.join("nested/report.txt"), output.join("linked-file.txt"));
        #[cfg(windows)]
        let result = std::os::windows::fs::symlink_file(output.join("nested/report.txt"), output.join("linked-file.txt"));
        result.expect("Cannot create ordinary link fixture");
        #[cfg(unix)]
        std::os::unix::fs::symlink(output.join("nested"), output.join("linked-directory")).unwrap();
        #[cfg(windows)]
        std::os::windows::fs::symlink_dir(output.join("nested"), output.join("linked-directory")).unwrap();
        assert_eq!(read_remote_artifact(&fixture.0, "linked-file.txt").unwrap_err().kind(), io::ErrorKind::PermissionDenied);
        assert_eq!(read_remote_artifact(&fixture.0, "linked-directory/report.txt").unwrap_err().kind(), io::ErrorKind::PermissionDenied);
        assert!(list_remote_artifacts(&fixture.0).unwrap().iter().all(|file| !file.relative_path.starts_with("linked-")));
        // A normal file in that same directory remains readable.
        assert_eq!(read_remote_artifact(&fixture.0, "nested/report.txt").unwrap(), b"regular test file");
    }
    #[cfg(windows)]
    #[test]
    fn ordinary_directory_junction_is_rejected() {
        let fixture = Fixture::new();
        let output = fixture.0.join(".trylo/out");
        let link = output.join("linked-directory");
        let target = output.join("nested");
        fs::write(target.join("report.txt"), b"regular test file").unwrap();
        directory_junction(&link, &target);
        assert_eq!(read_remote_artifact(&fixture.0, "linked-directory/report.txt").unwrap_err().kind(), io::ErrorKind::PermissionDenied);
        let files = list_remote_artifacts(&fixture.0).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].relative_path, "nested/report.txt");
        assert_eq!(read_remote_artifact(&fixture.0, "nested/report.txt").unwrap(), b"regular test file");
    }
    #[cfg(windows)]
    #[test]
    fn linked_output_roots_are_rejected_for_both_listing_and_reading() {
        for component in [".trylo", ".trylo/out"] {
            let fixture = Fixture::new();
            fs::write(fixture.0.join(".trylo/out/report.txt"), b"regular test file").unwrap();
            let source = fixture.0.join(component);
            let target = source.with_file_name("relocated-directory");
            let fixture_path = fs::canonicalize(&fixture.0).unwrap();
            assert!(fs::canonicalize(&source).unwrap().starts_with(&fixture_path));
            assert!(fs::canonicalize(target.parent().unwrap()).unwrap().starts_with(&fixture_path));
            fs::rename(&source, &target).unwrap();
            directory_junction(&source, &target);
            assert!(read_remote_artifact(&fixture.0, "report.txt").is_err());
            assert!(list_remote_artifacts(&fixture.0).is_err());
        }
    }
    #[cfg(windows)]
    #[test]
    fn opened_output_directory_prevents_rename_until_operation_finishes() {
        let fixture = Fixture::new();
        let root = ArtifactRoot::open(&fixture.0).unwrap();
        let source = fixture.0.join(".trylo/out");
        let destination = fixture.0.join(".trylo/renamed-out");
        let fixture_path = fs::canonicalize(&fixture.0).unwrap();
        assert!(fs::canonicalize(&source).unwrap().starts_with(&fixture_path));
        assert!(fs::canonicalize(destination.parent().unwrap()).unwrap().starts_with(&fixture_path));
        assert!(fs::rename(&source, &destination).is_err());
        drop(root);
        fs::rename(&source, &destination).unwrap();
    }
}
