param([Parameter(Mandatory = $true)][string]$RuntimeRoot)

$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'Runtime preparation is Windows-only.' }
$checkout = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..')).TrimEnd('\')
$root = Get-Item -LiteralPath $RuntimeRoot -Force
if (-not $root.PSIsContainer -or -not $root.FullName.StartsWith($checkout + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'The staged runtime must be a directory inside this checkout.'
}

# Validate the entire traversal before changing anything. Never follow a
# junction into developer installations or change their security descriptors.
$pending = [Collections.Generic.Queue[IO.DirectoryInfo]]::new()
$pending.Enqueue($root)
$executables = [Collections.Generic.List[string]]::new()
while ($pending.Count) {
    $directory = $pending.Dequeue()
    if ($directory.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Redirected runtime directory.' }
    foreach ($entry in $directory.GetFileSystemInfos()) {
        if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Redirected runtime entry.' }
        if ($entry -is [IO.DirectoryInfo]) { $pending.Enqueue($entry) }
        elseif ($entry.Extension -ieq '.exe') { $executables.Add($entry.FullName) }
    }
}
if (-not $executables.Count) { throw 'No executable in the staged runtime.' }
foreach ($file in $executables) {
    # An inherited Low label on a build directory caps child processes even
    # when Desktop is High. Set an explicit Medium label on release copies.
    # This changes no DACL, never requests elevation, and never selects High.
    & "$env:SystemRoot\System32\icacls.exe" $file /setintegritylevel M | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Runtime integrity preparation failed: $file" }
}
Write-Output "Prepared $($executables.Count) staged executables at Medium integrity."
