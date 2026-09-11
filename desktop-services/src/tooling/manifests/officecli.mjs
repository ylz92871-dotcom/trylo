// Trylo Desktop Services — OfficeCLI tool package manifest (pinned).
//
// Spec TRYLO-CORE-AGENT-TOOL-EXTENSION-TECHNICAL-SPEC §3 / §10.1.
//
// This file is STATIC DATA ONLY. It never performs I/O, never spawns a
// process and never reads the network. `command` is deliberately absent:
// the Tool Package Manager resolves it as
// `<installRoot>/<id>/<version>/<executableRelativePath>` (spec §3:
// 「command 不写进仓库 manifest，而由安装目录 + executableRelativePath 解析」).
//
// Hard rules encoded here:
//   - `version` is pinned; `latest` is forbidden (spec §16.4).
//   - `archiveSha256` is the release asset digest, verified at install.
//   - `expectedTools` is an EXACT set — a tools/list drift is `degraded`,
//     never a silent compatibility shim (spec §3).
//   - env holds no user secret (spec §3: runtime keys are injected apart).

export const OFFICECLI_MANIFEST = Object.freeze({
  schemaVersion: 1,
  id: 'officecli',
  displayName: 'OfficeCLI',
  version: '1.0.145',
  adoption: 'trial',

  source: Object.freeze({
    repository: 'https://github.com/iOfficeAI/OfficeCLI',
    license: 'SEE-LICENSE-FILE',
    releaseUrl: 'https://github.com/iOfficeAI/OfficeCLI/releases/tag/v1.0.145',
  }),

  artifact: Object.freeze({
    platform: 'win32-x64',
    // SHA256 of the pinned release asset. Recorded in full (the execution
    // log's earlier `760696b2…8` was a truncation of this value).
    archiveSha256:
      '760696b262f3d6bd2cd174577220d54541b6e1e04ec58dee051f1897395638b8',
    executableRelativePath: 'officecli-win-x64.exe',
    installStrategy: 'release-archive',
    // PR-2: the direct, pinned release-asset URL for the network transport
    // (spec §8.2 从固定 GitHub release 下载). https-only, enforced by the
    // catalog validator; `latest`-style floating URLs are unrepresentable
    // here because the version + digest are pinned alongside it.
    downloadUrl:
      'https://github.com/iOfficeAI/OfficeCLI/releases/download/v1.0.145/officecli-win-x64.exe',
  }),

  mcp: Object.freeze({
    serverName: 'trylo-office',
    transport: 'stdio',
    args: Object.freeze(['mcp']),
    env: Object.freeze({}),
    // Official OfficeCLI MCP exposes exactly ONE tool; `command` inside the
    // tool input routes create/view/get/query/set/add/remove/move/validate
    // /batch/raw/merge/help (spec §5.1).
    expectedTools: Object.freeze(['officecli']),
  }),

  activation: 'work-default',
  classifierId: 'officecli',
  healthCheck: 'version-handshake',
  telemetry: 'forced-off',
  uninstall: 'remove-version-directory',
});

export default OFFICECLI_MANIFEST;
