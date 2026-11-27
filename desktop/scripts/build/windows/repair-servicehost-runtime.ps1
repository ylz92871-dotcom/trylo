[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$DesktopDirectory)

$ErrorActionPreference = 'Stop'
$desktopRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$sourceRoot = Join-Path $desktopRoot 'src-tauri/resources'
$targetRoot = (Resolve-Path -LiteralPath $DesktopDirectory).Path
$executable = Join-Path $targetRoot 'trylo-desktop.exe'
if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) {
  throw 'DesktopDirectory must contain trylo-desktop.exe.'
}
if ($targetRoot -eq (Resolve-Path -LiteralPath $sourceRoot).Path) { throw 'Source and destination must differ.' }

# A standalone EXE does not contain the Node service. Stage beside it,
# matching app.path().resource_dir() on Windows. No files are deleted.
foreach ($name in @('desktop-services', 'runtime', 'sidecars')) {
  $source = Join-Path $sourceRoot $name
  $target = Join-Path $targetRoot $name
  if (-not (Test-Path -LiteralPath $source -PathType Container)) { throw "Missing resource: $name" }
  & robocopy.exe $source $target /E /R:1 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "Could not stage $name (robocopy $LASTEXITCODE)." }
}

function Get-Sha256([string]$Path) {
  $stream = [System.IO.File]::OpenRead($Path)
  $hash = [System.Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($hash.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
  finally { $hash.Dispose(); $stream.Dispose() }
}
$entries = foreach ($relative in @('desktop-services/dist/host.bundle.mjs', 'runtime/node/win-x64/node.exe', 'desktop-services/vendor/legacy/remote-gateway/index.js')) {
  $source = Join-Path $sourceRoot $relative
  $target = Join-Path $targetRoot $relative
  if (-not (Test-Path -LiteralPath $target -PathType Leaf)) { throw "Missing staged file: $relative" }
  $hash = Get-Sha256 $target
  if ($hash -ne (Get-Sha256 $source)) { throw "Staged file differs: $relative" }
  [pscustomobject]@{ path = $relative; sha256 = $hash }
}
$manifest = [pscustomobject]@{ executableSha256 = (Get-Sha256 $executable); files = @($entries) }
$manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $targetRoot 'servicehost-runtime-manifest.json') -Encoding UTF8
Write-Host 'Service Host runtime staged and checked. Re-enable remote access in Desktop to retry startup.'
