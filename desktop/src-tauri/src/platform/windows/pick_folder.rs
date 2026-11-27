//! Windows folder selection through Shell COM, with UTF-8 output.
//! BrowseForFolder exposes drives and editable paths without extra dependencies.

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

pub(crate) async fn pick_folder() -> Result<Option<String>, String> {
    let output = tokio::task::spawn_blocking(|| {
        crate::platform::background_command("powershell")
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
