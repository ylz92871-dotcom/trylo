// Trylo Desktop — Tauri command: pick_folder.
//
// v1.15.5: a working folder picker for Windows.
//
// The user has had enough broken attempts (v1.15.3 used
// FolderBrowserDialog which hides drives under a collapsed
// "This PC"; v1.15.4 added UTF-8 but the dialog still
// didn't show drives; v1.15.5 cast IFileOpenDialog and
// failed; v1.15.6 used [Activator]::CreateInstance with
// the CLSID and PowerShell returned the raw IUnknown with
// no methods exposed). The approach below is the one
// that works without any new Rust dependency, using only
// what PowerShell ships with.
//
// We use Shell.Application.BrowseForFolder — the Windows
// Shell COM object. It exposes its methods directly to
// PowerShell (no .NET cast needed) and accepts a
// `RootFolder` argument as a CSIDL. Passing CSIDL_DRIVES
// (0x11, "My Computer" / "This PC") makes the dialog
// open with the drive list visible — C:, D:, E:, etc.
// are all shown immediately, no clicking-around required.
//
// BIF_USENEWUI (0x50) opts into the newer Windows Vista+
// dialog style (larger, with an editable path field).
// BIF_RETURNONLYFSDIRS (0x01) prevents the user from
// selecting virtual folders (Libraries, Control Panel).
//
// Encoding: same v1.15.4 fix. Set $OutputEncoding +
// [Console]::OutputEncoding to UTF-8 before the dialog
// so non-ASCII paths (e.g. C:\用户\桌面) survive the
// round-trip to Rust. Win PS 5.1 default is the system
// code page (GBK on zh-CN systems).

use std::process::Command;

const PS_SCRIPT: &str = r#"
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# Shell.Application.BrowseForFolder(hwnd, title, options, rootFolder)
#   hwnd        = 0 (no owner window — we don't have the
#                       Tauri webview HWND handy)
#   title       = dialog title
#   options     = BIF_RETURNONLYFSDIRS (0x01) |
#                BIF_USENEWUI       (0x50) = 0x51
#   rootFolder  = CSIDL_DRIVES (0x11) = "This PC" —
#                makes the drive list visible from the
#                start instead of hidden behind a
#                collapsed subtree.
$shell  = New-Object -ComObject Shell.Application
$folder = $shell.BrowseForFolder(0, "Open folder (workspace)", 0x51, 0x11)
if ($folder -eq $null) {
    # User cancelled.
    return
}
# $folder.Self.Path gives the absolute filesystem path.
$path = $folder.Self.Path
Write-Output ([System.IO.Path]::GetFullPath($path)).TrimEnd()
"#;

#[tauri::command]
pub async fn pick_folder() -> Result<Option<String>, String> {
    let output = tokio::task::spawn_blocking(|| {
        Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", PS_SCRIPT])
            .output()
    })
    .await
    .map_err(|e| format!("worker task panicked: {e}"))?
    .map_err(|e| format!("powershell spawn failed: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        eprintln!(
            "[pick_folder] powershell exit={:?} stderr={}",
            output.status.code(),
            stderr.trim()
        );
        return Err(format!(
            "powershell exited with code {:?}: {}",
            output.status.code(),
            stderr.trim()
        ));
    }

    // Strict UTF-8 with a logged lossy fallback. The PS
    // script sets OutputEncoding = UTF-8 before the
    // dialog, so a real failure here would be a system
    // misconfig (e.g. PowerShell 7 defaulting differently).
    let raw = output.stdout;
    let trimmed = if let Ok(s) = String::from_utf8(raw.clone()) {
        s.trim().to_string()
    } else {
        eprintln!(
            "[pick_folder] stdout not valid UTF-8 ({} bytes), falling back to lossy",
            raw.len()
        );
        String::from_utf8_lossy(&raw).trim().to_string()
    };

    if trimmed.is_empty() {
        Ok(None)
    } else {
        Ok(Some(trimmed))
    }
}
