param(
    [Parameter(Mandatory = $true)][string]$BuildDirectory,
    [ValidateSet('M', 'H')][string]$IntegrityLevel = 'M'
)

$ErrorActionPreference = 'Stop'
$checkout = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../../..')).TrimEnd('\')
$buildPath = [IO.Path]::GetFullPath($BuildDirectory).TrimEnd('\')
$profileDirectory = [IO.Directory]::GetParent($buildPath)
if (-not $buildPath.StartsWith($checkout + '\', [StringComparison]::OrdinalIgnoreCase) -or
    [IO.Path]::GetFileName($buildPath) -ne 'build' -or $profileDirectory.Name -ne 'debug' -or
    $profileDirectory.Parent.Name -ne 'target') {
    throw 'Expected a Cargo target/debug/build directory inside this checkout.'
}

# Validate ancestors and cached build-script paths before changing labels.
# Cargo may retain two names for the same generated build-script executable.
$ancestor = $buildPath
while ($ancestor -ne $checkout) {
    if (Test-Path -LiteralPath $ancestor) {
        $entry = Get-Item -LiteralPath $ancestor -Force
        if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Redirected Cargo build path.' }
    }
    $ancestor = [IO.Path]::GetDirectoryName($ancestor)
}
[IO.Directory]::CreateDirectory($buildPath) | Out-Null
$pending = [Collections.Generic.Queue[IO.DirectoryInfo]]::new()
$pending.Enqueue((Get-Item -LiteralPath $buildPath))
$scripts = [Collections.Generic.List[string]]::new()
while ($pending.Count) {
    foreach ($entry in $pending.Dequeue().GetFileSystemInfos()) {
        if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Redirected Cargo build entry.' }
        if ($entry -is [IO.DirectoryInfo]) { $pending.Enqueue($entry) }
        elseif ($entry.Name -eq 'build-script-build.exe' -or $entry.Name -like 'build_script_build-*.exe') {
            $scripts.Add($entry.FullName)
        }
    }
}

$icacls = Join-Path $env:SystemRoot 'System32/icacls.exe'
function Set-BuildLabel([string]$Path, [string]$Label) {
    & $icacls $Path /setintegritylevel $Label | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Cargo build integrity preparation failed: $Path" }
}

# Startup prepares runtime copies at M/H. The build script that overwrites
# them must not inherit Low from the checkout. Cover both Cargo's cached
# executables and future fingerprints/recompiles, without changing any DACL.
Set-BuildLabel $buildPath "(OI)(CI)$IntegrityLevel"
foreach ($script in $scripts) { Set-BuildLabel $script $IntegrityLevel }
Write-Output "Prepared $($scripts.Count) Cargo build-script executables at integrity ($IntegrityLevel)."
