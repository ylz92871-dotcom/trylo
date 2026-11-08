param(
    [Parameter(Mandatory = $true)][string]$ExecutablePath,
    [ValidateSet('M', 'H')][string]$IntegrityLevel = 'M'
)

$ErrorActionPreference = 'Stop'
$checkout = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..')).TrimEnd('\')
$executable = Get-Item -LiteralPath $ExecutablePath
if ($executable.PSIsContainer -or $executable.Name -notin @('trylo-desktop.exe', 'Trylo-Focus-Desktop.exe') -or
    -not $executable.FullName.StartsWith($checkout + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Expected a Desktop development executable inside this checkout.'
}
$prepare = Join-Path $PSScriptRoot 'prepare-runtime-integrity.ps1'
$buildRoot = $executable.Directory.FullName
# These are product resources, never Cargo deps/build output or external tools.
foreach ($relative in @('runtime', 'cli', 'desktop-services', 'sidecars')) {
    $component = Join-Path $buildRoot $relative
    if (Test-Path -LiteralPath $component) {
        & $prepare -RuntimeRoot $component -IntegrityLevel $IntegrityLevel
    }
}
# The development CLI comes from the checkout, not the staged resource copy.
# Keep its terminal worker consistent too, after ensureDevelopmentCli rebuilds.
$debugExecutable = Join-Path $checkout 'desktop/src-tauri/target/debug/trylo-desktop.exe'
if ($executable.FullName -ieq [IO.Path]::GetFullPath($debugExecutable)) {
    # The source Service Host resolves the same shipped core tools as a
    # packaged host. Match the developer's existing M/H launch choice.
    $builtinTools = Join-Path $checkout 'desktop/src-tauri/resources/desktop-services/builtin-tools'
    if (Test-Path -LiteralPath $builtinTools) { & $prepare -RuntimeRoot $builtinTools -IntegrityLevel $IntegrityLevel }
    $pty = Join-Path $checkout 'new trylo cli/dist/internal/vendor/pty'
    if (Test-Path -LiteralPath $pty) { & $prepare -RuntimeRoot $pty -IntegrityLevel $IntegrityLevel }
    # Match the native sidecar resolver's source fallback when no staged copy exists.
    if (-not (Test-Path -LiteralPath (Join-Path $buildRoot 'sidecars'))) {
        $sidecars = Join-Path $checkout 'desktop/sidecars'
        if (Test-Path -LiteralPath $sidecars) { & $prepare -RuntimeRoot $sidecars -IntegrityLevel $IntegrityLevel }
    }
}
# Preview conversion has no interactive input authority and uses normal caches.
$media = Join-Path $buildRoot 'preview/media'
if (Test-Path -LiteralPath $media) { & $prepare -RuntimeRoot $media }
