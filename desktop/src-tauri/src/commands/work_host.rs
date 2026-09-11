// Trylo Desktop — Work sub-app host commands. See
// ../../../work/src/host-adapter/host-adapter.ts for the contract
// these implement on the renderer side.
//
// Commands:
//   - openFile: opens with the OS default handler. Windows goes
//     through ShellExecuteW via direct FFI — NO `cmd /c start`
//     and no shell string concatenation (M3 closure §9.3,
//     M3-P1-11). macOS uses `open`, Linux `xdg-open`, both as
//     argument-vector launches (never through a shell).
//
//   - openFileWithApp: launches `app_identifier` directly with
//     the target as its single argument; on failure falls back
//     to openFile (same behaviour as before, but shell-free).
//
//   - showInFolder: opens the parent directory of a VALIDATED
//     target in the system file manager.
//
//   - copyToClipboard: Tauri clipboard plugin; no path involved.
//
// SECURITY GATE (§9.3). Artifact paths arrive from the
// daemon/agent and are untrusted. Every file action:
//   1. canonicalizes the allowed root and the target with
//      `std::fs::canonicalize` — this proves EXISTENCE and
//      resolves every symlink/junction to its real location;
//   2. rejects UNC / device namespaces that survive
//      canonicalization;
//   3. proves the target is strictly inside the allowed root on
//      a COMPONENT boundary (`Path::starts_with`, not string
//      prefix). A symlink pointing outside the root therefore
//      canonicalizes outside and is refused.
// http(s) URLs skip the file gate and are opened in the default
// browser; everything else that looks URL-ish is refused.
//
// Note on Tauri arg naming: Tauri 2 auto-converts the JS-side
// camelCase argument names to snake_case in Rust. So the JS
// payload `{ filePath, allowedRoot }` arrives here as
// `file_path`, `allowed_root`.

use std::path::{Component, Path, PathBuf, Prefix};
// Windows launches through ShellExecuteW FFI; only macOS /
// Linux need the argv launcher.
#[cfg(any(target_os = "macos", target_os = "linux"))]
use std::process::Command;

use tauri::AppHandle;
use tauri_plugin_clipboard_manager::ClipboardExt;

use crate::commands::error::{io_error, CommandError};

fn gate_error(context: &str, message: impl Into<String>) -> CommandError {
    io_error(
        context,
        std::io::Error::new(std::io::ErrorKind::PermissionDenied, message.into()),
    )
}

/// True for `http://` / `https://` values without control
/// characters — the only non-file values a launcher may see.
fn is_http_url(value: &str) -> bool {
    let trimmed = value.trim();
    let ok_scheme = trimmed.len() > 8
        && (trimmed[..7].eq_ignore_ascii_case("http://")
            || trimmed[..8].eq_ignore_ascii_case("https://"));
    ok_scheme && !trimmed.chars().any(char::is_control)
}

/// True when every component of `target` after canonicalization
/// is a normal disk path — no UNC shares, no device namespaces.
fn is_plain_disk_path(path: &Path) -> bool {
    for component in path.components() {
        if let Component::Prefix(prefix) = component {
            match prefix.kind() {
                // VerbatimDisk (`\\?\C:`) is the canonical form
                // fs::canonicalize returns on Windows — allowed.
                Prefix::Disk(_) | Prefix::VerbatimDisk(_) => {}
                Prefix::UNC(..)
                | Prefix::VerbatimUNC(..)
                | Prefix::DeviceNS(..)
                | Prefix::Verbatim(_) => return false,
            }
        }
    }
    true
}

/// §9.3 containment gate. Returns the canonical target ready to
/// hand to a launcher. Rejects: missing root, missing target,
/// device/UNC paths, and anything whose REAL location (after
/// symlink resolution) is not strictly inside the root.
fn validate_target(file_path: &str, allowed_root: &str) -> Result<PathBuf, CommandError> {
    let root = std::fs::canonicalize(allowed_root).map_err(|e| {
        gate_error(
            "(work_host)",
            format!("项目根目录不可用 ({allowed_root}): {e}"),
        )
    })?;
    let target = std::fs::canonicalize(file_path).map_err(|e| {
        gate_error(
            "(work_host)",
            format!("目标不存在或不可访问 ({file_path}): {e}"),
        )
    })?;
    if !is_plain_disk_path(&target) || !is_plain_disk_path(&root) {
        return Err(gate_error(
            "(work_host)",
            format!("设备或网络路径不允许打开: {file_path}"),
        ));
    }
    // `starts_with` compares whole COMPONENTS, so `C:\repo2`
    // never matches root `C:\repo`. Equality is rejected too:
    // opening the root itself is not an artifact action.
    if target == root || !target.starts_with(&root) {
        return Err(gate_error(
            "(work_host)",
            format!("目标不在当前项目根目录内，已拒绝打开: {file_path}"),
        ));
    }
    Ok(target)
}

#[tauri::command]
pub async fn work_host_open_file(
    file_path: String,
    allowed_root: String,
) -> Result<(), CommandError> {
    if is_http_url(&file_path) {
        return open_with_default_app(Path::new(&file_path))
            .map_err(|e| io_error("(work_host_open_file)", std::io::Error::other(e)));
    }
    let target = validate_target(&file_path, &allowed_root)?;
    open_with_default_app(&target)
        .map_err(|e| io_error("(work_host_open_file)", std::io::Error::other(e)))
}

#[tauri::command]
pub async fn work_host_open_file_with_app(
    file_path: String,
    app_identifier: String,
    app_name: String,
    allowed_root: String,
) -> Result<(), CommandError> {
    let target = validate_target(&file_path, &allowed_root)?;
    // Try the platform-specific launch first. If it returns
    // Err, fall back to the default-app open. This matches the
    // cowork-os behavior: user picked "Open in Word", Word isn't
    // installed → file still opens in the default app.
    if let Err(e) = launch_with_app(&target, &app_identifier) {
        eprintln!(
            "[work_host] openFileWithApp({app_name}) failed: {e}; falling back to default app"
        );
        open_with_default_app(&target).map_err(|e2| {
            io_error(
                "(work_host_open_file_with_app)",
                std::io::Error::other(format!("{e}; fallback also failed: {e2}")),
            )
        })
    } else {
        Ok(())
    }
}

#[tauri::command]
pub async fn work_host_show_in_folder(
    file_path: String,
    allowed_root: String,
) -> Result<(), CommandError> {
    if is_http_url(&file_path) {
        return Err(gate_error(
            "(work_host_show_in_folder)",
            "网址没有可显示的文件夹",
        ));
    }
    let target = validate_target(&file_path, &allowed_root)?;
    // The parent of a contained path is either contained or the
    // root itself — both are inside the allowed boundary.
    let parent = target.parent().unwrap_or(&target);
    open_with_default_app(parent)
        .map_err(|e| io_error("(work_host_show_in_folder)", std::io::Error::other(e)))
}

#[tauri::command]
pub async fn work_host_copy_to_clipboard(text: String, app: AppHandle) -> Result<(), CommandError> {
    app.clipboard().write_text(text).map_err(|e| {
        io_error(
            "(work_host_copy_to_clipboard)",
            std::io::Error::other(e.to_string()),
        )
    })
}

// ── Platform-specific launchers (no shell involved) ───────────────

/// Shell-free default-app open. On Windows this is a direct
/// `ShellExecuteW` FFI call (no `cmd`, no argument string joining);
/// on macOS/Linux it is an argv launch of `open` / `xdg-open` —
/// `std::process::Command` never spawns a shell.
fn open_with_default_app(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        shell_execute_windows(path, None)
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(path)
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    #[cfg(target_os = "linux")]
    {
        Command::new("xdg-open")
            .arg(path)
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
}

fn launch_with_app(path: &Path, app_identifier: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        // ShellExecuteW with the app as the "file" and the target
        // as its parameters — still no shell, and the identifier
        // must be a plain executable token.
        if !is_safe_app_identifier(app_identifier) {
            return Err(format!("unsafe app identifier: {app_identifier}"));
        }
        shell_execute_windows(Path::new(app_identifier), Some(path))
    }
    #[cfg(target_os = "macos")]
    {
        // `open -a <app> <path>` — argv launch, no shell.
        Command::new("open")
            .args(["-a", app_identifier])
            .arg(path)
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    #[cfg(target_os = "linux")]
    {
        // xdg-open doesn't support specifying an app directly.
        // The `app_identifier` is treated as the .desktop file
        // name; if that's wrong we fall back to default-app
        // open.
        Command::new("xdg-open")
            .arg(path)
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
}

/// App identifiers reach the OS as a launch target; restrict them
/// to plain filename tokens (no separators, no dots-leading
/// escapes beyond a normal extension).
fn is_safe_app_identifier(identifier: &str) -> bool {
    !identifier.is_empty()
        && identifier.len() <= 64
        && identifier
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_')
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn http_url_detection() {
        assert!(is_http_url("http://example.com"));
        assert!(is_http_url("HTTPS://example.com/a?b=1"));
        assert!(is_http_url("  https://example.com  "));
        assert!(!is_http_url("file://c:/windows"));
        assert!(!is_http_url("javascript:alert(1)"));
        assert!(!is_http_url("https://example.com/\u{0000}"));
        assert!(!is_http_url("http"));
    }

    #[test]
    fn app_identifier_allowlist() {
        assert!(is_safe_app_identifier("winword"));
        assert!(is_safe_app_identifier("soffice.bin"));
        assert!(is_safe_app_identifier("notepad"));
        assert!(!is_safe_app_identifier(""));
        assert!(!is_safe_app_identifier("cmd /c del"));
        assert!(!is_safe_app_identifier("a\\b"));
        assert!(!is_safe_app_identifier("../evil"));
        assert!(!is_safe_app_identifier(&"x".repeat(65)));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn plain_disk_path_accepts_verbatim_disk() {
        // fs::canonicalize returns `\\?\C:\...` on Windows; the
        // VerbatimDisk prefix must pass the component scan.
        let path = Path::new(r"\\?\C:\repo\out\a.md");
        assert!(is_plain_disk_path(path));
        assert!(!is_plain_disk_path(Path::new(r"\\?\UNC\server\share\a.md")));
        assert!(!is_plain_disk_path(Path::new(r"\\.\PhysicalDrive0")));
    }

    #[test]
    fn containment_uses_component_boundaries() {
        // Path::starts_with is component-based: `repo2` is NOT
        // contained in `repo`, `repo/out` IS. starts_with is
        // reflexive (a path equals itself), which is why
        // validate_target ALSO rejects `target == root`.
        let root = Path::new("/repo");
        assert!(Path::new("/repo/out/a.md").starts_with(root));
        assert!(!Path::new("/repo2/a.md").starts_with(root));
        assert!(Path::new("/repo").starts_with(root)); // reflexive
    }
}
