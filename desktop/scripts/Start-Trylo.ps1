param([switch]$PrepareOnly)
$ErrorActionPreference = 'Stop'
# Shipped beside the portable executable. Repair only known bundled copies;
# no administrator request, registry change, external tool or DACL change.
$root = (Get-Item -LiteralPath $PSScriptRoot).FullName
if ((Get-Item -LiteralPath $root).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Redirected portable root.' }
$manifest = Join-Path $root 'distribution.json'
if (-not (Test-Path -LiteralPath $manifest -PathType Leaf)) { throw 'Extract the complete Trylo portable archive first.' }
$profile = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
if ($profile.product -ne 'Trylo Desktop' -or $profile.distribution -ne 'core') { throw 'Invalid Trylo distribution.' }
$principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
# Match authority the user already selected for this launcher. An ordinary
# launch stays Medium; an explicitly elevated launch must not downgrade its
# Node/tools back to Medium. This never requests or grants an elevated token.
$integrity = if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { 'H' } else { 'M' }
$executables = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
foreach ($relative in @('trylo-desktop.exe', 'runtime/node/win-x64/node.exe',
    'sidecars/desktop-companion/publish/TryloDesktopPet.exe', 'desktop-services/wgc-helper/trylo-wgc-helper.exe')) {
    $file = Get-Item -LiteralPath (Join-Path $root $relative)
    $ancestor = $file
    while ($ancestor -and $ancestor.FullName -ne $root) {
        if ($ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Redirected bundled runtime.' }
        $ancestor = if ($ancestor -is [IO.FileInfo]) { $ancestor.Directory } else { $ancestor.Parent }
    }
    [void]$executables.Add($file.FullName)
}
# PTY/SRT, ripgrep and other nested helpers are child processes too. Validate
# every owned component before changing any label; never follow reparse points
# into user installations, tool caches or developer dependency junctions.
$pending = [Collections.Generic.Queue[IO.DirectoryInfo]]::new()
foreach ($relative in @('runtime', 'cli', 'cli-legacy', 'desktop-services', 'sidecars')) {
    $component = Join-Path $root $relative
    if (Test-Path -LiteralPath $component) { $pending.Enqueue((Get-Item -LiteralPath $component)) }
}
while ($pending.Count) {
    $directory = $pending.Dequeue()
    if ($directory.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Redirected bundled component.' }
    foreach ($entry in $directory.GetFileSystemInfos()) {
        if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Redirected bundled runtime entry.' }
        if ($entry -is [IO.DirectoryInfo]) { $pending.Enqueue($entry) }
        elseif ($entry.Extension -ieq '.exe') { [void]$executables.Add($entry.FullName) }
    }
}
foreach ($file in $executables) {
    & "$env:SystemRoot\System32\icacls.exe" $file /setintegritylevel $integrity | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not prepare bundled runtime integrity. Use the installer in a normal user directory.' }
}
Write-Output "Prepared $($executables.Count) bundled executables at the launcher's existing integrity level."
if (-not $PrepareOnly) { Start-Process -FilePath (Join-Path $root 'trylo-desktop.exe') -WorkingDirectory $root }
