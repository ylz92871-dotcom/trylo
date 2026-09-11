# Trylo Desktop — build the WPF desktop pet sidecar.
# See desktop/sidecars/desktop-companion + migration spec §6.1.
#
# Publishes TryloDesktopPet for win-x64 (self-contained so the user does not
# need to install .NET 9). Output lands in
#   desktop/sidecars/desktop-companion/publish/  (the path the legacy bridge
#   resolves via its `extensionPath` + relative `desktop-companion/publish/`).
#
# Dev/debug: pass -SelfContained $false to publish a framework-dependent build
# relying on a locally installed .NET runtime.
#
# Requires: dotnet SDK ≥ 9. Run from the repo root (or pass -ProjectDir).

param(
  [string]$ProjectDir = "$PSScriptRoot\..\sidecars\desktop-companion",
  [switch]$SelfContained = $true
)

$ErrorActionPreference = "Stop"
$csproj = Join-Path (Resolve-Path $ProjectDir) "TryloDesktopPet.csproj"
if (-not (Test-Path $csproj)) {
  throw "csproj not found: $csproj (expected at desktop/sidecars/desktop-companion/TryloDesktopPet.csproj)"
}

$outDir = Join-Path (Split-Path $csproj -Parent) "publish"
$sc = if ($SelfContained) { $true } else { $false }

Write-Host "build-desktop-pet: publishing TryloDesktopPet (self-contained=$sc) -> $outDir"

dotnet publish $csproj `
  -c Release `
  -r win-x64 `
  --self-contained $sc `
  -o $outDir
if ($LASTEXITCODE -ne 0) { throw "dotnet publish failed (exit $LASTEXITCODE)" }

$exe = Join-Path $outDir "TryloDesktopPet.exe"
if (-not (Test-Path $exe)) { throw "publish completed but TryloDesktopPet.exe missing at $exe" }
Write-Host "build-desktop-pet: OK -> $exe"