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
function Invoke-BackgroundNative([string]$Executable, [string]$NativeArguments) {
    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $Executable
    $startInfo.Arguments = $NativeArguments
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    try {
        if (-not $process.Start()) { throw 'Could not start bundled runtime preparation.' }
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(15000)) {
            $process.Kill()
            [void]$process.WaitForExit(2000)
            throw 'Bundled runtime preparation timed out.'
        }
        return [pscustomobject]@{
            ExitCode = $process.ExitCode
            Output = $stdout.GetAwaiter().GetResult()
            Error = $stderr.GetAwaiter().GetResult()
        }
    } finally {
        $process.Dispose()
    }
}
# Match authority the user already selected for this launcher. An ordinary
# launch stays Medium; an explicitly elevated launch must not downgrade its
# Node/tools back to Medium. This never requests or grants an elevated token.
# Administrator group membership alone does not identify the token's actual IL.
$token = Invoke-BackgroundNative "$env:SystemRoot\System32\whoami.exe" '/groups /fo csv'
if ($token.ExitCode -ne 0 -or $token.Output -notmatch 'S-1-16-(\d+)') { throw 'Could not determine the portable launcher integrity level.' }
$integrityRid = [int]$Matches[1]
if ($integrityRid -lt 8192) { throw 'The portable launcher is running at Low integrity. Extract into a normal user directory or use the installer.' }
$integrity = if ($integrityRid -ge 12288) { 'H' } else { 'M' }
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
    # Hide every native descendant as well as the PowerShell host. Suppressing
    # output alone does not prevent Windows from allocating a console window.
    $result = Invoke-BackgroundNative "$env:SystemRoot\System32\icacls.exe" ('"' + $file + '" /setintegritylevel ' + $integrity)
    if ($result.ExitCode -ne 0) { throw ("Could not prepare bundled runtime integrity: " + $result.Error.Trim()) }
}
Write-Output "Prepared $($executables.Count) bundled executables at the launcher's existing integrity level."
if (-not $PrepareOnly) { Start-Process -FilePath (Join-Path $root 'trylo-desktop.exe') -WorkingDirectory $root }
