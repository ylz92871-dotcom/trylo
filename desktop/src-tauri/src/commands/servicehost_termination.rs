//! Service Host owns workers, but the singleton desktop pet belongs to all
//! connected clients. Never use an image-wide sweep or taskkill /T here.

use std::io;
use std::process::Child;

#[cfg(windows)]
mod platform {
    use super::{io, Child};
    use std::collections::HashSet;
    use std::os::windows::io::{AsHandle, AsRawHandle, FromRawHandle, OwnedHandle};
    use windows_sys::Win32::Foundation::{ERROR_NO_MORE_FILES, FILETIME, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, QueryFullProcessImageNameW, TerminateProcess,
        WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
        PROCESS_TERMINATE,
    };

    struct Process {
        pid: u32,
        handle: OwnedHandle,
        created: u64,
    }

    fn creation_time(handle: &OwnedHandle) -> io::Result<u64> {
        let mut created = FILETIME::default();
        let mut exited = FILETIME::default();
        let mut kernel = FILETIME::default();
        let mut user = FILETIME::default();
        // SAFETY: owned process handle and writable FILETIME values.
        if unsafe {
            GetProcessTimes(
                handle.as_raw_handle(),
                &mut created,
                &mut exited,
                &mut kernel,
                &mut user,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok((u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime))
    }

    fn is_shared_pet(handle: &OwnedHandle) -> io::Result<bool> {
        let mut buffer = vec![0_u16; 32768];
        let mut len = u32::try_from(buffer.len()).expect("bounded image path");
        // SAFETY: owned process handle; buffer is valid for len UTF-16 units.
        if unsafe {
            QueryFullProcessImageNameW(handle.as_raw_handle(), 0, buffer.as_mut_ptr(), &mut len)
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        let image = String::from_utf16_lossy(&buffer[..len as usize]);
        Ok(image
            .rsplit(['\\', '/'])
            .next()
            .is_some_and(|name| name.eq_ignore_ascii_case("TryloDesktopPet.exe")))
    }

    fn snapshot() -> io::Result<Vec<(u32, u32)>> {
        // SAFETY: read-only process snapshot, no inherited handles.
        let raw = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
        if raw == INVALID_HANDLE_VALUE {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: snapshot returned a new valid owned handle.
        let snapshot = unsafe { OwnedHandle::from_raw_handle(raw) };
        let mut entry = PROCESSENTRY32W {
            dwSize: u32::try_from(std::mem::size_of::<PROCESSENTRY32W>())
                .expect("process entry size"),
            ..Default::default()
        };
        let mut rows = Vec::new();
        // SAFETY: valid snapshot and correctly sized output structure.
        let mut found = unsafe { Process32FirstW(snapshot.as_raw_handle(), &mut entry) };
        while found != 0 {
            rows.push((entry.th32ProcessID, entry.th32ParentProcessID));
            // SAFETY: same live snapshot and output structure.
            found = unsafe { Process32NextW(snapshot.as_raw_handle(), &mut entry) };
        }
        let error = io::Error::last_os_error();
        if error.raw_os_error() != i32::try_from(ERROR_NO_MORE_FILES).ok() {
            return Err(error);
        }
        Ok(rows)
    }

    pub struct HostProcessTree {
        root: Process,
    }

    impl HostProcessTree {
        pub fn capture(child: &Child) -> io::Result<Self> {
            // Retain the original object, not just its reusable PID. A delayed
            // watchdog must never terminate a new process with the same PID.
            let handle = child.as_handle().try_clone_to_owned()?;
            let created = creation_time(&handle)?;
            Ok(Self {
                root: Process {
                    pid: child.id(),
                    handle,
                    created,
                },
            })
        }

        pub fn terminate(&self) -> io::Result<()> {
            let mut owned = vec![Process {
                pid: self.root.pid,
                handle: self.root.handle.as_handle().try_clone_to_owned()?,
                created: self.root.created,
            }];
            let mut seen = HashSet::from([self.root.pid]);
            let mut first_error = None;
            // Re-scan after stopping parents to collect late workers. Handles
            // stay open across passes, preventing PID reuse in this tree.
            for _ in 0..3 {
                let rows = snapshot()?;
                let mut index = 0;
                while index < owned.len() {
                    for &(pid, parent) in &rows {
                        if parent != owned[index].pid || !seen.insert(pid) {
                            continue;
                        }
                        // SAFETY: open only descendants in this snapshot; verify
                        // their birth time before trusting the parent PID.
                        let raw = unsafe {
                            OpenProcess(
                                PROCESS_QUERY_LIMITED_INFORMATION
                                    | PROCESS_TERMINATE
                                    | PROCESS_SYNCHRONIZE,
                                0,
                                pid,
                            )
                        };
                        if raw.is_null() {
                            let error = io::Error::last_os_error();
                            if error.raw_os_error() != Some(87) {
                                first_error.get_or_insert(error);
                            }
                            continue;
                        }
                        // SAFETY: successful OpenProcess transfers ownership.
                        let handle = unsafe { OwnedHandle::from_raw_handle(raw) };
                        match creation_time(&handle)
                            .and_then(|created| Ok((created, is_shared_pet(&handle)?)))
                        {
                            Ok((created, false)) if created >= owned[index].created => {
                                owned.push(Process {
                                    pid,
                                    handle,
                                    created,
                                });
                            }
                            Ok(_) => {} // Shared pet (and its entire branch), or a stale parent PID.
                            Err(error) => {
                                first_error.get_or_insert(error);
                            }
                        }
                    }
                    index += 1;
                }
                for process in &owned {
                    // SAFETY: retained handles identify exact process objects.
                    if unsafe { WaitForSingleObject(process.handle.as_raw_handle(), 0) } != 0
                        && unsafe { TerminateProcess(process.handle.as_raw_handle(), 1) } == 0
                    {
                        // A concurrent natural exit is success as well.
                        if unsafe { WaitForSingleObject(process.handle.as_raw_handle(), 0) } != 0 {
                            first_error.get_or_insert_with(io::Error::last_os_error);
                        }
                    }
                }
            }
            first_error.map_or(Ok(()), Err)
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::os::windows::process::CommandExt;
        use std::path::{Path, PathBuf};
        use std::process::{Command, Stdio};
        use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

        fn spawn_fixture(exe: &Path, root: &Path, role: &str) -> Child {
            let filter = format!(
                "{}::process_fixture",
                module_path!().split_once("::").unwrap().1
            );
            Command::new(exe)
                .args(["--ignored", "--exact", &filter])
                .env("TRYLO_PROCESS_FIXTURE_ROOT", root)
                .env("TRYLO_PROCESS_FIXTURE_ROLE", role)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .creation_flags(0x0800_0000)
                .spawn()
                .unwrap()
        }

        #[test]
        #[ignore = "helper process for owned_tree_preserves_shared_pet_branch"]
        fn process_fixture() {
            let Ok(root) = std::env::var("TRYLO_PROCESS_FIXTURE_ROOT") else {
                return;
            };
            let root = PathBuf::from(root);
            let role = std::env::var("TRYLO_PROCESS_FIXTURE_ROLE").unwrap();
            let original = root.join("worker.exe");
            let _children = match role.as_str() {
                "host" => vec![
                    spawn_fixture(&original, &root, "worker"),
                    spawn_fixture(&root.join("TryloDesktopPet.exe"), &root, "pet"),
                ],
                "pet" => vec![spawn_fixture(&original, &root, "pet-worker")],
                _ => vec![],
            };
            std::fs::write(root.join(&role), std::process::id().to_string()).unwrap();
            std::thread::sleep(Duration::from_secs(120));
        }

        struct Cleanup(Vec<OwnedHandle>);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                for handle in &self.0 {
                    // SAFETY: every handle was opened on this test's fixtures.
                    unsafe {
                        TerminateProcess(handle.as_raw_handle(), 1);
                        WaitForSingleObject(handle.as_raw_handle(), 5000);
                    }
                }
            }
        }

        fn fixture_handle(root: &Path, role: &str) -> OwnedHandle {
            let deadline = Instant::now() + Duration::from_secs(15);
            loop {
                if let Ok(text) = std::fs::read_to_string(root.join(role)) {
                    if let Ok(pid) = text.parse::<u32>() {
                        // SAFETY: PID came from our freshly launched fixture.
                        let raw = unsafe {
                            OpenProcess(
                                PROCESS_QUERY_LIMITED_INFORMATION
                                    | PROCESS_TERMINATE
                                    | PROCESS_SYNCHRONIZE,
                                0,
                                pid,
                            )
                        };
                        assert!(!raw.is_null(), "fixture process must exist: {role}");
                        // SAFETY: successful OpenProcess returned an owned handle.
                        return unsafe { OwnedHandle::from_raw_handle(raw) };
                    }
                }
                assert!(Instant::now() < deadline, "fixture did not start: {role}");
                std::thread::sleep(Duration::from_millis(10));
            }
        }

        #[test]
        fn owned_tree_preserves_shared_pet_branch() {
            let root = std::env::temp_dir().join(format!(
                "trylo-process-tree-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            std::fs::create_dir_all(&root).unwrap();
            let exe = std::env::current_exe().unwrap();
            std::fs::copy(&exe, root.join("worker.exe")).unwrap();
            std::fs::copy(&exe, root.join("TryloDesktopPet.exe")).unwrap();
            let mut host = spawn_fixture(&root.join("worker.exe"), &root, "host");
            let mut foreign = spawn_fixture(&root.join("TryloDesktopPet.exe"), &root, "foreign");
            let tree = HostProcessTree::capture(&host).unwrap();
            let cleanup = Cleanup(
                ["host", "worker", "pet", "pet-worker", "foreign"]
                    .iter()
                    .map(|role| fixture_handle(&root, role))
                    .collect(),
            );
            tree.terminate().unwrap();
            // Repeated/stale stop must remain scoped to the same objects.
            tree.terminate().unwrap();
            for (index, handle) in cleanup.0.iter().enumerate() {
                // SAFETY: retained handles from our fixtures only.
                let status = unsafe {
                    WaitForSingleObject(handle.as_raw_handle(), if index < 2 { 5000 } else { 0 })
                };
                assert_eq!(
                    status,
                    if index < 2 { 0 } else { 258 },
                    "fixture index {index}"
                );
            }
            drop(cleanup);
            host.wait().unwrap();
            foreign.wait().unwrap();
            drop(tree);
            std::fs::remove_dir_all(root).unwrap();
        }
    }
}

#[cfg(not(windows))]
mod platform {
    use super::{io, Child};
    pub struct HostProcessTree {
        pid: u32,
    }
    impl HostProcessTree {
        pub fn capture(child: &Child) -> io::Result<Self> {
            Ok(Self { pid: child.id() })
        }
        pub fn terminate(&self) -> io::Result<()> {
            let status = std::process::Command::new("kill")
                .args(["-KILL", &self.pid.to_string()])
                .status()?;
            if status.success() {
                Ok(())
            } else {
                Err(io::Error::other("host termination failed"))
            }
        }
    }
}

pub use platform::HostProcessTree;
