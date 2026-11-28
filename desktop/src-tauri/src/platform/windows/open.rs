use std::path::Path;

pub(crate) fn open_with_default_app(path: &Path) -> Result<(), String> {
    shell_execute_windows(path, None)
}

pub(crate) fn launch_with_app(path: &Path, app_identifier: &str) -> Result<(), String> {
    shell_execute_windows(Path::new(app_identifier), Some(path))
}

#[cfg(target_os = "windows")]
fn to_wide(value: &std::ffi::OsStr) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    value.encode_wide().chain(std::iter::once(0)).collect()
}

/// Direct `ShellExecuteW` call — the §9.3 "no shell" requirement.
/// `parameters` is used for open-with-app (app = file, target =
/// parameters); `None` opens the file/URL with its default
/// handler. Returns codes <= 32 as errors per the Win32 contract.
#[cfg(target_os = "windows")]
fn shell_execute_windows(file: &Path, parameters: Option<&Path>) -> Result<(), String> {
    extern "system" {
        fn ShellExecuteW(
            hwnd: *mut core::ffi::c_void,
            lp_operation: *const u16,
            lp_file: *const u16,
            lp_parameters: *const u16,
            lp_directory: *const u16,
            n_show_cmd: i32,
        ) -> isize;
    }

    let file_wide = to_wide(file.as_os_str());
    let params_wide = parameters.map(|p| to_wide(p.as_os_str()));
    let result = unsafe {
        ShellExecuteW(
            core::ptr::null_mut(),
            core::ptr::null(), // default "open" verb
            file_wide.as_ptr(),
            params_wide
                .as_ref()
                .map_or(core::ptr::null(), std::vec::Vec::as_ptr),
            core::ptr::null(),
            5, // SW_SHOW
        )
    };
    if result > 32 {
        Ok(())
    } else {
        Err(format!("ShellExecuteW failed with code {result}"))
    }
}

pub(crate) fn reveal_in_folder(path: &Path) -> Result<(), String> {
    open_with_default_app(path.parent().unwrap_or(path))
}
