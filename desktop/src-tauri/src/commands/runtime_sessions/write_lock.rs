use std::fs::File;
use std::io;
use std::path::Path;
use std::time::{Duration, Instant};

/// The persistent lock file is only a rendezvous point. The OS handle owns the
/// lock and releases it on close or process exit; never unlink this file.
pub(crate) struct WorkspaceWriteLock {
    _file: File,
}

impl WorkspaceWriteLock {
    pub(crate) fn acquire(path: &Path, timeout: Duration) -> io::Result<Self> {
        let started = Instant::now();
        loop {
            match try_acquire(path) {
                Ok(file) => return Ok(Self { _file: file }),
                Err(error) if contended(&error) => {
                    let Some(remaining) = timeout.checked_sub(started.elapsed()) else {
                        return Err(io::Error::new(io::ErrorKind::TimedOut,
                            "another Desktop process is saving CLI session associations; retry after it finishes"));
                    };
                    std::thread::sleep(remaining.min(Duration::from_millis(10)));
                }
                Err(error) => return Err(error),
            }
        }
    }
}

fn regular_file(metadata: &std::fs::Metadata) -> io::Result<()> {
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "session lock is not a regular file",
        ));
    }
    Ok(())
}

fn check_path(path: &Path) -> io::Result<()> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) => regular_file(&metadata),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

#[cfg(windows)]
fn try_acquire(path: &Path) -> io::Result<File> {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT;
    check_path(path)?;
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .share_mode(0)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)?;
    regular_file(&file.metadata()?)?;
    Ok(file)
}

#[cfg(windows)]
fn contended(error: &io::Error) -> bool {
    matches!(error.raw_os_error(), Some(32 | 33))
}

#[cfg(unix)]
fn try_acquire(path: &Path) -> io::Result<File> {
    use std::os::fd::AsRawFd;
    use std::os::unix::fs::OpenOptionsExt;
    check_path(path)?;
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)?;
    regular_file(&file.metadata()?)?;
    // This owned descriptor stays open in the guard; closing it releases flock.
    let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
    if result == 0 {
        Ok(file)
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(unix)]
fn contended(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
    )
}

#[cfg(not(any(windows, unix)))]
fn try_acquire(_path: &Path) -> io::Result<File> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "session file locking is unavailable on this platform",
    ))
}

#[cfg(not(any(windows, unix)))]
fn contended(_error: &io::Error) -> bool {
    false
}
