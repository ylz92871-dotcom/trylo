param(
    [Parameter(Mandatory = $true)]
    [string]$ExecutablePath,
    [ValidateSet('L', 'M', 'H')]
    [string]$IntegrityLevel = 'M'
)

$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'This preparation step is Windows-only.' }

$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../../..')).TrimEnd('\')
$executable = Get-Item -LiteralPath $ExecutablePath
if ($executable.PSIsContainer -or $executable.Extension -ne '.exe') {
    throw 'Expected a built Desktop executable.'
}
if (-not $executable.FullName.StartsWith($repositoryRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'The executable must be inside this checkout.'
}
if ($executable.Name -notmatch '^(trylo-desktop|Trylo-Focus-Desktop)\.exe$') {
    throw 'Only the Desktop development executables are supported.'
}
$ancestor = $executable
while ($ancestor -and $ancestor.FullName -ne $repositoryRoot) {
    if ($ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw 'Refusing an executable path through a reparse point.'
    }
    $ancestor = if ($ancestor -is [IO.FileInfo]) { $ancestor.Directory } else { $ancestor.Parent }
}

# A Low-labelled checkout produces Low processes; MSYS cannot initialize its
# named objects there. Change only the finished executable's label, not its DACL.
# Medium is the default. High is explicit; Low is only for reverting a preview.
& icacls.exe $executable.FullName /setintegritylevel $IntegrityLevel | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Executable preparation failed: $LASTEXITCODE" }
Write-Output "Prepared Desktop executable at integrity ($IntegrityLevel): $($executable.FullName)"
