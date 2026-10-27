use std::io;

/// While a Windows team root is awaited, its tree belongs to the Native shell
/// even if it exits without running Rust destructors. The job handle is neither
/// named nor inherited; losing this owner closes its last handle and kills
/// the owned tree. Unix retains its existing explicit-stop policy.
#[derive(Clone)]
pub struct TeamProcessGuard {
    #[cfg(windows)]
    job: std::sync::Arc<std::os::windows::io::OwnedHandle>,
}

impl TeamProcessGuard {
    pub fn capture(child: &std::process::Child) -> io::Result<Self> {
        #[cfg(windows)]
        {
            use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
            use windows_sys::Win32::System::JobObjects::{
                AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
                SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            };
            // Null attributes create a non-inheritable, unnamed owner handle.
            let raw = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
            if raw.is_null() {
                return Err(io::Error::last_os_error());
            }
            // The non-null handle above is newly owned and closed exactly once.
            let job = unsafe { OwnedHandle::from_raw_handle(raw) };
            // This Windows ABI record contains only scalar fields and POD structs.
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let size = u32::try_from(std::mem::size_of_val(&limits))
                .map_err(|_| io::Error::other("job limits size overflow"))?;
            // The owned handle and exact-size limits buffer live across this call.
            if unsafe {
                SetInformationJobObject(
                    job.as_raw_handle(),
                    JobObjectExtendedLimitInformation,
                    std::ptr::addr_of!(limits).cast(),
                    size,
                )
            } == 0
            {
                return Err(io::Error::last_os_error());
            }
            // The original Child handle pins the exact newly spawned process.
            if unsafe { AssignProcessToJobObject(job.as_raw_handle(), child.as_raw_handle()) } == 0
            {
                return Err(io::Error::last_os_error());
            }
            Ok(Self {
                job: std::sync::Arc::new(job),
            })
        }
        #[cfg(not(windows))]
        {
            let _ = child;
            Ok(Self {})
        }
    }

    #[cfg(windows)]
    pub fn terminate(&self) -> io::Result<()> {
        use std::os::windows::io::AsRawHandle;
        // This operates on the pinned job object; no numeric-PID helper is
        // needed for team roots. The original reaper still confirms exit.
        if unsafe {
            windows_sys::Win32::System::JobObjects::TerminateJobObject(
                self.job.as_raw_handle(),
                130,
            )
        } == 0
        {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }

    #[cfg(windows)]
    pub fn release_after_exit(&self) -> io::Result<()> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::System::JobObjects::{
            JobObjectExtendedLimitInformation, SetInformationJobObject,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        };
        // Once Child.wait observed exit, the CLI's normal background-process
        // policy takes over. Closing this crash guard must not kill a server
        // intentionally left running by a completed turn. Explicit Stop has
        // already terminated the job before reaching this branch.
        let limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        let size = u32::try_from(std::mem::size_of_val(&limits))
            .map_err(|_| io::Error::other("job limits size overflow"))?;
        // The exact-size buffer and the pinned job remain valid across the call.
        if unsafe {
            SetInformationJobObject(
                self.job.as_raw_handle(),
                JobObjectExtendedLimitInformation,
                std::ptr::addr_of!(limits).cast(),
                size,
            )
        } == 0
        {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }
}

#[cfg(all(test, windows))]
mod tests;
