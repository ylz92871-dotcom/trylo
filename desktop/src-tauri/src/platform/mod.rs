//! Native operations only. Commands retain validation and IPC ownership.
use std::ffi::OsStr;
use std::process::Command;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
mod windows;

#[cfg(target_os = "linux")]
pub(crate) use linux::{open, pick_folder};
#[cfg(target_os = "macos")]
pub(crate) use macos::{open, pick_folder};
#[cfg(target_os = "windows")]
pub(crate) use windows::{open, pick_folder};

pub(crate) fn background_command(program: impl AsRef<OsStr>) -> Command {
    #[allow(unused_mut)]
    let mut command = Command::new(program);
    #[cfg(windows)]
    windows::process::configure_background(&mut command);
    command
}
