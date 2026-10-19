# Build the self-contained compressed WPF companion in a fresh candidate tree.
# Assets stay external: PetWindow/CatBoxWindow load them via AppContext.BaseDirectory.
# Previous output is retained outside bundle.resources; stale runtime DLLs never merge.
param(
  [string]$ProjectDir = "$PSScriptRoot\..\sidecars\desktop-companion",
  [switch]$SelfContained = $true,
  [string]$OutputDir = ""
)
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot 'release-file-hash.ps1')
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
$projectRoot = (Resolve-Path -LiteralPath $ProjectDir).Path
$csproj = Join-Path $projectRoot "TryloDesktopPet.csproj"
if (-not (Test-Path -LiteralPath $csproj)) { throw "Missing project: $csproj" }
$outDir = if ($OutputDir) { [IO.Path]::GetFullPath($OutputDir) } else { Join-Path $projectRoot "publish" }
if (-not $outDir.StartsWith($repoRoot + "\", [StringComparison]::OrdinalIgnoreCase)) { throw "Publish output must stay inside this checkout" }
if ((Test-Path -LiteralPath $outDir) -and ((Get-Item -LiteralPath $outDir).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "Redirected publish output" }
$id = [Guid]::NewGuid().ToString("N")
$candidate = "$outDir-candidate-$id"
$backup = Join-Path $repoRoot ".local-release\sidecar-backups\pet-$id"
$sc = if ($SelfContained) { "true" } else { "false" }
Write-Host "build-desktop-pet: fresh publish (self-contained=$sc) -> $candidate"
# PowerShell 5 treats successful native diagnostics on stderr as errors under Stop.
$previousPreference = $ErrorActionPreference
$ErrorActionPreference = "Continue"
try {
  & dotnet publish $csproj -c Release -r win-x64 --self-contained $sc -o $candidate
  $publishExit = $LASTEXITCODE
} finally { $ErrorActionPreference = $previousPreference }
if ($publishExit -ne 0) { throw "dotnet publish failed (exit $publishExit); candidate retained" }
if (-not (Test-Path -LiteralPath (Join-Path $candidate "TryloDesktopPet.exe"))) { throw "Published executable missing" }
# Gate the exact external image tree, including the atlas and cat-box backgrounds.
$assetsRoot = Join-Path $projectRoot "assets"
foreach ($asset in (Get-ChildItem -LiteralPath $assetsRoot -Recurse -File -Filter "*.png")) {
  $relative = $asset.FullName.Substring($projectRoot.Length + 1)
  $copy = Join-Path $candidate $relative
  if (-not (Test-Path -LiteralPath $copy)) { throw "External pet asset missing: $relative" }
  if ((Get-ReleaseFileHash $copy) -ne (Get-ReleaseFileHash $asset.FullName)) { throw "External pet asset changed: $relative" }
}
if ($SelfContained -and (Test-Path -LiteralPath (Join-Path $candidate "System.Private.CoreLib.dll"))) { throw "Expected compressed single-file publish" }
if ($SelfContained) {
  $assets = Get-Content -LiteralPath (Join-Path $projectRoot "obj\project.assets.json") -Raw | ConvertFrom-Json
  [xml]$projectXml = Get-Content -LiteralPath $csproj -Raw
  $tfm = [string]$projectXml.Project.PropertyGroup.TargetFramework
  $runtimeConfig = Get-Content -LiteralPath (Join-Path $projectRoot "bin\Release\$tfm\win-x64\TryloDesktopPet.runtimeconfig.json") -Raw | ConvertFrom-Json
  $licenseDir = Join-Path $candidate "licenses\dotnet"
  New-Item -ItemType Directory -Force -Path $licenseDir | Out-Null
  foreach ($framework in $runtimeConfig.runtimeOptions.includedFrameworks) {
    $package = ($framework.name.ToLowerInvariant() + ".runtime.win-x64")
    $runtimePack = $null
    foreach ($folder in $assets.packageFolders.PSObject.Properties.Name) {
      $pack = Join-Path $folder "$package\$($framework.version)"
      if (Test-Path -LiteralPath $pack) { $runtimePack = $pack; break }
    }
    if (-not $runtimePack) { throw "Runtime license input missing: $package $($framework.version)" }
    $foundLicense = $false
    foreach ($name in @("LICENSE", "LICENSE.TXT", "THIRD-PARTY-NOTICES.TXT")) {
      $notice = Join-Path $runtimePack $name
      if (Test-Path -LiteralPath $notice) {
        Copy-Item -LiteralPath $notice -Destination (Join-Path $licenseDir "$($framework.name)-$name")
        if ($name -like "LICENSE*") { $foundLicense = $true }
      }
    }
    if (-not $foundLicense) { throw "Runtime license missing: $package" }
  }
}
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $backup) | Out-Null
if (Test-Path -LiteralPath $outDir) { Move-Item -LiteralPath $outDir -Destination $backup }
try { Move-Item -LiteralPath $candidate -Destination $outDir }
catch {
  if ((Test-Path -LiteralPath $backup) -and -not (Test-Path -LiteralPath $outDir)) { Move-Item -LiteralPath $backup -Destination $outDir }
  throw
}
Write-Host "build-desktop-pet: OK -> $outDir"
