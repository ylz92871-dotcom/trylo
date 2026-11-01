use std::ffi::OsStr;
use std::process::Command;

/// Background workers communicate through pipes; they never need a console.
/// Construct before converting to Tokio so both process APIs share the policy.
pub(super) fn command(program: impl AsRef<OsStr>) -> Command {
    #[allow(unused_mut)] // Only Windows needs mutable launch flags.
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}
