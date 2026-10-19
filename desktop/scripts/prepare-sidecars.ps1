# Trylo Desktop — prepare all sidecars for packaging. See migration spec §9.1.
#
# Run before `cargo tauri build` (wire into the release pipeline / beforeBuild).
# Steps:
#   1. npm ci in desktop-services (independent package) + esbuild the Service
#      Host into a single file dist/host.bundle.mjs (ws/qrcode inlined;
#      vendor/legacy copied alongside as files, not bundled).
#   2. dotnet publish the WPF pet (self-contained win-x64).
#   3. Copy artifacts into src-tauri/resources/ so tauri.conf.json's
#      `bundle.resources` globs resolve at build time.
#      - resources/desktop-services/**    (dist bundle + vendor/legacy)
#      - resources/sidecars/desktop-companion/publish/**
#      - resources/sidecars/hermes-capabilities/**
#
# Requires (system PATH): node ≥22, esbuild (devDependency of desktop-services),
# and dotnet ≥9. HERMES python stays on the user's side (uv / HERMES_PYTHON).

param([switch]$IncludeWorkd)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot 'release-file-hash.ps1')

$repoRoot = Resolve-Path "$PSScriptRoot\..\.."
$ds = Join-Path $repoRoot "desktop-services"
$sidecars = Join-Path $repoRoot "desktop\sidecars"
$srcTauri = Join-Path $repoRoot "desktop\src-tauri"
$resources = Join-Path $srcTauri "resources"
if (-not ([IO.Path]::GetFullPath($resources)).StartsWith(([IO.Path]::GetFullPath($repoRoot) + "\"), [StringComparison]::OrdinalIgnoreCase)) { throw "resources escape repository" }
if ((Test-Path -LiteralPath $resources) -and ((Get-Item -LiteralPath $resources).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "resources must not be redirected" }
New-Item -ItemType Directory -Force -Path $resources | Out-Null
node (Join-Path $repoRoot "scripts\release\check-source-completeness.mjs")
if ($LASTEXITCODE -ne 0) { throw "source completeness validation failed" }
$dsRoot = Join-Path $resources "desktop-services"
$dsDist = Join-Path $dsRoot "dist"
$sidecarPub = Join-Path $resources "sidecars"
$backupRoot = Join-Path $repoRoot ".local-release\sidecar-backups"
New-Item -ItemType Directory -Force -Path $backupRoot | Out-Null
Copy-Item -LiteralPath (Join-Path $repoRoot "desktop\distribution.json") -Destination (Join-Path $resources "distribution.json") -Force

Write-Host "prepare-sidecars: npm ci + build service host bundle"
Push-Location $ds
try {
  npm ci --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw "npm ci failed (exit $LASTEXITCODE)" }
  # esbuild logs build diagnostics to stderr; under $ErrorActionPreference=Stop
  # that native stderr aborts the script. Capture stderr, check the exit code,
  # and only fail if the build actually errored.
  # Windows PowerShell promotes any native stderr line to an ErrorRecord when
  # the global preference is Stop. esbuild writes its successful summary to
  # stderr, so scope the relaxed preference to this one native invocation and
  # restore it immediately afterwards.
  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $esbuildOut = & npx esbuild src/host.mjs `
      --bundle --platform=node --format=esm --target=node22 `
      --banner:js="import { createRequire as createNodeRequire } from 'node:module'; const require = createNodeRequire(import.meta.url);" `
      --outfile=dist/host.bundle.mjs 2>&1
    $esbuildExitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
  if ($esbuildExitCode -ne 0) { throw "esbuild failed (exit $esbuildExitCode):$("`n" + ($esbuildOut -join "`n"))" }
  node scripts/validate-tool-bridge.mjs --require-local-builds --bundle
  if ($LASTEXITCODE -ne 0) { throw "tool bridge validation failed (exit $LASTEXITCODE)" }
} finally {
  Pop-Location
}

Write-Host "prepare-sidecars: publish desktop pet (self-contained)"
& (Join-Path $repoRoot "desktop\scripts\build-desktop-pet.ps1") -ProjectDir (Join-Path $sidecars "desktop-companion") -SelfContained
if ($LASTEXITCODE -ne 0) { throw "build-desktop-pet failed" }

# Pin a Node runtime into the bundle (audit §2.3 Task W4). The INSTALLED app
# must never depend on `node` being on the user's system PATH — an end user
# has no Node, and a missing interpreter used to surface as a bare spawn
# ENOENT with no reason code.
#
# Staged from the build machine's Node unless TRYLO_NODE_RUNTIME_DIR points
# at a pinned download. The path shape matches
# `node_runtime_candidates()` in desktop/src-tauri/src/commands/node_runtime.rs.
Write-Host "prepare-sidecars: pin the Node runtime"
$nodeRuntimeDir = if ($env:TRYLO_NODE_RUNTIME_DIR) {
  $env:TRYLO_NODE_RUNTIME_DIR
} else {
  $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
  if ($nodeCommand) { Split-Path -Parent $nodeCommand.Source } else { $null }
}
$nodeExe = if ($nodeRuntimeDir) { Join-Path $nodeRuntimeDir "node.exe" } else { $null }
if (-not $nodeExe -or -not (Test-Path -LiteralPath $nodeExe)) {
  throw @"
prepare-sidecars: no Node runtime to pin.
  Pass TRYLO_NODE_RUNTIME_DIR=<dir containing node.exe>, or put node on PATH.
  The installed app must not depend on a system Node (audit §2.3 Task W4).
"@
}
$nodeVersion = & $nodeExe --version
if ($LASTEXITCODE -ne 0) { throw "prepare-sidecars: $nodeExe --version failed" }
if ($nodeVersion -ne 'v24.14.1' -or (Get-ReleaseFileHash $nodeExe) -ne '58e74bf02fc5bbacc41dcb8bef089961cd5bddd37830b87784e4fc624d145d1f') { throw 'Stage the pinned Node v24.14.1 win-x64 runtime.' }
$nodeTargetDir = Join-Path $resources "runtime\node\win-x64"
New-Item -ItemType Directory -Force -Path $nodeTargetDir | Out-Null
Copy-Item -LiteralPath $nodeExe -Destination (Join-Path $nodeTargetDir "node.exe") -Force
$runtimeLicenses = Join-Path $resources 'runtime/licenses'
New-Item -ItemType Directory -Force -Path $runtimeLicenses | Out-Null
Copy-Item -LiteralPath (Join-Path $repoRoot 'desktop/licenses/NODE-v24.14.1-LICENSE.txt') -Destination (Join-Path $runtimeLicenses 'NODE-LICENSE.txt') -Force
Copy-Item -LiteralPath (Join-Path $repoRoot 'desktop/licenses/TRYLO-LICENSE.txt') -Destination (Join-Path $runtimeLicenses 'TRYLO-LICENSE.txt') -Force
Write-Host "prepare-sidecars: pinned node $nodeVersion -> $nodeTargetDir\node.exe"


# CoWork is no longer a dependency of ordinary Work. Only stage it explicitly
# when producing the separate experimental dependency archive.
if ($IncludeWorkd) {
  Write-Host "prepare-sidecars: build the managed-work sidecar (audit P0-C §5.2)"
  # Stages resources/workd = built dist/daemon + production node_modules
  # closure + better-sqlite3 probe under the pinned Node ABI. The probe and
  # the inventory below are the release gate: the installed app must run the
  # real daemon with NO npm/build/rebuild on the user machine.
  if ($env:TRYLO_WORKD_ARTIFACT_DIR) {
    node (Join-Path $PSScriptRoot "stage-workd-artifact.mjs")
    if ($LASTEXITCODE -ne 0) { throw "stage-workd-artifact failed (exit $LASTEXITCODE)" }
  } else {
    node (Join-Path $repoRoot "desktop\scripts\build-workd-sidecar.mjs") --rebuild
    if ($LASTEXITCODE -ne 0) { throw "build-workd-sidecar failed (exit $LASTEXITCODE)" }
  }

  # Prune into a fresh candidate; keep the original artifact outside bundle.resources.
  $slimId = [Guid]::NewGuid().ToString("N")
  $workCandidate = Join-Path $resources "workd-slim-$slimId"
  $workTarget = Join-Path $resources "workd"
  node (Join-Path $PSScriptRoot "slim-workd-artifact.mjs") --source $workTarget --output $workCandidate
  if ($LASTEXITCODE -ne 0) { throw "Work artifact pruning failed" }
  $backupRoot = Join-Path $repoRoot ".local-release\sidecar-backups"
  New-Item -ItemType Directory -Force -Path $backupRoot | Out-Null
  $workBackup = Join-Path $backupRoot "workd-$slimId"
  Move-Item -LiteralPath $workTarget -Destination $workBackup
  try { Move-Item -LiteralPath $workCandidate -Destination $workTarget }
  catch {
    if (-not (Test-Path -LiteralPath $workTarget)) { Move-Item -LiteralPath $workBackup -Destination $workTarget }
    throw
  }

  Write-Host "prepare-sidecars: probe pruned Work native/document dependencies"
  & (Join-Path $nodeTargetDir "node.exe") (Join-Path $PSScriptRoot "verify-workd-package.mjs") $workTarget
  if ($LASTEXITCODE -ne 0) { throw "Work package runtime probes failed" }

} else {
  Write-Host "prepare-sidecars: CoWork excluded from core; ordinary Work uses CLI"
}

Write-Host "prepare-sidecars: copy into src-tauri/resources/"
# The optional Work wrapper is staged only for the separate dependency.
$targets = @(
  @{ src = "$ds\dist";               dst = "$dsDist" },
  @{ src = "$ds\vendor";             dst = "$dsRoot\vendor" },
  # ws is required by the vendored remote-gateway at RUNTIME (it loads via
  # createRequire from vendor/legacy, NOT through the esbuild bundle), so it
  # must ship alongside the vendor tree. ws@8.21.0 has zero runtime deps —
  # the single package folder is sufficient (spec §9.1 / §3.3).
  @{ src = "$ds\node_modules\ws";    dst = "$dsRoot\node_modules\ws" },
  # Windows-MCP fork source (tool-package-manager.syncWindowsMcpFork). The
  # pinned transport installs the UPSTREAM tarball for the dependency set;
  # this tree is then overlaid onto the installed src/windows_mcp so a
  # packaged app gets the Trylo fork surface (14 tools incl. Ocr) instead
  # of the 12-tool upstream one. The bundled host resolves it as the
  # `windows-mcp-fork` sibling of dist/host.bundle.mjs.
  @{ src = "$repoRoot\new_tool\computer-control\Windows-MCP\src\windows_mcp"; dst = "$dsRoot\windows-mcp-fork" },
  @{ src = "$sidecars\desktop-companion\publish"; dst = "$sidecarPub\desktop-companion\publish" },
  @{ src = "$sidecars\hermes-capabilities";      dst = "$sidecarPub\hermes-capabilities" }
)
if ($IncludeWorkd) {
  $targets += @{ src = (Join-Path $repoRoot "work\bin"); dst = "$resources\work\bin" }
}
foreach ($t in $targets) {
  if (-not (Test-Path $t.src)) { throw "prepare-sidecars: missing source $($t.src)" }
  # A compressed pet publish must not merge with stale loose .NET runtime DLLs.
  $petDestination = Join-Path $sidecarPub "desktop-companion\publish"
  if ($t.dst -eq $petDestination -and (Test-Path -LiteralPath $t.dst)) {
    $fullDestination = [IO.Path]::GetFullPath($t.dst)
    if (-not $fullDestination.StartsWith(([IO.Path]::GetFullPath($resources) + "\"), [StringComparison]::OrdinalIgnoreCase)) { throw "Pet destination escapes resources" }
    if ((Get-Item -LiteralPath $t.dst).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Redirected pet destination" }
    $petBackup = Join-Path $backupRoot ("pet-stage-" + [Guid]::NewGuid().ToString("N"))
    Move-Item -LiteralPath $t.dst -Destination $petBackup
  }
  New-Item -ItemType Directory -Force -Path $t.dst | Out-Null
  Copy-Item -Recurse -Force "$($t.src)\*" $t.dst
}

# Legacy .js adapters are CommonJS even when resources are staged below the
# desktop package's type=module boundary. The entry bundle remains explicit .mjs.
Set-Content -LiteralPath (Join-Path $dsRoot "package.json") -Value '{"private":true,"type":"commonjs"}' -Encoding utf8

# Python bytecode is machine/version-specific build residue, not a runtime
# source artifact. Never let a developer's __pycache__ leak into the bundle.
$hermesResourceDir = Join-Path $sidecarPub "hermes-capabilities"
$hermesCacheDir = Join-Path $hermesResourceDir "__pycache__"
if (Test-Path -LiteralPath $hermesCacheDir) {
  Remove-Item -LiteralPath $hermesCacheDir -Recurse -Force
}
Get-ChildItem -LiteralPath $hermesResourceDir -File -Filter "*.pyc" -ErrorAction SilentlyContinue |
  Remove-Item -Force
# Same residue rule for the staged Windows-MCP fork (__pycache__ lives at
# every depth under src/windows_mcp on a developed checkout).
$forkResourceDir = Join-Path $dsRoot "windows-mcp-fork"
Get-ChildItem -LiteralPath $forkResourceDir -Recurse -Directory -Filter "__pycache__" -ErrorAction SilentlyContinue |
  Remove-Item -Recurse -Force
Get-ChildItem -LiteralPath $forkResourceDir -Recurse -File -Filter "*.pyc" -ErrorAction SilentlyContinue |
  Remove-Item -Force

Write-Host "prepare-sidecars: stage and probe the new CLI"
node (Join-Path $PSScriptRoot "stage-cli.mjs")
if ($LASTEXITCODE -ne 0) { throw "stage-cli failed (exit $LASTEXITCODE)" }

# Verify what actually landed in resources/ (audit §3.2 W4: a copy that
# silently produced an incomplete tree used to reach `tauri build` and only
# surface as "the pet does not appear"). The inventory hard-fails on any
# missing REQUIRED artifact, so this is the release gate, not a log line.
# TRYLO_SIDECARS_DIR is cleared: the inventory must resolve against the
# packaged resources, never a developer's checkout.
Write-Host "prepare-sidecars: stage the pinned WGC capture helper (spec §19.8)"
# The .NET helper is a pinned native artifact (WCC-P2-05): built by
# `dotnet publish` in the Windows-MCP checkout, staged NEXT TO the bundled
# service host, and digest-verified by release-inventory.mjs below against
# the manifest's pinned value. A missing or drifted helper is a release
# failure — the capture path never downloads or substitutes one at runtime.
$wgcSource = Join-Path $repoRoot "new_tool\computer-control\Windows-MCP\native\wgc-helper\bin\Release\net8.0-windows10.0.19041.0\win-x64\publish"
$wgcTarget = Join-Path $dsRoot "wgc-helper"
if (-not (Test-Path (Join-Path $wgcSource "trylo-wgc-helper.exe"))) {
  throw @"
prepare-sidecars: trylo-wgc-helper.exe not found at $wgcSource
  Build it first: dotnet publish new_tool/computer-control/Windows-MCP/native/wgc-helper/TryloWgcHelper.csproj -c Release -r win-x64 --self-contained -p:PublishSingleFile=true
"@
}
New-Item -ItemType Directory -Force -Path $wgcTarget | Out-Null
Copy-Item -Force (Join-Path $wgcSource "trylo-wgc-helper.exe") $wgcTarget
Write-Host "prepare-sidecars: staged WGC helper -> $wgcTarget"

$licenseDirectory = Join-Path $dsRoot "licenses"
New-Item -ItemType Directory -Force -Path $licenseDirectory | Out-Null
Copy-Item -LiteralPath (Join-Path $repoRoot "new_tool/computer-control/Windows-MCP/LICENSE.md") -Destination (Join-Path $licenseDirectory "Windows-MCP-LICENSE.md") -Force
Copy-Item -LiteralPath (Join-Path $repoRoot "new_tool/computer-control/Windows-MCP/PROVENANCE.json") -Destination (Join-Path $licenseDirectory "Windows-MCP-PROVENANCE.json") -Force
& (Join-Path $PSScriptRoot "stage-wgc-notices.ps1") -ProjectDirectory (Join-Path $repoRoot "new_tool/computer-control/Windows-MCP/native/wgc-helper") -Destination (Join-Path $licenseDirectory "wgc-dotnet")

Write-Host "prepare-sidecars: verify resource inventory"
& (Join-Path $PSScriptRoot "prepare-runtime-integrity.ps1") -RuntimeRoot $resources
if ($LASTEXITCODE -ne 0) { throw "Runtime integrity preparation failed" }
$env:TRYLO_RESOURCE_DIR = $resources
$env:TRYLO_SIDECARS_DIR = ""
Push-Location $ds
try {
  $priorIncludeWorkd = $env:TRYLO_INCLUDE_WORKD
  $env:TRYLO_INCLUDE_WORKD = if ($IncludeWorkd) { "1" } else { "0" }
  try { node scripts/release-inventory.mjs } finally { $env:TRYLO_INCLUDE_WORKD = $priorIncludeWorkd }
  if ($LASTEXITCODE -ne 0) {
    throw "release-inventory failed against $resources (exit $LASTEXITCODE)"
  }
  node scripts/verify-remote-runtime.mjs $resources
  if ($LASTEXITCODE -ne 0) {
    throw "Remote runtime verification failed against $resources (exit $LASTEXITCODE)"
  }
} finally {
  Pop-Location
  Remove-Item Env:\TRYLO_RESOURCE_DIR -ErrorAction SilentlyContinue
  Remove-Item Env:\TRYLO_SIDECARS_DIR -ErrorAction SilentlyContinue
}

Write-Host "prepare-sidecars: OK"
Write-Host "  resources: $resources"
Write-Host "  service host bundle: $dsDist\host.bundle.mjs"
