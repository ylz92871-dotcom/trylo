// Trylo Desktop Services — CAD/EDA transport + manifest integration tests.
//
// TRYLO-CAD-EDA-TOOL-ADAPTER §6 / §7. Pins:
//   - pinned-pypi-env wheels mode: the manifest wheel closure is downloaded,
//     digest-verified, installed offline into a uv venv; a mismatch leaves
//     NOTHING on disk; resolve() vouches installs by the wheel-set digest;
//   - pinned-pypi-env source mode: source tarball + dep wheels, health =
//     the pinned source entry script existing next to the venv;
//   - release-archive + npm-ci-build: extract → npm ci → npm run build →
//     dist entry, plus the KiCad bundled-Python wheel step (present and
//     absent cases);
//   - the six SHIPPED manifests validate, and work.cad.v1 composes only the
//     adapters whose host-app condition holds (installDir token expansion,
//     honest degradation for the missing one).

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  createToolPackageManager,
  pypiWheelStateDigest,
} from '../../src/tooling/tool-package-manager.mjs';
import { createToolCatalog } from '../../src/tooling/tool-catalog.mjs';
import { createToolingServices } from '../../src/tooling/index.mjs';
import { SOLIDWORKS_MCP_MANIFEST } from '../../src/tooling/manifests/solidworks-mcp.mjs';
import { AUTOCAD_MCP_MANIFEST } from '../../src/tooling/manifests/autocad-mcp.mjs';
import { KICAD_MCP_MANIFEST } from '../../src/tooling/manifests/kicad-mcp.mjs';
import { JLCEDA_MCP_MANIFEST } from '../../src/tooling/manifests/jlceda-mcp.mjs';
import { FREECAD_MCP_MANIFEST } from '../../src/tooling/manifests/freecad-mcp.mjs';
import { BLENDER_MCP_MANIFEST } from '../../src/tooling/manifests/blender-mcp.mjs';
import { WINDOWS_MCP_MANIFEST } from '../../src/tooling/manifests/windows-mcp.mjs';
import { OFFICECLI_MANIFEST } from '../../src/tooling/manifests/officecli.mjs';

const SAVED = {
  TRYLO_APP_DATA_DIR: process.env.TRYLO_APP_DATA_DIR,
  TRYLO_SIDECARS_DIR: process.env.TRYLO_SIDECARS_DIR,
  ProgramFiles: process.env.ProgramFiles,
};

let tmpRoot = '';

function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function mkdirp(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

function writeF(p, content) {
  mkdirp(path.dirname(p));
  fs.writeFileSync(p, content);
  return p;
}

/** Deterministic fake wheel bytes per URL; the manifest pins their digest. */
function fakeWheels(specs) {
  return specs.map(({ name, version }) => {
    const url = `https://wheels.invalid/${name}-${version}-py3-none-any.whl`;
    const bytes = Buffer.from(`fake-wheel:${name}:${version}`);
    return { name, version, url, sha256: sha256Hex(bytes) };
  });
}

function wheelManifest({ id, wheels }) {
  return Object.freeze({
    schemaVersion: 1,
    id,
    displayName: id,
    version: '1.0.0',
    adoption: 'trial',
    activation: 'explicit-computer',
    classifierId: id,
    source: Object.freeze({ repository: 'https://example.invalid/trylo/cad-test', license: 'MIT' }),
    artifact: Object.freeze({
      platform: 'win32-x64',
      installStrategy: 'pinned-pypi-env',
      archiveSha256: pypiWheelStateDigest(wheels),
      pythonVersion: '3.12',
      pythonPackage: id,
      wheels: Object.freeze(wheels.map((w) => Object.freeze(w))),
      executableRelativePath: '.venv/Scripts/cad-test.exe',
    }),
    mcp: Object.freeze({
      serverName: `trylo-${id}`,
      transport: 'stdio',
      args: Object.freeze([]),
      expectedTools: Object.freeze(['probe']),
    }),
    healthCheck: 'python-metadata',
  });
}

/** Fake `uv`: `venv` creates the venv dir; `pip install` materialises the
 *  interpreter and the manifest's console-script entry inside it. */
function fakeUvRunCommand(venvEntryExeName) {
  const calls = [];
  let venvDir = '';
  return {
    calls,
    run: async (exe, args) => {
      calls.push({ exe, args });
      if (args[0] === 'venv') {
        venvDir = args[1];
        mkdirp(venvDir);
      } else if (args[0] === 'pip') {
        if (!venvDir) throw new Error('fake uv: pip before venv');
        const scripts = path.join(venvDir, process.platform === 'win32' ? 'Scripts' : 'bin');
        writeF(path.join(scripts, process.platform === 'win32' ? 'python.exe' : 'python'), '');
        if (venvEntryExeName) writeF(path.join(scripts, venvEntryExeName), '');
      }
      return true;
    },
  };
}

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'trylo-cad-transport-'));
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

describe('pinned-pypi-env: wheels mode', () => {
  function build(manifest, seam = {}) {
    return createToolPackageManager({
      storageRoot: tmpRoot,
      catalog: createToolCatalog({ manifests: [manifest] }),
      installRoot: path.join(tmpRoot, 'tool-packages'),
      download: async (url, dest) => {
        // Same bytes the manifest's digest was computed from.
        const wheel = (manifest.artifact.wheels ?? []).find((w) => w.url === url);
        const bytes = wheel
          ? Buffer.from(`fake-wheel:${wheel.name}:${wheel.version}`)
          : Buffer.from(`fake-wheel:${url.split('/').pop()}`);
        fs.writeFileSync(dest, bytes);
      },
      ...seam,
    });
  }

  it('installs the pinned closure offline and vouches the install by its digest', async () => {
    const wheels = fakeWheels([
      { name: 'fake-cad', version: '1.0.0' },
      { name: 'fake-dep', version: '0.2.0' },
    ]);
    const manifest = wheelManifest({ id: 'cad-test', wheels });
    const uv = fakeUvRunCommand('cad-test.exe');
    const packages = build(manifest, { runCommand: uv.run });
    const result = await packages.install({ id: 'cad-test' });
    assert.equal(result.ok, true, result.error ?? '');
    assert.ok(isFile(result.executable));
    const state = JSON.parse(fs.readFileSync(path.join(result.installDir, 'install-state.json'), 'utf8'));
    assert.equal(state.mode, 'wheels');
    assert.equal(state.sha256, pypiWheelStateDigest(wheels));
    assert.equal(state.wheels['fake-dep'], wheels[1].sha256);
    const resolved = await packages.resolve(manifest);
    assert.equal(resolved.state, 'installed');
    assert.equal(resolved.detail, 'digest verified');
  });

  it('a wheel digest mismatch leaves nothing on disk', async () => {
    const wheels = fakeWheels([{ name: 'fake-cad', version: '1.0.0' }]);
    const manifest = wheelManifest({ id: 'cad-bad', wheels });
    const packages = build(manifest, {
      download: async (url, dest) => {
        const bytes = Buffer.from(`fake-wheel:${url.split('/').pop()}`);
        // Tamper exactly one wheel (the second call would be the dep).
        fs.writeFileSync(dest, url.includes('fake-cad') ? Buffer.from('tampered') : bytes);
      },
      runCommand: fakeUvRunCommand('cad-test.exe').run,
    });
    const result = await packages.install({ id: 'cad-bad' });
    assert.equal(result.ok, false);
    assert.equal(result.reasonCode, 'hash_mismatch');
    assert.ok(!fs.existsSync(path.join(tmpRoot, 'tool-packages', 'cad-bad')));
  });

  it('a staged wheel digest is checked BEFORE uv runs', async () => {
    const wheels = fakeWheels([
      { name: 'fake-cad', version: '1.0.0' },
      { name: 'fake-dep', version: '0.2.0' },
    ]);
    const manifest = wheelManifest({ id: 'cad-order', wheels });
    const uv = fakeUvRunCommand('cad-test.exe');
    const packages = build(manifest, {
      download: async (url, dest) => {
        const bytes = Buffer.from(`fake-wheel:${url.split('/').pop()}`);
        fs.writeFileSync(dest, url.includes('fake-dep') ? Buffer.from('tampered') : bytes);
      },
      runCommand: uv.run,
    });
    const result = await packages.install({ id: 'cad-order' });
    assert.equal(result.ok, false);
    assert.equal(result.reasonCode, 'hash_mismatch');
    assert.equal(uv.calls.length, 0, 'uv must never run against an unverified wheel');
  });
});

describe('pinned-pypi-env: source mode (solidworks shape)', () => {
  it('extracts the pinned tree, builds the venv, and verifies via source-entry', async () => {
    const wheels = fakeWheels([{ name: 'fake-sw-dep', version: '1.0.0' }]);
    const sourceBytes = Buffer.from('fake-source-tarball');
    const manifest = Object.freeze({
      ...wheelManifest({ id: 'sw-test', wheels }),
      artifact: Object.freeze({
        platform: 'win32-x64',
        installStrategy: 'pinned-pypi-env',
        archiveSha256: sha256Hex(sourceBytes),
        pythonVersion: '3.12',
        sourceTarballUrl: 'https://example.invalid/sw.tar.gz',
        sourceTarballSha256: sha256Hex(sourceBytes),
        sourceEntry: 'mcp-server/server.py',
        wheels: Object.freeze(wheels.map((w) => Object.freeze(w))),
        executableRelativePath: '.venv/Scripts/python.exe',
      }),
      healthCheck: 'source-entry',
    });
    const uv = fakeUvRunCommand('');
    const packages = createToolPackageManager({
      storageRoot: tmpRoot,
      catalog: createToolCatalog({ manifests: [manifest] }),
      installRoot: path.join(tmpRoot, 'tool-packages'),
      download: async (url, dest) => {
        const wheel = wheels.find((w) => w.url === url);
        fs.writeFileSync(dest, wheel ? Buffer.from(`fake-wheel:${wheel.name}:${wheel.version}`) : sourceBytes);
      },
      extract: (tarball, dest) => {
        writeF(path.join(dest, 'mcp-server', 'server.py'), '# fake entry\n');
        writeF(path.join(dest, 'capabilities.yaml'), 'capabilities: []\n');
      },
      runCommand: uv.run,
    });
    const result = await packages.install({ id: 'sw-test' });
    assert.equal(result.ok, true, result.error ?? '');
    assert.ok(isFile(path.join(result.installDir, 'mcp-server', 'server.py')));
    const state = JSON.parse(fs.readFileSync(path.join(result.installDir, 'install-state.json'), 'utf8'));
    assert.equal(state.mode, 'source-run');
    assert.equal(state.sha256, sha256Hex(sourceBytes));
  });
});

describe('release-archive + npm-ci-build', () => {
  function nodeManifest({ id, extra = {} }) {
    const sourceBytes = Buffer.from(`fake-node-source:${id}`);
    return {
      manifest: Object.freeze({
        schemaVersion: 1,
        id,
        displayName: id,
        version: '1.0.0',
        adoption: 'trial',
        activation: 'explicit-computer',
        classifierId: id,
        source: Object.freeze({ repository: 'https://example.invalid/trylo/cad-test', license: 'MIT' }),
        artifact: Object.freeze({
          platform: 'win32-x64',
          installStrategy: 'release-archive',
          archiveSha256: sha256Hex(sourceBytes),
          downloadUrl: `https://example.invalid/${id}.tar.gz`,
          build: Object.freeze({ kind: 'npm-ci-build' }),
          executableRelativePath: 'dist/index.js',
          sourceEntry: 'dist/index.js',
          runner: 'node',
          ...extra,
        }),
        mcp: Object.freeze({
          serverName: `trylo-${id}`,
          transport: 'stdio',
          args: Object.freeze([]),
          expectedTools: Object.freeze(['probe']),
        }),
        healthCheck: 'source-entry',
      }),
      sourceBytes,
    };
  }

  function fakeNpmRunCommand({ pipTarget = null } = {}) {
    const calls = [];
    return {
      calls,
      run: async (exe, args, _timeout, opts = {}) => {
        calls.push({ exe, args, cwd: opts.cwd });
        // npm now runs as `node <npm-cli.js> run build …` (CVE-2024-27980
        // bars direct .cmd spawns); match on the VERB + SUBCOMMAND — the
        // CLI entry arrives as an ABSOLUTE path ending in npm-cli.js.
        const cliIndex = args.findIndex((a) => typeof a === 'string' && a.endsWith('npm-cli.js'));
        const verb = cliIndex >= 0 ? args[cliIndex + 1] : args[0];
        const sub = cliIndex >= 0 ? args[cliIndex + 2] : args[1];
        if (verb === 'ci') {
          mkdirp(path.join(opts.cwd, 'node_modules'));
        } else if (verb === 'run' && sub === 'build') {
          writeF(path.join(opts.cwd, 'dist', 'index.js'), '// built\n');
        } else if (verb === '-m' && pipTarget) {
          pipTarget.installedInto = exe;
        }
        return true;
      },
    };
  }

  it('builds the pinned source tree and verifies via source-entry', async () => {
    const { manifest, sourceBytes } = nodeManifest({ id: 'node-cad' });
    const npm = fakeNpmRunCommand();
    const packages = createToolPackageManager({
      storageRoot: tmpRoot,
      catalog: createToolCatalog({ manifests: [manifest] }),
      installRoot: path.join(tmpRoot, 'tool-packages'),
      download: async (url, dest) => fs.writeFileSync(dest, sourceBytes),
      extract: (tarball, dest) => writeF(path.join(dest, 'package.json'), '{}'),
      runCommand: npm.run,
    });
    const result = await packages.install({ id: 'node-cad' });
    assert.equal(result.ok, true, result.error ?? '');
    assert.ok(isFile(path.join(result.installDir, 'dist', 'index.js')));
    const verbOf = (call) => {
      const cliIndex = call.args.findIndex((a) => typeof a === 'string' && a.endsWith('npm-cli.js'));
      return cliIndex >= 0 ? call.args[cliIndex + 1] : call.args[0];
    };
    const kinds = npm.calls.map(verbOf);
    assert.deepEqual(kinds.filter((k) => k === 'ci' || k === 'run'), ['ci', 'run']);
    assert.equal(npm.calls[0].args.includes('--ignore-scripts'), true, 'lifecycle hooks must never run');
    const state = JSON.parse(fs.readFileSync(path.join(result.installDir, 'install-state.json'), 'utf8'));
    assert.equal(state.build, 'npm-ci-build');
    assert.equal(state.sha256, sha256Hex(sourceBytes));
  });

  it('installs the pinned python wheels into the DETECTED KiCad interpreter', async () => {
    const kicadPython = writeF(path.join(tmpRoot, 'pf', 'KiCad', '9.0', 'bin', 'python.exe'), '');
    const wheels = Object.freeze(
      fakeWheels([
        { name: 'kicad-python', version: '0.8.0' },
        { name: 'sexpdata', version: '1.0.2' },
      ]).map((w) => Object.freeze(w)),
    );
    const { manifest, sourceBytes } = nodeManifest({
      id: 'node-kicad',
      extra: {
        pythonWheels: wheels,
        pythonWheelsTarget: 'kicad-bundled',
      },
    });
    const pipTarget = {};
    const npm = fakeNpmRunCommand({ pipTarget });
    const previousProgramFiles = process.env.ProgramFiles;
    process.env.ProgramFiles = path.join(tmpRoot, 'pf');
    try {
      const packages = createToolPackageManager({
        storageRoot: tmpRoot,
        catalog: createToolCatalog({ manifests: [manifest] }),
        installRoot: path.join(tmpRoot, 'tool-packages'),
        download: async (url, dest) => {
          const wheel = wheels.find((w) => url.endsWith(`${w.name}-${w.version}-py3-none-any.whl`));
          fs.writeFileSync(dest, wheel ? Buffer.from(`fake-wheel:${wheel.name}:${wheel.version}`) : sourceBytes);
        },
        extract: (tarball, dest) => writeF(path.join(dest, 'package.json'), '{}'),
        runCommand: npm.run,
      });
      const result = await packages.install({ id: 'node-kicad' });
      assert.equal(result.ok, true, result.error ?? '');
      const pipCall = npm.calls.find((call) => call.args[0] === '-m');
      assert.ok(pipCall, 'the kicad python wheel step must run');
      assert.equal(path.dirname(pipCall.exe), path.dirname(kicadPython));
      const state = JSON.parse(fs.readFileSync(path.join(result.installDir, 'install-state.json'), 'utf8'));
      assert.equal(state.kicadPython, pipCall.exe);
      assert.equal(state.pythonWheels['kicad-python'], wheels[0].sha256);
    } finally {
      if (previousProgramFiles === undefined) delete process.env.ProgramFiles;
      else process.env.ProgramFiles = previousProgramFiles;
    }
  });

  it('fails honestly (kicad_python_missing) when no KiCad interpreter exists', async () => {
    const wheels = Object.freeze(fakeWheels([{ name: 'kicad-python', version: '0.8.0' }]).map((w) => Object.freeze(w)));
    const { manifest, sourceBytes } = nodeManifest({
      id: 'node-kicad-none',
      extra: { pythonWheels: wheels, pythonWheelsTarget: 'kicad-bundled' },
    });
    const previousProgramFiles = process.env.ProgramFiles;
    process.env.ProgramFiles = path.join(tmpRoot, 'pf-empty-no-kicad');
    try {
      const packages = createToolPackageManager({
        storageRoot: tmpRoot,
        catalog: createToolCatalog({ manifests: [manifest] }),
        installRoot: path.join(tmpRoot, 'tool-packages'),
        download: async (url, dest) => fs.writeFileSync(dest, sourceBytes),
        extract: (tarball, dest) => writeF(path.join(dest, 'package.json'), '{}'),
        runCommand: fakeNpmRunCommand().run,
      });
      const result = await packages.install({ id: 'node-kicad-none' });
      assert.equal(result.ok, false);
      assert.equal(result.reasonCode, 'kicad_python_missing');
      assert.ok(!fs.existsSync(path.join(tmpRoot, 'tool-packages', 'node-kicad-none', 'install-state.json')));
    } finally {
      if (previousProgramFiles === undefined) delete process.env.ProgramFiles;
      else process.env.ProgramFiles = previousProgramFiles;
    }
  });
});

describe('shipped CAD/EDA manifests + work.cad.v1 composition', () => {
  it('carries the full audited tool surfaces', () => {
    // 45 pinned + 5 controlled-modeling-channel + 1 direction-probe (2026-09-06)
    assert.equal(SOLIDWORKS_MCP_MANIFEST.mcp.expectedTools.length, 51);
    assert.equal(AUTOCAD_MCP_MANIFEST.mcp.expectedTools.length, 154);
    assert.equal(KICAD_MCP_MANIFEST.mcp.expectedTools.length, 229);
    assert.equal(JLCEDA_MCP_MANIFEST.mcp.expectedTools.length, 59);
    assert.equal(FREECAD_MCP_MANIFEST.mcp.expectedTools.length, 15);
    assert.equal(BLENDER_MCP_MANIFEST.mcp.expectedTools.length, 28);
  });

  function buildIntegration({ failLabel = null } = {}) {
    // Override installDir = dirname(override exe). Placing the exe DIRECTLY
    // inside `pkg/` makes installDir = pkg/, so the manifest sourceEntry
    // (`dist/index.js`, `mcp-server/server.py`) resolves exactly like the
    // real install layout (<versionDir>/...).
    const swDir = path.join(tmpRoot, 'ov', 'solidworks', 'pkg');
    writeF(path.join(swDir, 'mcp-server', 'server.py'), '# entry\n');
    const swExe = writeF(path.join(swDir, 'python.exe'), '');
    const nodeExe = (id) => writeF(path.join(tmpRoot, 'ov', id, 'pkg', 'node-entry.js'), '');
    const pyExe = (id, entry) => writeF(path.join(tmpRoot, 'ov', id, 'pkg', entry), '');
    // The sourceEntry targets the health probe verifies:
    writeF(path.join(tmpRoot, 'ov', 'kicad', 'pkg', 'dist', 'index.js'), '// built\n');
    writeF(path.join(tmpRoot, 'ov', 'jlceda', 'pkg', 'dist', 'index.js'), '// built\n');
    // officecli rides an explicit override (same as every adapter above):
    // resolve() vouches the file's existence, no version handshake here
    // (protocol health is owned by the CLI run, not the sidecar).
    const officeExe = writeF(path.join(tmpRoot, 'ov', 'officecli', 'pkg', 'officecli-win-x64.exe'), '');
    const tooling = createToolingServices({
      appDataDir: tmpRoot,
      sidecarsDir: tmpRoot,
      seam: {
        installRoot: path.join(tmpRoot, 'tool-packages'),
        profilesRoot: path.join(tmpRoot, 'tool-profiles-cad'),
        // The fake binaries are not executables, so the `--version` probe
        // is injected (officecli health executes it; the CAD adapters are
        // gated by probeAppCondition + sourceEntry instead).
        probe: async () => '1.0.145',
        manifests: [
          SOLIDWORKS_MCP_MANIFEST,
          AUTOCAD_MCP_MANIFEST,
          KICAD_MCP_MANIFEST,
          JLCEDA_MCP_MANIFEST,
          FREECAD_MCP_MANIFEST,
          BLENDER_MCP_MANIFEST,
          WINDOWS_MCP_MANIFEST,
          OFFICECLI_MANIFEST,
        ],
        overrides: {
          'solidworks-mcp': swExe,
          'windows-mcp': pyExe('windows', 'windows-mcp.exe'),
          'autocad-mcp': pyExe('autocad', 'autocad-mcp.exe'),
          'kicad-mcp': nodeExe('kicad'),
          'jlceda-mcp': nodeExe('jlceda'),
          'freecad-mcp': pyExe('freecad', 'freecad-mcp.exe'),
          'blender-mcp': pyExe('blender', 'blender-mcp.exe'),
          'officecli': officeExe,
        },
        probePythonMetadata: async (_exe, pythonPackage) =>
          ({
            'autocad-mcp-pro': '1.5.1',
            'freecad-mcp': '0.1.22',
            'blender-mcp': '1.9.1',
            'windows-mcp': '0.8.5',
          })[pythonPackage] ?? null,
        probeAppCondition: async (condition) =>
          failLabel && condition.label === failLabel
            ? { ok: false, reasonCode: 'bridge_not_running', detail: 'bridge down' }
            : { ok: true, reasonCode: 'app_ok', detail: `${condition.label} ok` },
      },
    });
    return { tooling, swDir };
  }

  it('work.cad.v1 composes all six adapters with {installDir} expanded', async () => {
    const { tooling, swDir } = buildIntegration();
    const resolved = await tooling.resolveProfile({
      surface: 'work',
      requestedProfileId: 'work.cad.v1',
      projectRoot: tmpRoot,
      conversationId: 'conv-cad',
    });
    assert.equal(resolved.ok, true, resolved.error ?? '');
    assert.deepEqual([...resolved.serverNames].sort(), [
      'trylo-autocad',
      'trylo-blender',
      'trylo-freecad',
      'trylo-jlceda',
      'trylo-kicad',
      'trylo-office',
      'trylo-solidworks',
      'trylo-windows',
    ]);
    // {installDir} token: the solidworks source entry resolves inside the
    // override's install dir.
    const swCommand = resolved.mcpConfigPath
      ? JSON.parse(fs.readFileSync(resolved.mcpConfigPath, 'utf8')).mcpServers['trylo-solidworks']
      : null;
    assert.ok(swCommand);
    // The manifest's sourceEntry uses forward slashes; Windows accepts both,
    // so compare resolved (normalized) paths.
    assert.equal(
      path.resolve(swCommand.args[0]),
      path.resolve(path.join(swDir, 'mcp-server', 'server.py')),
    );
    assert.ok(resolved.cliArgs.includes('--strict-mcp-config'));
    tooling.dispose();
  });

  it('degrades the adapter whose host-app condition fails', async () => {
    const { tooling } = buildIntegration({ failLabel: '嘉立创EDA专业版' });
    const resolved = await tooling.resolveProfile({
      surface: 'work',
      requestedProfileId: 'work.cad.v1',
      projectRoot: tmpRoot,
      conversationId: 'conv-cad-2',
    });
    assert.equal(resolved.ok, true);
    assert.equal(resolved.serverNames.includes('trylo-jlceda'), false);
    const degraded = resolved.unavailableCapabilities.find((c) => c.id === 'jlceda-mcp');
    assert.ok(degraded);
    assert.equal(degraded.reasonCode, 'not_installed');
    tooling.dispose();
  });
});

describe('TRYLO_ARTIFACT_MIRROR: mirror-first, upstream-fallback (§6.5)', () => {
  const SAVED_MIRROR = process.env.TRYLO_ARTIFACT_MIRROR;
  const MIRROR_BASE = 'https://mirror.test/trylo-artifacts';

  after(() => {
    if (SAVED_MIRROR === undefined) delete process.env.TRYLO_ARTIFACT_MIRROR;
    else process.env.TRYLO_ARTIFACT_MIRROR = SAVED_MIRROR;
  });

  function archiveManifest({ id, content }) {
    return Object.freeze({
      schemaVersion: 1,
      id,
      displayName: id,
      version: '1.0.0',
      adoption: 'trial',
      activation: 'explicit-computer',
      classifierId: id,
      source: Object.freeze({ repository: 'https://example.invalid/trylo/x', license: 'MIT' }),
      artifact: Object.freeze({
        platform: 'win32-x64',
        installStrategy: 'release-archive',
        archiveSha256: sha256Hex(content),
        downloadUrl: `https://upstream.invalid/${id}.tar.gz`,
        executableRelativePath: 'x.exe',
      }),
      mcp: Object.freeze({
        serverName: `trylo-${id}`,
        transport: 'stdio',
        args: Object.freeze([]),
        expectedTools: Object.freeze(['probe']),
      }),
    });
  }

  function recordingDownload(content) {
    const calls = [];
    return {
      calls,
      run: async (url, dest) => {
        calls.push(url);
        const fromMirror = url.startsWith(MIRROR_BASE);
        // `served` decides what the mirror/upstream actually returns; a
        // callable models an unreachable origin (throws before writing).
        const served = fromMirror ? content.servedByMirror : content.servedByUpstream;
        const bytes = typeof served === 'function' ? served() : served;
        fs.writeFileSync(dest, bytes);
      },
    };
  }

  function expectedMirrorUrl(manifest) {
    const sha = manifest.artifact.archiveSha256;
    return `${MIRROR_BASE}/${manifest.id}/${sha.slice(0, 16)}-${manifest.id}.tar.gz`;
  }

  const GOOD = Buffer.from('artifact-bytes');
  const BAD = Buffer.from('tampered-bytes');

  it('mirror hit short-circuits upstream entirely', async () => {
    const manifest = archiveManifest({ id: 'mirror-hit', content: GOOD });
    const dl = recordingDownload({ servedByMirror: GOOD, servedByUpstream: GOOD });
    process.env.TRYLO_ARTIFACT_MIRROR = MIRROR_BASE;
    const packages = createToolPackageManager({
      storageRoot: tmpRoot,
      catalog: createToolCatalog({ manifests: [manifest] }),
      installRoot: path.join(tmpRoot, 'tool-packages'),
      download: dl.run,
    });
    const result = await packages.install({ id: 'mirror-hit' });
    assert.equal(result.ok, true, result.error ?? '');
    assert.deepEqual(dl.calls, [expectedMirrorUrl(manifest)]);
    const state = JSON.parse(fs.readFileSync(path.join(result.installDir, 'install-state.json'), 'utf8'));
    assert.equal(state.artifactOrigin, 'mirror');
  });

  it('mirror miss (unreachable) falls back to upstream', async () => {
    const manifest = archiveManifest({ id: 'mirror-miss', content: GOOD });
    const dl = recordingDownload({
      servedByMirror: () => {
        throw new Error('mirror down');
      },
      servedByUpstream: GOOD,
    });
    process.env.TRYLO_ARTIFACT_MIRROR = MIRROR_BASE;
    const packages = createToolPackageManager({
      storageRoot: tmpRoot,
      catalog: createToolCatalog({ manifests: [manifest] }),
      installRoot: path.join(tmpRoot, 'tool-packages'),
      download: dl.run,
    });
    const result = await packages.install({ id: 'mirror-miss' });
    assert.equal(result.ok, true, result.error ?? '');
    assert.deepEqual(dl.calls, [expectedMirrorUrl(manifest), manifest.artifact.downloadUrl]);
    const state = JSON.parse(fs.readFileSync(path.join(result.installDir, 'install-state.json'), 'utf8'));
    assert.equal(state.artifactOrigin, 'upstream');
  });

  it('mirror serving WRONG bytes falls back to upstream (digest is the gate)', async () => {
    const manifest = archiveManifest({ id: 'mirror-bad', content: GOOD });
    const dl = recordingDownload({ servedByMirror: BAD, servedByUpstream: GOOD });
    process.env.TRYLO_ARTIFACT_MIRROR = MIRROR_BASE;
    const packages = createToolPackageManager({
      storageRoot: tmpRoot,
      catalog: createToolCatalog({ manifests: [manifest] }),
      installRoot: path.join(tmpRoot, 'tool-packages'),
      download: dl.run,
    });
    const result = await packages.install({ id: 'mirror-bad' });
    assert.equal(result.ok, true, result.error ?? '');
    assert.deepEqual(dl.calls, [expectedMirrorUrl(manifest), manifest.artifact.downloadUrl]);
  });

  it('upstream digest drift still fails loudly with the mirror set', async () => {
    const manifest = archiveManifest({ id: 'mirror-drift', content: GOOD });
    const dl = recordingDownload({ servedByMirror: BAD, servedByUpstream: BAD });
    process.env.TRYLO_ARTIFACT_MIRROR = MIRROR_BASE;
    const packages = createToolPackageManager({
      storageRoot: tmpRoot,
      catalog: createToolCatalog({ manifests: [manifest] }),
      installRoot: path.join(tmpRoot, 'tool-packages'),
      download: dl.run,
    });
    const result = await packages.install({ id: 'mirror-drift' });
    assert.equal(result.ok, false);
    assert.equal(result.reasonCode, 'hash_mismatch');
  });

  it('no mirror env → upstream only, unchanged behaviour', async () => {
    delete process.env.TRYLO_ARTIFACT_MIRROR;
    const manifest = archiveManifest({ id: 'mirror-off', content: GOOD });
    const dl = recordingDownload({ servedByMirror: GOOD, servedByUpstream: GOOD });
    const packages = createToolPackageManager({
      storageRoot: tmpRoot,
      catalog: createToolCatalog({ manifests: [manifest] }),
      installRoot: path.join(tmpRoot, 'tool-packages'),
      download: dl.run,
    });
    const result = await packages.install({ id: 'mirror-off' });
    assert.equal(result.ok, true);
    assert.deepEqual(dl.calls, [manifest.artifact.downloadUrl]);
  });
  it('zero-config: <storageRoot>/pinned-artifact-mirror is honoured without env', async () => {
    const manifest = archiveManifest({ id: 'zc-hit', content: GOOD });
    writeF(path.join(tmpRoot, 'pinned-artifact-mirror', 'mirror-manifest.json'), '{}\n');
    writeF(
      path.join(tmpRoot, 'pinned-artifact-mirror', manifest.id, `${manifest.artifact.archiveSha256.slice(0, 16)}-${manifest.id}.tar.gz`),
      GOOD,
    );
    delete process.env.TRYLO_ARTIFACT_MIRROR;
    const dl = recordingDownload({
      servedByMirror: () => {
        throw new Error('zero-config mirror hit must never touch the network');
      },
      servedByUpstream: GOOD,
    });
    const packages = createToolPackageManager({
      storageRoot: tmpRoot,
      catalog: createToolCatalog({ manifests: [manifest] }),
      installRoot: path.join(tmpRoot, 'tool-packages'),
      download: dl.run,
    });
    const result = await packages.install({ id: 'zc-hit' });
    assert.equal(result.ok, true, result.error ?? '');
    assert.deepEqual(dl.calls, []);
    const state = JSON.parse(fs.readFileSync(path.join(result.installDir, 'install-state.json'), 'utf8'));
    assert.equal(state.artifactOrigin, 'mirror');
  });

  it('LOCAL directory mirror hit copies the file with ZERO network calls', async () => {
    const manifest = archiveManifest({ id: 'lm-hit', content: GOOD });
    const mirrorFile = path.join(
      tmpRoot, 'local-mirror', manifest.id,
      `${manifest.artifact.archiveSha256.slice(0, 16)}-${manifest.id}.tar.gz`,
    );
    writeF(mirrorFile, GOOD);
    process.env.TRYLO_ARTIFACT_MIRROR = path.join(tmpRoot, 'local-mirror');
    const dl = recordingDownload({
      servedByMirror: () => {
        throw new Error('network must not be touched when the local mirror hits');
      },
      servedByUpstream: GOOD,
    });
    const packages = createToolPackageManager({
      storageRoot: tmpRoot,
      catalog: createToolCatalog({ manifests: [manifest] }),
      installRoot: path.join(tmpRoot, 'tool-packages'),
      download: dl.run,
    });
    const result = await packages.install({ id: 'lm-hit' });
    assert.equal(result.ok, true, result.error ?? '');
    assert.deepEqual(dl.calls, [], 'a local mirror hit must never touch the network');
    const state = JSON.parse(fs.readFileSync(path.join(result.installDir, 'install-state.json'), 'utf8'));
    assert.equal(state.artifactOrigin, 'mirror');
  });

  it('LOCAL mirror miss (file absent) falls back to upstream', async () => {
    const manifest = archiveManifest({ id: 'lm-miss', content: GOOD });
    mkdirp(path.join(tmpRoot, 'local-mirror-empty', manifest.id));
    process.env.TRYLO_ARTIFACT_MIRROR = path.join(tmpRoot, 'local-mirror-empty');
    const dl = recordingDownload({ servedByMirror: GOOD, servedByUpstream: GOOD });
    const packages = createToolPackageManager({
      storageRoot: tmpRoot,
      catalog: createToolCatalog({ manifests: [manifest] }),
      installRoot: path.join(tmpRoot, 'tool-packages'),
      download: dl.run,
    });
    const result = await packages.install({ id: 'lm-miss' });
    assert.equal(result.ok, true, result.error ?? '');
    assert.deepEqual(dl.calls, [manifest.artifact.downloadUrl]);
  });
});

  function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}
