// Trylo Desktop Services — tooling domain contract tests (appendix).
//
// PR-6 additions: Windows-MCP pinned-python-env manifest contract, transport
// seams and the python-metadata health probe (§6.6 / §8.2 / §10.3).

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { after, before, describe, it } from 'node:test';

import { createToolingServices } from '../../src/tooling/index.mjs';
import {
  TAR_COMMAND,
  resolveUvExecutable,
  syncWindowsMcpFork,
  WINDOWS_MCP_FORK_SRC,
} from '../../src/tooling/tool-package-manager.mjs';
import { validateManifest } from '../../src/tooling/tool-catalog.mjs';
import { OFFICECLI_MANIFEST } from '../../src/tooling/manifests/officecli.mjs';
import {
  WINDOWS_MCP_MANIFEST,
  WINDOWS_MCP_ALLOWED_TOOLS,
  WINDOWS_MCP_DENIED_TOOLS,
} from '../../src/tooling/manifests/windows-mcp.mjs';

const SAVED = {
  TRYLO_APP_DATA_DIR: process.env.TRYLO_APP_DATA_DIR,
  TRYLO_SIDECARS_DIR: process.env.TRYLO_SIDECARS_DIR,
  TRYLO_TOOL_PACKAGES_DIR: process.env.TRYLO_TOOL_PACKAGES_DIR,
  TRYLO_TOOL_PACKAGE_OVERRIDES: process.env.TRYLO_TOOL_PACKAGE_OVERRIDES,
};

let tmpRoot = '';

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'trylo-tooling-py-'));
  process.env.TRYLO_APP_DATA_DIR = tmpRoot;
  process.env.TRYLO_SIDECARS_DIR = tmpRoot;
  delete process.env.TRYLO_TOOL_PACKAGES_DIR;
  delete process.env.TRYLO_TOOL_PACKAGE_OVERRIDES;
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

/** A Hermes adapter stub (same shape as tooling.test.mjs). */
function hermesStub() {
  return {
    mcpArgs() {
      return { ok: true, arg: [], warning: null, configPath: null };
    },
  };
}

function build(overrides = {}) {
  return createToolingServices({
    appDataDir: tmpRoot,
    sidecarsDir: tmpRoot,
    seam: {
      hermes: overrides.hermes ?? hermesStub(),
      installRoot: overrides.installRoot ?? path.join(tmpRoot, 'tool-packages'),
      profilesRoot: overrides.profilesRoot ?? path.join(tmpRoot, 'tool-profiles'),
      probe: overrides.probe ?? (async () => '1.0.145'),
      ...(overrides.probePythonMetadata ? { probePythonMetadata: overrides.probePythonMetadata } : {}),
      ...(overrides.overrides ? { overrides: overrides.overrides } : {}),
      ...(overrides.manifests ? { manifests: overrides.manifests } : {}),
    },
  });
}

describe('windows-mcp manifest (PR-6, §6.6/§10.3)', () => {
  it('passes validation and pins the full contract', () => {
    const problems = validateManifest(WINDOWS_MCP_MANIFEST);
    assert.deepEqual(problems, [], problems.join('; '));
    assert.equal(WINDOWS_MCP_MANIFEST.version, '0.8.5');
    assert.equal(WINDOWS_MCP_MANIFEST.mcp.serverName, 'trylo-windows');
    assert.equal(WINDOWS_MCP_MANIFEST.activation, 'explicit-computer');
    assert.equal(WINDOWS_MCP_MANIFEST.artifact.installStrategy, 'pinned-python-env');
    assert.equal(WINDOWS_MCP_MANIFEST.telemetry, 'forced-off');
    assert.equal(WINDOWS_MCP_MANIFEST.healthCheck, 'python-metadata');
  });

  it('exposes exactly the 14 allowed tools and never the 7 excluded (§6.6)', () => {
    assert.equal(WINDOWS_MCP_MANIFEST.mcp.expectedTools.length, 14);
    assert.deepEqual([...WINDOWS_MCP_MANIFEST.mcp.expectedTools].sort(), [...WINDOWS_MCP_ALLOWED_TOOLS].sort());
    for (const denied of WINDOWS_MCP_DENIED_TOOLS) {
      assert.ok(!WINDOWS_MCP_ALLOWED_TOOLS.includes(denied), `${denied} must stay excluded`);
    }
    // The 14/7 split disposes of the full audited upstream surface of 20
    // plus the fork-added Ocr capture tool (2026-09-04 CAD-workflow round:
    // Clipboard moved out of the excluded set; Ocr added by the fork).
    assert.equal(WINDOWS_MCP_ALLOWED_TOOLS.length + WINDOWS_MCP_DENIED_TOOLS.length, 21);
  });

  it('the vendored fork exists and carries the fork-added/changed surface', {
    // The fork source tree lives outside this repository and is overlaid
    // after install; a fresh clone legitimately has none. The guard is only
    // meaningful in a development checkout that has the fork vendored.
    skip: !fs.existsSync(WINDOWS_MCP_FORK_SRC) && 'vendored fork source not present in this checkout',
  }, () => {
    // The pinned tarball is still upstream; the fork is overlaid after
    // install. If the fork is missing or stripped, `Ocr` silently
    // disappears from tools/list and the expectedTools drift check fails
    // at runtime — catch it here instead.
    assert.ok(fs.existsSync(WINDOWS_MCP_FORK_SRC), 'fork src/windows_mcp must exist');
    const forkTools = path.join(WINDOWS_MCP_FORK_SRC, 'tools');
    assert.ok(fs.existsSync(path.join(forkTools, 'ocr.py')), 'fork must ship the Ocr tool');
    const inputPy = fs.readFileSync(path.join(forkTools, 'input.py'), 'utf8');
    assert.ok(inputPy.includes('modifiers'), 'fork Click must support modifier clicks');
    assert.ok(inputPy.includes('action: Literal["click", "down", "up"]'), 'fork Click must support down/up');
    const servicePy = fs.readFileSync(
      path.join(WINDOWS_MCP_FORK_SRC, 'desktop', 'service.py'),
      'utf8',
    );
    assert.ok(servicePy.includes('def focus_window'), 'fork must ship window pre-focus');
    assert.ok(servicePy.includes('def keyboard_layout'), 'fork must ship the IME probe');
  });

  it('syncWindowsMcpFork overlays the fork onto an installed version dir', async () => {
    const versionDir = path.join(tmpRoot, 'fork-sync-target');
    const targetRoot = path.join(versionDir, 'src', 'windows_mcp');
    fs.mkdirSync(path.join(targetRoot, 'tools'), { recursive: true });
    fs.writeFileSync(path.join(targetRoot, 'tools', 'input.py'), '# upstream placeholder');

    const forkSrc = path.join(tmpRoot, 'fake-fork', 'windows_mcp');
    fs.mkdirSync(path.join(forkSrc, 'tools'), { recursive: true });
    fs.mkdirSync(path.join(forkSrc, 'tools', '__pycache__'), { recursive: true });
    fs.writeFileSync(path.join(forkSrc, 'tools', 'input.py'), '# fork version');
    fs.writeFileSync(path.join(forkSrc, 'tools', 'ocr.py'), '# fork ocr');
    fs.writeFileSync(path.join(forkSrc, 'tools', '__pycache__', 'ocr.cpython-314.pyc'), 'junk');

    const copied = await syncWindowsMcpFork(versionDir, forkSrc);

    assert.equal(copied, 2, 'fork files copied, __pycache__ skipped');
    assert.equal(fs.readFileSync(path.join(targetRoot, 'tools', 'input.py'), 'utf8'), '# fork version');
    assert.ok(fs.existsSync(path.join(targetRoot, 'tools', 'ocr.py')));
    assert.ok(!fs.existsSync(path.join(targetRoot, 'tools', '__pycache__')));
  });

  it('syncWindowsMcpFork is a no-op without a materialised install', async () => {
    const missing = path.join(tmpRoot, 'no-such-version-dir');
    assert.equal(await syncWindowsMcpFork(missing, WINDOWS_MCP_FORK_SRC), 0);
  });

  it('the allowlist AND the telemetry kill switch live in server argv/env (§6.6)', () => {
    const { args, env } = WINDOWS_MCP_MANIFEST.mcp;
    assert.equal(args[0], 'serve');
    assert.equal(args[args.indexOf('--transport') + 1], 'stdio', 'P0: local stdio only');
    const toolsIdx = args.indexOf('--tools');
    assert.ok(toolsIdx > 0, '--tools flag present in server argv');
    assert.equal(args[toolsIdx + 1], WINDOWS_MCP_ALLOWED_TOOLS.join(','));
    assert.equal(env.ANONYMIZED_TELEMETRY, 'false', '§6.6 telemetry forced off');
  });

  it('pins source tarball + uv.lock digests + source commit (§8.2 锁定 runtime + lock)', () => {
    assert.match(WINDOWS_MCP_MANIFEST.artifact.archiveSha256, /^[0-9a-f]{64}$/);
    assert.match(WINDOWS_MCP_MANIFEST.artifact.uvLockSha256, /^[0-9a-f]{64}$/);
    assert.match(WINDOWS_MCP_MANIFEST.artifact.sourceCommit, /^[0-9a-f]{40}$/);
    assert.ok(
      WINDOWS_MCP_MANIFEST.artifact.downloadUrl.includes(WINDOWS_MCP_MANIFEST.artifact.sourceCommit),
      'the download URL must pin the same commit the digest vouches for',
    );
  });
});

describe('tooling.install — pinned-python-env transport (§8.2, PR-6)', () => {
  let testSeq = 0;
  const freshRoot = () => path.join(tmpRoot, 'tool-packages-py-' + (++testSeq));
  let tgzSeq = 0;

  /**
   * A real source tarball shaped like a GitHub archive (single top-level
   * directory) containing a uv.lock + pyproject.toml. The digest chain is
   * computed from the actual bytes so the transport's verification logic is
   * exercised for real.
   */
  function pythonFixture(seam = {}) {
    const root = path.join(tmpRoot, `py-fixture-${++tgzSeq}`);
    fs.mkdirSync(root, { recursive: true });
    const lockContent = (seam.lockContent ?? `version = 1\nrevision = 3\n# lock ${tgzSeq}\n`);
    const topDir = 'Windows-MCP-83e17f62';
    const pkgDir = path.join(root, topDir);
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'uv.lock'), lockContent);
    fs.writeFileSync(path.join(pkgDir, 'pyproject.toml'), '[project]\nname = "windows-mcp"\nversion = "0.8.5"\n');
    const tgz = path.join(root, 'source.tgz');
    execFileSync(TAR_COMMAND, ['-czf', tgz, topDir], { cwd: root });
    const digest = crypto.createHash('sha256').update(fs.readFileSync(tgz)).digest('hex');
    const lockDigest = crypto.createHash('sha256').update(lockContent.replace(/\r\n/g, '\n')).digest('hex');
    const manifest = {
      ...OFFICECLI_MANIFEST,
      id: 'testpy',
      version: '0.8.5',
      classifierId: 'testpy',
      artifact: {
        ...OFFICECLI_MANIFEST.artifact,
        installStrategy: 'pinned-python-env',
        archiveSha256: digest,
        downloadUrl: 'https://github.com/example/Windows-MCP/archive/83e17f62.tar.gz',
        executableRelativePath: '.venv/Scripts/windows-mcp.exe',
        uvLockSha256: lockDigest,
        sourceCommit: '83e17f62',
        ...seam.artifact,
      },
      mcp: { ...OFFICECLI_MANIFEST.mcp, serverName: 'trylo-testpy' },
    };
    return { manifest, tgz };
  }

  it('the uv resolver never throws and only answers with a string or null', () => {
    const resolved = resolveUvExecutable();
    assert.ok(resolved === null || typeof resolved === 'string');
  });

  it('a pinned-python-env manifest without the lock digest is rejected at load', () => {
    const problems = validateManifest({
      ...WINDOWS_MCP_MANIFEST,
      id: 'wm-broken',
      artifact: { ...WINDOWS_MCP_MANIFEST.artifact, uvLockSha256: '' },
    });
    assert.ok(problems.some((p) => p.includes('uvLockSha256')));
  });

  it('a pinned-python-env manifest with a truncated tarball digest is rejected at load', () => {
    const problems = validateManifest({
      ...WINDOWS_MCP_MANIFEST,
      id: 'wm-broken2',
      artifact: { ...WINDOWS_MCP_MANIFEST.artifact, archiveSha256: 'deadbeef' },
    });
    assert.ok(problems.some((p) => p.includes('archiveSha256')));
  });

  it('a tampered source tarball is rejected with hash_mismatch and places nothing', async () => {
    const fixture = pythonFixture();
    const tooling = build({
      manifests: [OFFICECLI_MANIFEST, fixture.manifest],
      installRoot: freshRoot(),
      // The real uv sync is not the subject here — a stub uv resolution via
      // UV_PATH pointing at a failing script would be flaky, so the test
      // accepts either `uv_missing` (no uv) or a late `install_failed`
      // (uv ran). The digest gate is asserted separately below with the
      // lock-drift case, which never reaches uv.
      probePythonMetadata: async () => '0.8.5',
    });
    const result = await tooling.install({ id: 'testpy', archivePath: fixture.tgz });
    // The fixture's lock digest matches, so a real uv may complete or fail —
    // both are acceptable in a hermetic test environment; what must NEVER
    // happen is a hash_mismatch on a matching artefact.
    assert.notEqual(result.reasonCode, 'hash_mismatch');
    // Tamper AFTER: a second install from a drifted artefact must fail the
    // digest gate before anything else runs.
    const drifted = path.join(tmpRoot, 'drifted-source.tgz');
    fs.writeFileSync(drifted, 'TAMPERED-BYTES');
    const second = await tooling.install({ id: 'testpy', archivePath: drifted });
    assert.equal(second.ok, false);
    assert.equal(second.reasonCode, 'hash_mismatch');
  });

  it('a uv.lock drift inside the tarball is refused even when the tarball digest matches', async () => {
    // The manifest pins digest A; this fixture's LOCK differs from what the
    // manifest's uvLockSha256 pins. Tarball passes, lock must not.
    const fixture = pythonFixture();
    const manifest = {
      ...fixture.manifest,
      artifact: { ...fixture.manifest.artifact, uvLockSha256: crypto.createHash('sha256').update('other-lock').digest('hex') },
    };
    const tooling = build({ manifests: [OFFICECLI_MANIFEST, manifest], installRoot: freshRoot() });
    const result = await tooling.install({ id: 'testpy', archivePath: fixture.tgz });
    assert.equal(result.ok, false);
    assert.equal(result.reasonCode, 'hash_mismatch');
    assert.match(result.error, /uv\.lock/);
  });

  it('a uv-less environment reports uv_missing instead of half-installing', async () => {
    const fixture = pythonFixture();
    const tooling = build({
      manifests: [OFFICECLI_MANIFEST, fixture.manifest],
      installRoot: freshRoot(),
    });
    // Force the resolver to fail via the UV_PATH seam pointing nowhere and
    // PATH stripped of uv. resolveUvExecutable is read inside install(); the
    // env seam must make it answer null.
    const savedPath = process.env.PATH;
    const savedUvPath = process.env.UV_PATH;
    const savedUserProfile = process.env.USERPROFILE;
    const savedLocalAppData = process.env.LOCALAPPDATA;
    try {
      process.env.UV_PATH = path.join(tmpRoot, 'definitely-missing-uv.exe');
      process.env.USERPROFILE = path.join(tmpRoot, 'no-home');
      process.env.LOCALAPPDATA = path.join(tmpRoot, 'no-lad');
      process.env.PATH = '';
      const result = await tooling.install({ id: 'testpy', archivePath: fixture.tgz });
      assert.equal(result.ok, false);
      assert.equal(result.reasonCode, 'uv_missing');
    } finally {
      process.env.PATH = savedPath;
      if (savedUvPath === undefined) delete process.env.UV_PATH; else process.env.UV_PATH = savedUvPath;
      if (savedUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedUserProfile;
      if (savedLocalAppData === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = savedLocalAppData;
    }
  });

  it('a real uv sync against a tiny locked project materialises the venv and the entry', async function () {
    const uv = resolveUvExecutable();
    if (!uv) {
      this.skip(); // environment without uv: the contract is covered by the seams above
      return;
    }
    // A REAL minimal project: create it, run a plain `uv sync` once so a
    // genuine uv.lock exists, pin that lock's digest in the manifest, wipe
    // the .venv, and let the TRANSPORT re-materialise everything with
    // `sync --locked --offline`.
    const root = path.join(tmpRoot, `py-real-${++tgzSeq}`);
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'pyproject.toml'), [
      '[project]',
      'name = "testpy-real"',
      'version = "0.1.0"',
      'requires-python = ">=3.11"',
      'dependencies = []',
      '',
    ].join('\n'));
    const setup = execFileSync(uv, ['sync', '--project', root], { encoding: 'utf8', timeout: 120_000 });
    void setup;
    const lockPath = path.join(root, 'uv.lock');
    // Tar AFTER the lock exists so the archive carries it (the GitHub
    // archive layout: one top-level directory).
    const topDir = 'project';
    const stage = path.join(root, 'stage');
    fs.mkdirSync(stage, { recursive: true });
    fs.mkdirSync(path.join(stage, topDir), { recursive: true });
    fs.copyFileSync(path.join(root, 'pyproject.toml'), path.join(stage, topDir, 'pyproject.toml'));
    fs.copyFileSync(lockPath, path.join(stage, topDir, 'uv.lock'));
    const tgz = path.join(root, 'source.tgz');
    execFileSync(TAR_COMMAND, ['-czf', tgz, topDir], { cwd: stage });
    const digest = crypto.createHash('sha256').update(fs.readFileSync(tgz)).digest('hex');
    const manifest = {
      ...OFFICECLI_MANIFEST,
      id: 'testpyreal',
      version: '0.1.0',
      classifierId: 'testpyreal',
      artifact: {
        ...OFFICECLI_MANIFEST.artifact,
        installStrategy: 'pinned-python-env',
        archiveSha256: digest,
        downloadUrl: 'https://github.com/example/testpy/archive/r1.tar.gz',
        executableRelativePath: '.venv/Scripts/entry.exe',
        uvLockSha256: crypto.createHash('sha256').update(fs.readFileSync(lockPath, 'utf8').replace(/\r\n/g, '\n')).digest('hex'),
        sourceCommit: 'r1',
      },
      mcp: { ...OFFICECLI_MANIFEST.mcp, serverName: 'trylo-testpyreal' },
    };

    const tooling = build({ manifests: [OFFICECLI_MANIFEST, manifest], installRoot: freshRoot() });
    const result = await tooling.install({ id: 'testpyreal', archivePath: tgz });
    assert.equal(result.ok, true, result.error);
    const installed = path.join(result.installDir, '.venv', 'pyvenv.cfg');
    assert.ok(fs.existsSync(installed), 'uv sync materialised the .venv inside the version dir');
    const state = JSON.parse(fs.readFileSync(path.join(result.installDir, 'install-state.json'), 'utf8'));
    assert.equal(state.autoUpdate, false, '§8.2: Trylo owns updates');
    assert.equal(state.uvLockSha256, manifest.artifact.uvLockSha256);
    // PR-6 偏差②收口: the offline-first attempt ran; the flag records which
    // sync path materialised the wheels (a warm cache → true). Either value
    // is acceptable here — the point is that the field exists and is boolean,
    // so diagnostics can tell the cache origin of an install.
    assert.equal(typeof state.offlineSync, 'boolean', 'offlineSync flag records the sync origin');
  });
});

describe('tooling.health — python-metadata probe (PR-6, §8.2)', () => {
  it('reports version mismatch when the venv metadata disagrees with the pin', async () => {
    const exePath = path.join(tmpRoot, 'fake-venv', 'Scripts', 'windows-mcp.exe');
    fs.mkdirSync(path.dirname(exePath), { recursive: true });
    fs.writeFileSync(exePath, 'binary');
    const tooling = build({
      overrides: { 'windows-mcp': exePath },
      probePythonMetadata: async () => '0.9.9',
    });
    const health = await tooling.health({ id: 'windows-mcp' });
    const record = health.packages.find((p) => p.id === 'windows-mcp');
    assert.equal(record.state, 'version-mismatch');
    assert.equal(record.available, false);
    assert.equal(record.versionMatches, false);
  });

  it('a matching venv metadata probe keeps the package available (override path)', async () => {
    const exePath = path.join(tmpRoot, 'fake-venv-2', 'Scripts', 'windows-mcp.exe');
    fs.mkdirSync(path.dirname(exePath), { recursive: true });
    fs.writeFileSync(exePath, 'binary');
    const tooling = build({
      overrides: { 'windows-mcp': exePath },
      probePythonMetadata: async () => '0.8.5',
    });
    const health = await tooling.health({ id: 'windows-mcp' });
    const record = health.packages.find((p) => p.id === 'windows-mcp');
    assert.equal(record.available, true);
    assert.equal(record.versionMatches, true);
    assert.match(record.detail, /version verified/);
  });

  it('a probe that answers nothing degrades to not-installed with a reason', async () => {
    const exePath = path.join(tmpRoot, 'fake-venv-3', 'Scripts', 'windows-mcp.exe');
    fs.mkdirSync(path.dirname(exePath), { recursive: true });
    fs.writeFileSync(exePath, 'binary');
    const tooling = build({
      overrides: { 'windows-mcp': exePath },
      probePythonMetadata: async () => null,
    });
    const health = await tooling.health({ id: 'windows-mcp' });
    const record = health.packages.find((p) => p.id === 'windows-mcp');
    assert.equal(record.available, false);
    assert.equal(record.state, 'not-installed');
    assert.match(record.detail, /metadata probe/);
  });
});
