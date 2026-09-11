// Trylo Desktop Services — Chrome DevTools MCP tool package manifest (pinned).
//
// Spec TRYLO-CORE-AGENT-TOOL-EXTENSION-TECHNICAL-SPEC §3 / §4.1 / §8.2.
// PR-7 (work.browser-debug.v1): Playwright is REPLACED — never co-resident —
// by Chrome DevTools MCP for explicit browser-debugging tasks (§4.1).
//
// Static data only — see manifests/officecli.mjs for the invariants.
//
// PR-7 pinned surface (verified 2026-09-02 against THIS build):
//   - upstream chrome-devtools-mcp 1.8.0 (npm latest at pin time). The
//     published tarball is a SELF-CONTAINED rollup bundle: package.json
//     declares ZERO dependencies, so the entire runtime closure is the one
//     pinned tarball and its digest is the whole trust chain (§8.2 —
//     nothing can float; `npmDependencies: []` encodes "bundled");
//   - a real stdio `initialize` + `tools/list` smoke returned EXACTLY the
//     29 tool names pinned below (default categories: emulation /
//     performance / network on; extensions / pwa / third-party off);
//   - the entry is a .js script executed by the Node runtime the sidecar
//     already runs under (`artifact.runner: 'node'`) — never `npx@latest`;
//   - telemetry: upstream usage statistics default ON ("Google collects
//     usage data…"). The pinned source gates on
//     `CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS` — set in env below. The
//     separate performance CrUX egress ("may send trace URLs to the CrUX
//     API") is disabled via `--no-performance-crux` in argv (§16.8:
//     数据出域最小化);
//   - browser: puppeteer-core drives the SYSTEM Chrome stable channel —
//     no browser download step exists, and the browser binary is NOT in
//     the Trylo digest chain (same posture as PR-3 偏差② for playwright).
//     `--isolated` keeps the profile out of the user's daily login state.
//
// File-write contract (verified in the pinned build, McpContext#validatePath):
// when the MCP client does not negotiate `roots` (the Trylo CLI does not),
// every explicit `filePath` write is restricted to the OS temp directory.
// Writes are therefore OUTSIDE `.trylo/out` and the per-conversation
// runtime dir — see the classifier's file-write rules and the recorded
// deviation (CDP process results are not promoter-reachable in v1).

/** The 29 tools the pinned build exposes under the default categories
 *  (recorded from a real stdio tools/list smoke, PR-7 2026-09-02). */
export const CHROME_DEVTOOLS_ALLOWED_TOOLS = Object.freeze([
  'list_pages',
  'select_page',
  'new_page',
  'close_page',
  'navigate_page',
  'wait_for',
  'take_snapshot',
  'take_screenshot',
  'evaluate_script',
  'get_console_message',
  'list_console_messages',
  'get_network_request',
  'list_network_requests',
  'performance_start_trace',
  'performance_stop_trace',
  'performance_analyze_insight',
  'lighthouse_audit',
  'take_heapsnapshot',
  'click',
  'drag',
  'hover',
  'fill',
  'fill_form',
  'press_key',
  'type_text',
  'handle_dialog',
  'upload_file',
  'resize_page',
  'emulate',
]);

export const CHROME_DEVTOOLS_MANIFEST = Object.freeze({
  schemaVersion: 1,
  id: 'chrome-devtools',
  displayName: 'Chrome DevTools MCP',
  version: '1.8.0',
  adoption: 'trial',

  source: Object.freeze({
    repository: 'https://github.com/ChromeDevTools/chrome-devtools-mcp',
    license: 'Apache-2.0',
    releaseUrl: 'https://www.npmjs.com/package/chrome-devtools-mcp',
  }),

  artifact: Object.freeze({
    platform: 'win32-x64',
    // SHA256 of the pinned registry tarball. The tarball is the ENTIRE
    // runtime closure (zero-dependency bundle) — this digest is the whole
    // trust boundary, verified at install before anything is placed.
    archiveSha256:
      'ac0334410cea75d11a5ebb555fbb0139a4a394de35d98cc2a3bc0a959f004cdd',
    // The entry script inside the placed package layout: the pinned-npm
    // transport extracts the entry tarball into
    // node_modules/<packageName>/ (same layout contract as playwright).
    executableRelativePath: 'node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js',
    installStrategy: 'pinned-npm',
    // The entry is a .js script: the host runs it under the Node runtime
    // the Service Host itself uses, never via npx (§8.2).
    runner: 'node',
    packageName: 'chrome-devtools-mcp',
    downloadUrl:
      'https://registry.npmjs.org/chrome-devtools-mcp/-/chrome-devtools-mcp-1.8.0.tgz',
    // Bundled closure: the tarball ships everything (puppeteer-core et al.
    // are rolled into build/src). Empty array = nothing to pin beside the
    // entry; the catalog validator accepts this deliberately.
    npmDependencies: Object.freeze([]),
  }),

  mcp: Object.freeze({
    serverName: 'trylo-chrome',
    transport: 'stdio',
    // --isolated: temp user-data-dir, auto-cleaned — never the user's daily
    // profile (§8.2 playwright parity). --no-performance-crux: performance
    // tools must not send trace URLs to the Google CrUX API (§16.8).
    args: Object.freeze(['--isolated', '--no-performance-crux']),
    env: Object.freeze({ CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: 'true' }),
    // EXACT tool set of the pinned build, recorded from a real stdio
    // tools/list smoke (PR-7, 2026-09-02). A drift is degraded, never
    // silently accepted (§3).
    expectedTools: CHROME_DEVTOOLS_ALLOWED_TOOLS,
    // NOTE (do not add lists blindly): this server's origin flags are
    // --allowedUrlPattern / --blockedUrlPattern (URL patterns, NOT origins).
    // The profile service forwards playwright-style origin flag names, so a
    // CDP manifest must NOT declare allowedOrigins/blockedOrigins until the
    // forwarding is generalized. Empty-by-absence = server default; the host
    // risk classifier owns every navigation decision either way (§6.5).
  }),

  // §4.1: work.browser-debug.v1 is an explicit debug-task Profile the USER
  // switches on — the model can never pull it into a default Profile.
  activation: 'on-demand',
  classifierId: 'chrome-devtools',
  healthCheck: 'version-handshake',
  telemetry: 'forced-off',
  uninstall: 'remove-version-directory',
});

export default CHROME_DEVTOOLS_MANIFEST;
