// Trylo Desktop Services — Playwright MCP tool package manifest (pinned).
//
// Spec TRYLO-CORE-AGENT-TOOL-EXTENSION-TECHNICAL-SPEC §3 / §8.2 / §10.2.
//
// Static data only — see manifests/officecli.mjs for the invariants.
//
// PR-3 pinned surface (verified against THIS build's `--help` and a real
// stdio `tools/list` smoke of the tarballs pinned below, 2026-09-01):
//   - `--caps core` does NOT exist in 0.0.79 (caps are vision/pdf/devtools;
//     the default cap set IS the "core" surface §10.2 describes), so no
//     --caps flag is sent (§10.2: 「具体参数必须以锁定版本的 --help 为准」);
//   - the CLI is a .js entry executed by the Node runtime the sidecar
//     already runs under (`artifact.runner: 'node'`) — never `npx@latest`
//     (§8.2);
//   - `{runtimeDir}` expands per-run to
//     `<projectRoot>/.trylo/runtime/browser/<conversationId>`
//     (`runtimeDirName: 'browser'`), the §8.2 outputDir contract: downloads
//     and screenshots land in a Trylo-controlled temp area and only reach
//     `.trylo/out` through the Artifact Promoter;
//   - the whole runtime closure (@playwright/mcp + playwright +
//     playwright-core) is pinned by registry tarball + SHA256. All three
//     packages exact-pin their own deps, so no floating resolution exists.
//
// Origin policy (§8.2): empty allowed/blocked lists mean the server default
// (allow all requests). The host risk classifier owns every navigation
// decision (§6.5) — the origin flags are a server-side convenience filter,
// NOT a security boundary.

export const PLAYWRIGHT_MANIFEST = Object.freeze({
  schemaVersion: 1,
  id: 'playwright',
  displayName: 'Playwright MCP',
  version: '0.0.79',
  adoption: 'stable',

  source: Object.freeze({
    repository: 'https://github.com/microsoft/playwright-mcp',
    license: 'Apache-2.0',
    releaseUrl: 'https://www.npmjs.com/package/@playwright/mcp',
  }),

  artifact: Object.freeze({
    platform: 'win32-x64',
    // SHA256 of the pinned @playwright/mcp registry tarball (the entry
    // package). Verified at install before anything is placed.
    archiveSha256:
      'c35077b88e070b57b15db0040991289eeaf19bccbd397a41898f28654a1d33ee',
    executableRelativePath: 'node_modules/@playwright/mcp/cli.js',
    installStrategy: 'pinned-npm',
    // The entry is a .js script: the host runs it under the Node runtime
    // the Service Host itself uses, never via npx (§8.2).
    runner: 'node',
    // The npm package name — also the node_modules directory the transport
    // extracts the verified tarball into (scoped names included verbatim).
    packageName: '@playwright/mcp',
    downloadUrl: 'https://registry.npmjs.org/@playwright/mcp/-/mcp-0.0.79.tgz',
    // The exact runtime closure, each pinned by tarball + digest. Extracted
    // into node_modules/<name> alongside the entry package.
    npmDependencies: Object.freeze([
      Object.freeze({
        name: 'playwright',
        tarballUrl:
          'https://registry.npmjs.org/playwright/-/playwright-1.63.0-alpha-2026-08-05.tgz',
        sha256:
          '9773b64c75611e334b7fee196f6559468e1fd8252a18f8966f97d74e4c4b1d96',
      }),
      Object.freeze({
        name: 'playwright-core',
        tarballUrl:
          'https://registry.npmjs.org/playwright-core/-/playwright-core-1.63.0-alpha-2026-08-05.tgz',
        sha256:
          '774c5addbf5772c42ebeabebe3b380d3f47fc4e3e9f6b94508317147a947122b',
      }),
    ]),
  }),

  mcp: Object.freeze({
    serverName: 'trylo-browser',
    transport: 'stdio',
    // §10.2 pinned launch: isolated profile (no reuse of the user's daily
    // login state) + per-conversation outputDir via the {runtimeDir}
    // placeholder. No --caps: the default surface of 0.0.79 IS the core set.
    args: Object.freeze(['--isolated', '--output-dir', '{runtimeDir}']),
    env: Object.freeze({}),
    // EXACT tool set of the pinned build, recorded from a real stdio
    // tools/list smoke (PR-3, 2026-09-01). A tools/list drift is degraded,
    // never silently accepted (§3).
    expectedTools: Object.freeze([
      'browser_snapshot',
      'browser_click',
      'browser_navigate',
      'browser_navigate_back',
      'browser_console_messages',
      'browser_network_requests',
      'browser_network_request',
      'browser_take_screenshot',
      'browser_evaluate',
      'browser_run_code_unsafe',
      'browser_tabs',
      'browser_wait_for',
      'browser_find',
      'browser_press_key',
      'browser_type',
      'browser_fill_form',
      'browser_select_option',
      'browser_hover',
      'browser_drag',
      'browser_drop',
      'browser_file_upload',
      'browser_handle_dialog',
      'browser_resize',
      'browser_close',
    ]),
    // §8.2 origin configuration. Empty = server default (allow all). The
    // classifier treats blocked origins as deny and a non-empty allow list
    // as prompt-for-anything-outside; neither is a sandbox.
    allowedOrigins: Object.freeze([]),
    blockedOrigins: Object.freeze([]),
  }),

  // §8.2 outputDir contract: `.trylo/runtime/browser/<conversationId>`.
  // The profile service expands {runtimeDir} with this name instead of the
  // package id, so the runtime dir matches the spec's documented layout.
  runtimeDirName: 'browser',

  activation: 'work-default',
  classifierId: 'playwright',
  healthCheck: 'version-handshake',
  // §3.3-7: the package alone is NOT "fully available" — navigation needs the
  // Chromium body in the shared ms-playwright cache. The health service runs
  // the browser condition probe and degrades the record when it is absent;
  // `tooling.installBrowser` materialises it from the pinned playwright CLI.
  browserCondition: Object.freeze({ kind: 'playwright-chromium' }),
  telemetry: 'none',
  uninstall: 'remove-version-directory',
});

export default PLAYWRIGHT_MANIFEST;
