// Trylo Desktop Services — Windows-MCP tool package manifest (pinned).
//
// Spec TRYLO-CORE-AGENT-TOOL-EXTENSION-TECHNICAL-SPEC §3 / §6.6 / §8.2 / §10.3.
//
// Static data only — see manifests/officecli.mjs for the invariants.
//
// Mounted by default since 2026-09-06 (办公基底 work.core.v1 + CAD
// profile). Enforcement is per-action, not per-mount (spec §6.6: screen
// leases, bypass-immune approvals) — mounting only makes the tools
// visible, it never auto-allows their sensitive actions.
//
// The 14/7 tool split is the audited disposition of the upstream surface
// (20 tools) plus one fork-added tool (`Ocr`, 21 total). The 7 excluded
// tools stay excluded even under `unrestricted` — the Profile cannot
// re-enable what the server allowlist removed (spec §6.6), and the host
// router additionally denies any tool outside `expectedTools` on a
// managed server.
//
// PR-6 pinned surface (verified 2026-09-01 against THIS revision; extended
// 2026-09-04 by the CAD-workflow optimization round):
//   - upstream v0.8.5 (pyproject) at commit 83e17f622597dd5b10a09fa34ffe0b868
//     6dbc7eb; the GitHub source tarball is pinned by SHA256 below and the
//     dependency set is pinned by the tarball's `uv.lock` (digest of the
//     LF-normalised file — the same bytes the GitHub tarball ships);
//   - Trylo maintains a LOCAL FORK of `src/windows_mcp` at
//     `new_tool/computer-control/Windows-MCP` (same upstream commit plus
//     CAD-workflow fixes: focused-mode Type, modifier clicks, press/hold +
//     release for every button, double-click timing for right/middle,
//     wheel-delta granularity, window pre-focus, IME detection, live
//     dialog-item fallback, Windows-Media-Ocr `Ocr` tool). The pinned
//     transport downloads the upstream tarball (digest chain unchanged)
//     and then OVERWRITES `src/windows_mcp` with the fork tree
//     (`syncWindowsMcpFork` in tool-package-manager.mjs) — the fork is
//     the source of truth for code, the tarball for the dependency set;
//   - a real stdio `initialize` + `tools/list` smoke of the pinned build
//     with the 14-tool `--tools` allowlist returned EXACTLY these 14 tool
//     names (fork-side `tests/test_stdio_handshake.py` pins the same);
//   - `Clipboard` was moved out of the excluded set by user request: the
//     agent needs clipboard set/get to paste long command sequences into
//     CAD-grade apps. It is classified HIGH-IMPACT (per-call approval,
//     never leased) in the Trylo classifier;
//   - `Ocr` is a fork-ADDED capture tool (screen-text reading), classified
//     with the screen-read class;
//   - telemetry is refused at the argv/env layer: `ANONYMIZED_TELEMETRY=false`
//     keeps upstream's PostHog client from ever being constructed (verified in
//     the pinned source: `__main__.py` lifespan gate).

/** The 14 tools Trylo exposes on Work surfaces carrying windows-mcp (spec §6.6). */
export const WINDOWS_MCP_ALLOWED_TOOLS = Object.freeze([
  'Screenshot',
  'Snapshot',
  'DisplayInventory',
  'Click',
  'Type',
  'Scroll',
  'Move',
  'Shortcut',
  'Wait',
  'WaitFor',
  'App',
  'MultiSelect',
  'Clipboard',
  'Ocr',
]);

/** The 7 tools Trylo never exposes (spec §6.6). */
export const WINDOWS_MCP_DENIED_TOOLS = Object.freeze([
  'PowerShell',
  'FileSystem',
  'Scrape',
  'Process',
  'Registry',
  'MultiEdit',
  'Notification',
]);

/** `--tools` argv value — comma-joined, consumed verbatim by the pinned CLI. */
export const WINDOWS_MCP_TOOLS_ARG = WINDOWS_MCP_ALLOWED_TOOLS.join(',');

/** Upstream commit the tarball digest below vouches for. */
export const WINDOWS_MCP_SOURCE_COMMIT = '83e17f622597dd5b10a09fa34ffe0b8686dbc7eb';

export const WINDOWS_MCP_MANIFEST = Object.freeze({
  schemaVersion: 1,
  id: 'windows-mcp',
  displayName: 'Windows-MCP',
  version: '0.8.5',
  adoption: 'trial',

  source: Object.freeze({
    repository: 'https://github.com/CursorTouch/Windows-MCP',
    license: 'MIT',
    releaseUrl: `https://github.com/CursorTouch/Windows-MCP/archive/${WINDOWS_MCP_SOURCE_COMMIT}.tar.gz`,
  }),

  artifact: Object.freeze({
    platform: 'win32-x64',
    // SHA256 of the pinned GitHub source tarball (verified before extraction).
    archiveSha256: 'f1228ff567cb373312fcefc49923cd1ee1214e78fd21a48f1815df3817aacc69',
    // uv console script inside the transport-managed .venv.
    executableRelativePath: '.venv/Scripts/windows-mcp.exe',
    installStrategy: 'pinned-python-env',
    // The pinned source tarball the transport downloads (same digest as
    // archiveSha256 — the trust boundary for the whole install).
    downloadUrl: `https://github.com/CursorTouch/Windows-MCP/archive/${WINDOWS_MCP_SOURCE_COMMIT}.tar.gz`,
    // The dependency set `uv sync --locked` materialises. Digest of the
    // LF-normalised uv.lock inside the pinned tarball.
    uvLockSha256: '18e34869b0ca1cfaac23eee385dfa0ac78a48897297c5c4a6a4c2cfe847c55bb',
    sourceCommit: WINDOWS_MCP_SOURCE_COMMIT,
    // PyPI distribution name the python-metadata health probe reads
    // (importlib.metadata) — distinct from the MCP server name.
    pythonPackage: 'windows-mcp',
  }),

  // WCC-P2-05 (spec §19.8): the .NET WGC capture helper is a pinned native
  // artifact in its own right. It never ships by download — it is staged
  // from the build machine's `dotnet publish` output into the packaged
  // resources tree (prepare-sidecars.ps1) and verified by the release
  // inventory against the digests below. The runtime (WgcProvider /
  // windows-mcp-fork) refuses an artifact whose digest differs; a helper
  // that cannot be verified is simply ABSENT (the capture path degrades to
  // the honest legacy status, never a silent native fallback).
  //
  // Pinned build: net8.0-windows10.0.19041.0, win-x64, single-file
  // self-contained publish (dotnet publish -r win-x64 --self-contained
  // -p:PublishSingleFile=true). sourceTree points at the monorepo checkout
  // the digest was recorded from (same tree the fork overlay ships from).
  helper: Object.freeze({
    kind: 'dotnet-single-file',
    protocolVersion: 1,
    executableRelativePath: 'trylo-wgc-helper.exe',
    // Staging layout, tried in order by the provider's lookup chain:
    //  1. packaged — `<serviceRoot>/wgc-helper/trylo-wgc-helper.exe`
    //     (prepare-sidecars.ps1 stages it next to the bundled host);
    //  2. dev/CI — `<windows-mcp checkout>/native/wgc-helper/bin/Release/
    //     net8.0-windows10.0.19041.0/win-x64/publish/`.
    packagedDirName: 'wgc-helper',
    sha256: '240c8132cafd4e694841a6b4847973abb9bc4ccf5d728a601e4028ae07d235cb',
    sizeBytes: 42067483,
    sourceTree: 'new_tool/computer-control/Windows-MCP/native/wgc-helper',
  }),

  mcp: Object.freeze({
    serverName: 'trylo-windows',
    transport: 'stdio',
    // The allowlist AND the telemetry kill switch are part of the server
    // argv/env — never a Trylo-side filter that could drift (spec §6.6).
    args: Object.freeze([
      'serve',
      '--transport',
      'stdio',
      '--tools',
      WINDOWS_MCP_TOOLS_ARG,
    ]),
    env: Object.freeze({ ANONYMIZED_TELEMETRY: 'false' }),
    // EXACT tool set of the pinned build under this allowlist, recorded from
    // a real stdio tools/list smoke (PR-6, 2026-09-01). A drift is degraded,
    // never silently accepted (§3).
    expectedTools: WINDOWS_MCP_ALLOWED_TOOLS,
  }),

  activation: 'explicit-computer',
  classifierId: 'windows-mcp',
  // The uv console script answers `--version` with a usage banner, not a
  // version — the honest probe is the project metadata of the installed
  // distribution inside the venv.
  healthCheck: 'python-metadata',
  telemetry: 'forced-off',
  uninstall: 'remove-version-directory',
});

export default WINDOWS_MCP_MANIFEST;
