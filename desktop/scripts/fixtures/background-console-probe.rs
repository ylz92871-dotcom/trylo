#![cfg_attr(not(console_child), windows_subsystem = "windows")]

use std::ffi::c_void;

#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetConsoleWindow() -> *mut c_void;
}

#[cfg(console_child)]
#[link(name = "user32")]
unsafe extern "system" {
    fn IsWindowVisible(window: *mut c_void) -> i32;
}

#[cfg(not(console_child))]
#[path = "../../src-tauri/src/commands/background_command.rs"]
mod background_command;

#[cfg(console_child)]
fn main() {
    // Give the console host time to show the window before observing it.
    std::thread::sleep(std::time::Duration::from_millis(100));
    let window = unsafe { GetConsoleWindow() };
    println!(
        "{{\"console\":{},\"visible\":{}}}",
        !window.is_null(),
        unsafe { IsWindowVisible(window) } != 0
    );
}

#[cfg(not(console_child))]
fn main() {
    let args: Vec<String> = std::env::args().collect();
    let mode = &args[1];
    let report = &args[2];
    let program = &args[3];
    let parent_console = !unsafe { GetConsoleWindow() }.is_null();
    let mut command = if mode.starts_with("baseline") {
        std::process::Command::new(program)
    } else {
        background_command::command(program)
    };
    command.args(&args[4..]);
    let output = if mode.ends_with("tokio") {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(tokio::process::Command::from(command).output())
            .unwrap()
    } else {
        command.output().unwrap()
    };
    std::fs::write(
        report,
        format!(
            "{{\"parentConsole\":{parent_console},\"exit\":{},\"child\":{}}}",
            output.status.code().unwrap_or(-1),
            String::from_utf8_lossy(&output.stdout).trim()
        ),
    )
    .unwrap();
}
