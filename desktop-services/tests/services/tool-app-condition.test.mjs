// Trylo Desktop Services — host-application condition tests (CAD/EDA).
//
// Pins the honest two-state answer for packages that automate a HOST
// APPLICATION (TRYLO-CAD-EDA-TOOL-ADAPTER spec §5):
//   - `executable-glob` finds a complete install (executable marker present)
//     under well-known roots with ${ENV} expansion and per-segment wildcards;
//   - `com-progid` answers from a read-only HKCR registry read (the injected
//     fake stands in for reg.exe) — a registered ProgID or an fs marker
//     fallback, NEVER a COM object construction that would launch the app;
//   - `app-bridge` requires BOTH layers: install markers AND a live bridge
//     port, with distinct reasonCodes for「未安装」vs「未启动桥」;
//   - unknown/malformed conditions fail CLOSED;
//   - the health service degrades an installed package whose host app is
//     missing to condition-missing, carrying the manifest's Chinese
//     remediation;
//   - `work.cad.v1` composes only the packages whose host apps are present.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  expandRoots,
  probeAppBridge,
  probeAppCondition,
  probeComProgId,
  probeExecutableGlob,
} from '../../src/tooling/tool-app-condition.mjs';
import { createToolingServices } from '../../src/tooling/index.mjs';
import { TOOL_PROFILES } from '../../src/tooling/tool-profile-service.mjs';

const SAVED = {
  TRYLO_APP_DATA_DIR: process.env.TRYLO_APP_DATA_DIR,
  TRYLO_SIDECARS_DIR: process.env.TRYLO_SIDECARS_DIR,
  TRYLO_CAD_TEST_ROOT: process.env.TRYLO_CAD_TEST_ROOT,
};

let tmpRoot = '';

function mkdirp(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

function writeExe(p) {
  mkdirp(path.dirname(p));
  fs.writeFileSync(p, 'pe');
}

/** A minimal VALID manifest (release-archive) carrying an installCondition. */
function fakeCadManifest({ id, serverName, installCondition }) {
  return Object.freeze({
    schemaVersion: 1,
    id,
    displayName: id,
    version: '1.0.0',
    adoption: 'trial',
    activation: 'explicit-computer',
    classifierId: id,
    source: Object.freeze({
      repository: 'https://example.invalid/trylo/cad-test',
      license: 'MIT',
    }),
    artifact: Object.freeze({
      platform: 'win32-x64',
      installStrategy: 'release-archive',
      executableRelativePath: 'entry.js',
    }),
    mcp: Object.freeze({
      serverName,
      transport: 'stdio',
      args: Object.freeze([]),
      expectedTools: Object.freeze(['probe']),
    }),
    ...(installCondition ? { installCondition } : {}),
  });
}

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'trylo-app-cond-'));
  // A synthetic "Program Files" the ${ENV} templates point at.
  process.env.TRYLO_CAD_TEST_ROOT = path.join(tmpRoot, 'pf');
  mkdirp(process.env.TRYLO_CAD_TEST_ROOT);
  // KiCad: <root>/KiCad/9.0/bin/kicad-cli.exe
  writeExe(path.join(process.env.TRYLO_CAD_TEST_ROOT, 'KiCad', '9.0', 'bin', 'kicad-cli.exe'));
  // FreeCAD: <root>/FreeCAD 1.0/bin/FreeCAD.exe
  writeExe(path.join(process.env.TRYLO_CAD_TEST_ROOT, 'FreeCAD 1.0', 'bin', 'FreeCAD.exe'));
  // An INCOMPLETE KiCad build (dir exists, exe absent — a cancelled install).
  mkdirp(path.join(tmpRoot, 'pf-empty', 'KiCad', '10.0', 'bin'));
  process.env.TRYLO_APP_DATA_DIR = tmpRoot;
  process.env.TRYLO_SIDECARS_DIR = tmpRoot;
});

after(() => {
  for (const [key, value] of Object.entries(SAVED)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

describe('expandRoots', () => {
  it('expands ${ENV} placeholders and drops missing variables', () => {
    const roots = expandRoots(
      ['${TRYLO_CAD_TEST_ROOT}', '${TRYLO_DEFINITELY_UNSET_VAR}\\x', 'C:\\literal'],
      { TRYLO_CAD_TEST_ROOT: process.env.TRYLO_CAD_TEST_ROOT },
    );
    assert.deepEqual(roots, [process.env.TRYLO_CAD_TEST_ROOT, 'C:\\literal']);
  });
});

describe('probeExecutableGlob', () => {
  const kicadCondition = {
    kind: 'executable-glob',
    label: 'KiCad',
    roots: ['${TRYLO_CAD_TEST_ROOT}'],
    markers: ['KiCad/*/bin/kicad-cli.exe'],
  };

  it('finds a complete install through a wildcard version segment', () => {
    const result = probeExecutableGlob(kicadCondition);
    assert.equal(result.ok, true);
    assert.equal(result.reasonCode, 'app_ok');
    assert.ok(result.found.endsWith(path.join('KiCad', '9.0', 'bin', 'kicad-cli.exe')));
  });

  it('misses an INCOMPLETE install (dir exists, executable marker absent)', () => {
    const result = probeExecutableGlob(
      {
        kind: 'executable-glob',
        roots: ['${TRYLO_CAD_TEST_ROOT}'],
        markers: ['KiCad/*/bin/kicad-cli.exe'],
        label: 'KiCad',
      },
      { env: { TRYLO_CAD_TEST_ROOT: path.join(tmpRoot, 'pf-empty') } },
    );
    assert.equal(result.ok, false);
    assert.equal(result.reasonCode, 'app_not_installed');
  });

  it('misses when none of the roots exist', () => {
    const result = probeExecutableGlob(
      {
        kind: 'executable-glob',
        roots: ['${TRYLO_DEFINITELY_UNSET_VAR}\\KiCad'],
        markers: ['*/kicad-cli.exe'],
      },
      { env: {} },
    );
    assert.equal(result.ok, false);
    assert.equal(result.reasonCode, 'app_not_installed');
  });

  it('reports the newest-looking candidate deterministically', () => {
    writeExe(path.join(process.env.TRYLO_CAD_TEST_ROOT, 'KiCad', '10.0', 'bin', 'kicad-cli.exe'));
    const result = probeExecutableGlob(kicadCondition);
    assert.ok(result.found.includes('10.0'), `expected 10.0 first, got ${result.found}`);
  });
});

describe('probeComProgId', () => {
  const condition = {
    kind: 'com-progid',
    progid: 'SldWorks.Application',
    label: 'SolidWorks',
    roots: ['${TRYLO_CAD_TEST_ROOT}'],
    markers: ['SOLIDWORKS Corp/*/SOLIDWORKS.exe'],
  };

  it('answers ok from the registry read alone (no fs touch)', async () => {
    const probes = [];
    const result = await probeComProgId(condition, {
      regQuery: async (key) => {
        probes.push(key);
        return true;
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.reasonCode, 'app_ok');
    assert.deepEqual(probes, ['HKCR\\SldWorks.Application']);
  });

  it('falls back to the fs marker for a portable install', async () => {
    writeExe(path.join(process.env.TRYLO_CAD_TEST_ROOT, 'SOLIDWORKS Corp', '2024', 'SOLIDWORKS.exe'));
    const result = await probeComProgId(condition, { regQuery: async () => false });
    assert.equal(result.ok, true);
    assert.ok(result.found.includes('SOLIDWORKS.exe'));
  });

  it('degrades to app_not_installed when both layers miss', async () => {
    const result = await probeComProgId(
      {
        kind: 'com-progid',
        progid: 'AutoCAD.Application',
        label: 'AutoCAD',
        roots: ['${TRYLO_DEFINITELY_UNSET_VAR}'],
        markers: ['Autodesk/*/acad.exe'],
      },
      { regQuery: async () => false, env: {} },
    );
    assert.equal(result.ok, false);
    assert.equal(result.reasonCode, 'app_not_installed');
  });

  it('never throws — a failing registry read reads as not installed', async () => {
    const result = await probeComProgId(
      { kind: 'com-progid', progid: 'AutoCAD.Application', label: 'AutoCAD' },
      {
        regQuery: async () => {
          throw new Error('reg exploded');
        },
      },
    );
    assert.equal(result.ok, false);
    assert.equal(result.reasonCode, 'app_not_installed');
  });
});

describe('probeAppBridge', () => {
  const jlcedaCondition = {
    kind: 'app-bridge',
    label: '嘉立创EDA专业版',
    roots: ['${TRYLO_CAD_TEST_ROOT}'],
    markers: ['lceda-pro/lceda-pro.exe'],
    bridge: Object.freeze({ host: '127.0.0.1', from: 49620, to: 49629 }),
  };

  before(() => {
    writeExe(path.join(process.env.TRYLO_CAD_TEST_ROOT, 'lceda-pro', 'lceda-pro.exe'));
  });

  it('reports app_not_installed (NOT bridge_not_running) when the app is absent', async () => {
    const result = await probeAppBridge(
      {
        kind: 'app-bridge',
        label: 'X',
        roots: ['${TRYLO_DEFINITELY_UNSET_VAR}'],
        markers: ['x/x.exe'],
        bridge: { from: 1, to: 2 },
      },
      { tcpProbe: async () => true, env: {} },
    );
    assert.equal(result.ok, false);
    assert.equal(result.reasonCode, 'app_not_installed');
  });

  it('reports bridge_not_running when installed but no port answers', async () => {
    const result = await probeAppBridge(jlcedaCondition, { tcpProbe: async () => false });
    assert.equal(result.ok, false);
    assert.equal(result.reasonCode, 'bridge_not_running');
    assert.ok(result.detail.includes('49620'));
  });

  it('sweeps the range and answers ok at a mid-range port', async () => {
    const seen = [];
    const result = await probeAppBridge(jlcedaCondition, {
      tcpProbe: async (_host, port) => {
        seen.push(port);
        return port === 49625;
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.found, '127.0.0.1:49625');
    assert.deepEqual(seen, [49620, 49621, 49622, 49623, 49624, 49625]);
  });

  it('refuses a degenerate port range (fail closed)', async () => {
    const result = await probeAppBridge(
      { kind: 'app-bridge', roots: ['${TRYLO_CAD_TEST_ROOT}'], markers: ['lceda-pro/lceda-pro.exe'], bridge: { from: 70000, to: 70001 } },
      { tcpProbe: async () => true },
    );
    assert.equal(result.ok, false);
    assert.equal(result.reasonCode, 'bridge_not_running');
  });
});

describe('probeAppCondition dispatch', () => {
  it('fails CLOSED on an unknown kind', async () => {
    const result = await probeAppCondition({ kind: 'telepathy' });
    assert.equal(result.ok, false);
    assert.equal(result.reasonCode, 'condition_unsupported');
  });

  it('fails CLOSED on a missing condition', async () => {
    const result = await probeAppCondition(undefined);
    assert.equal(result.ok, false);
    assert.equal(result.reasonCode, 'condition_invalid');
  });
});

describe('health integration: CAD package without its host application', () => {
  const fakeExe = path.join(tmpRoot, 'pkg-root', 'kicad', 'entry.js');

  before(() => {
    writeExe(fakeExe);
  });

  function build(seam = {}) {
    return createToolingServices({
      appDataDir: tmpRoot,
      sidecarsDir: tmpRoot,
      seam: {
        installRoot: path.join(tmpRoot, 'tool-packages'),
        profilesRoot: path.join(tmpRoot, 'tool-profiles'),
        overrides: { 'kicad-mcp': fakeExe },
        manifests: [
          fakeCadManifest({
            id: 'kicad-mcp',
            serverName: 'trylo-kicad',
            installCondition: {
              kind: 'executable-glob',
              label: 'KiCad',
              roots: ['${TRYLO_CAD_TEST_ROOT}'],
              markers: ['KiCad/*/bin/kicad-cli.exe'],
              remediation: '请安装 KiCad 9 或更高版本',
            },
          }),
        ],
        ...seam,
      },
    });
  }

  it('degrades to condition-missing when the host app probe fails', async () => {
    const tooling = build({
      probeAppCondition: async () => ({ ok: false, reasonCode: 'app_not_installed', detail: 'KiCad not found' }),
    });
    const health = await tooling.health({ id: 'kicad-mcp' });
    const record = health.packages[0];
    assert.equal(record.state, 'condition-missing');
    assert.equal(record.available, false);
    assert.equal(record.condition.ok, false);
    assert.equal(record.condition.reasonCode, 'app_not_installed');
    tooling.dispose();
  });

  it('stays available when the host app probe passes', async () => {
    const tooling = build({
      probeAppCondition: async () => ({ ok: true, reasonCode: 'app_ok', detail: 'KiCad found' }),
    });
    const health = await tooling.health({ id: 'kicad-mcp' });
    assert.equal(health.packages[0].available, true);
    assert.equal(health.packages[0].condition.ok, true);
    tooling.dispose();
  });

  it('runs the REAL probe against the filesystem when no seam is injected', async () => {
    const tooling = build({});
    const health = await tooling.health({ id: 'kicad-mcp' });
    assert.equal(health.packages[0].available, true);
    assert.equal(health.packages[0].condition.reasonCode, 'app_ok');
    assert.ok(health.packages[0].condition.detail.includes('kicad-cli.exe'));
    tooling.dispose();
  });

  it('carries the manifest remediation into the degraded detail', async () => {
    const tooling = build({
      probeAppCondition: async () => ({ ok: false, reasonCode: 'app_not_installed', detail: 'KiCad not found' }),
    });
    const health = await tooling.health({ id: 'kicad-mcp' });
    assert.ok(health.packages[0].detail.includes('请安装 KiCad 9 或更高版本'));
    tooling.dispose();
  });
});

describe('work.cad.v1 profile', () => {
  it('exists, is work-surface, strict, and carries the base layer + six adapter ids', () => {
    const profile = TOOL_PROFILES['work.cad.v1'];
    assert.ok(profile, 'work.cad.v1 must be declared');
    assert.equal(profile.surface, 'work');
    assert.equal(profile.strictMcpConfig, true);
    // Composition is LAYERED since the capability-layer refactor: the
    // 办公基底 (officecli + playwright + windows-mcp) first, then the six
    // CAD/EDA adapters (withCadEda). Order matters for MCP config assembly,
    // so the assertion stays exact.
    assert.deepEqual([...profile.packageIds], [
      'officecli',
      'playwright',
      'windows-mcp',
      'solidworks-mcp',
      'autocad-mcp',
      'kicad-mcp',
      'jlceda-mcp',
      'freecad-mcp',
      'blender-mcp',
    ]);
  });

  it('composes only the packages whose host apps are present', async () => {
    const healthy = fakeCadManifest({
      id: 'kicad-mcp',
      serverName: 'trylo-kicad',
      installCondition: { kind: 'executable-glob', label: 'KiCad', roots: ['${TRYLO_CAD_TEST_ROOT}'], markers: ['KiCad/*/bin/kicad-cli.exe'] },
    });
    const blocked = fakeCadManifest({
      id: 'solidworks-mcp',
      serverName: 'trylo-solidworks',
      installCondition: { kind: 'com-progid', progid: 'SldWorks.Application', label: 'SolidWorks' },
    });
    const fakeExe = path.join(tmpRoot, 'pkg-root', 'kicad', 'entry.js');
    const tooling = createToolingServices({
      appDataDir: tmpRoot,
      sidecarsDir: tmpRoot,
      seam: {
        installRoot: path.join(tmpRoot, 'tool-packages'),
        profilesRoot: path.join(tmpRoot, 'tool-profiles-cad'),
        overrides: { 'kicad-mcp': fakeExe, 'solidworks-mcp': fakeExe },
        manifests: [healthy, blocked],
        probeAppCondition: async (condition) =>
          condition.kind === 'com-progid'
            ? { ok: false, reasonCode: 'app_not_installed', detail: 'SolidWorks not registered' }
            : { ok: true, reasonCode: 'app_ok', detail: 'KiCad found' },
      },
    });
    const resolved = await tooling.resolveProfile({ surface: 'work', requestedProfileId: 'work.cad.v1', projectRoot: tmpRoot, conversationId: 'conv-1' });
    assert.equal(resolved.ok, true);
    assert.deepEqual(resolved.serverNames, ['trylo-kicad']);
    const blockedEntry = resolved.unavailableCapabilities.find((c) => c.id === 'solidworks-mcp');
    assert.ok(blockedEntry, 'the degraded package must be reported');
    assert.equal(blockedEntry.reasonCode, 'not_installed');
    assert.ok(blockedEntry.userMessage.includes('SolidWorks'));
    tooling.dispose();
  });
});
