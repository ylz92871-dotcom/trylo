use std::ffi::c_void;

#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetConsoleWindow() -> *mut c_void;
    fn GetCurrentProcess() -> *mut c_void;
    fn CloseHandle(handle: *mut c_void) -> i32;
}
#[link(name = "user32")]
unsafe extern "system" {
    fn IsWindowVisible(window: *mut c_void) -> i32;
}
#[link(name = "advapi32")]
unsafe extern "system" {
    fn OpenProcessToken(process: *mut c_void, access: u32, token: *mut *mut c_void) -> i32;
    fn GetTokenInformation(
        token: *mut c_void,
        class: u32,
        output: *mut c_void,
        size: u32,
        needed: *mut u32,
    ) -> i32;
    fn GetSidSubAuthorityCount(sid: *const c_void) -> *const u8;
    fn GetSidSubAuthority(sid: *const c_void, index: u32) -> *const u32;
}

fn integrity() -> u32 {
    unsafe {
        let mut token = std::ptr::null_mut();
        assert_ne!(OpenProcessToken(GetCurrentProcess(), 8, &mut token), 0);
        let mut needed = 0;
        GetTokenInformation(token, 25, std::ptr::null_mut(), 0, &mut needed);
        let mut buffer = vec![0_u8; needed as usize];
        assert_ne!(
            GetTokenInformation(token, 25, buffer.as_mut_ptr().cast(), needed, &mut needed),
            0
        );
        let sid = *buffer.as_ptr().cast::<*const c_void>();
        let rid = *GetSidSubAuthority(sid, u32::from(*GetSidSubAuthorityCount(sid)) - 1);
        CloseHandle(token);
        rid
    }
}

fn main() {
    let window = unsafe { GetConsoleWindow() };
    let record = format!(
        "{{\"console\":{},\"visible\":{},\"integrityRid\":{}}}",
        !window.is_null(),
        unsafe { IsWindowVisible(window) } != 0,
        integrity()
    );
    let report = std::env::args()
        .nth(1)
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| {
            std::env::current_exe()
                .unwrap()
                .parent()
                .unwrap()
                .join("desktop-started.json")
        });
    std::fs::write(report, record).unwrap();
}
