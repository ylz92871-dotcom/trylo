use std::os::windows::process::CommandExt;
use std::process::Command;

pub(crate) fn configure_background(command: &mut Command) {
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
}
