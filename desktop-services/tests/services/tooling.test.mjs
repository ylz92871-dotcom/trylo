// Trylo Desktop Services — tooling domain contract tests.
//
// Spec TRYLO-CORE-AGENT-TOOL-EXTENSION-TECHNICAL-SPEC §3 / §4 / §14.1.
// These pin the invariants that make a tool package SAFE to add and safe to
// remove: pinned versions, explicit composition, honest degradation, stable
// content-addressed config paths, and an `ask` rule for every audited server.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { after, before, describe, it } from 'node:test';

import { createToolingServices } from '../../src/tooling/index.mjs';
import { TAR_COMMAND, resolveUvExecutable } from '../../src/tooling/tool-package-manager.mjs';
import { createToolResultCache } from '../../src/tooling/tool-result-cache.mjs';
import { createToolCatalog, validateManifest } from '../../src/tooling/tool-catalog.mjs';
import { OFFICECLI_MANIFEST } from '../../src/tooling/manifests/officecli.mjs';
import { PLAYWRIGHT_MANIFEST } from '../../src/tooling/manifests/playwright.mjs';
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
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'trylo-tooling-'));
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

/** A Hermes adapter stub: one server, like the vendored `normal` profile. */
function hermesStub(overrides = {}) {
  return {
    mcpArgs() {
      return {
        ok: true,
        arg: ['--mcp-config', '{ "mcpServers": { "trylo-hermes-capabilities": { "command": "python" } } }'],
        warning: null,
        configPath: null,
        ...overrides,
      };
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
      // The fake binaries are not executables, so the version probe is
      // injected. `version` is what a healthy pinned binary would report.
      probe: overrides.probe ?? (async () => '1.0.145'),
      ...(overrides.overrides ? { overrides: overrides.overrides } : {}),
      ...(overrides.manifests ? { manifests: overrides.manifests } : {}),
      ...(overrides.download ? { download: overrides.download } : {}),
    },
  });
}

describe('tool catalog', () => {
  it('ships the audited manifests and rejects none of them', () => {
    const catalog = createToolCatalog();
    assert.deepEqual(
      catalog.list().map((m) => m.id).sort(),
      [
        // CAD/EDA adapters (TRYLO-CAD-EDA-TOOL-ADAPTER §5)
        'autocad-mcp',
        'blender-mcp',
        // Core four (spec §3)
        'chrome-devtools',
        'freecad-mcp',
        'jlceda-mcp',
        'kicad-mcp',
        'officecli',
        'playwright',
        'solidworks-mcp',
        'windows-mcp',
      ],
    );
    assert.deepEqual(catalog.rejected(), []);
  });

  it('rejects a manifest that pins "latest" (spec §16.4)', () => {
    const problems = validateManifest({ ...OFFICECLI_MANIFEST, version: 'latest' });
    assert.ok(problems.some((p) => p.includes('never "latest"')));
  });

  it('rejects a non-stdio transport (P0 allows local stdio only)', () => {
    const manifest = {
      ...OFFICECLI_MANIFEST,
      mcp: { ...OFFICECLI_MANIFEST.mcp, transport: 'http' },
    };
    const problems = validateManifest(manifest);
    assert.ok(problems.some((p) => p.includes('stdio')));
  });

  it('rejects a secret-looking env key (secrets are injected at runtime)', () => {
    const manifest = {
      ...OFFICECLI_MANIFEST,
      mcp: { ...OFFICECLI_MANIFEST.mcp, env: { API_TOKEN: 'x' } },
    };
    const problems = validateManifest(manifest);
    assert.ok(problems.some((p) => p.includes('secret')));
  });

  it('rejects a duplicate MCP server name', () => {
    const clone = { ...OFFICECLI_MANIFEST, id: 'officecli-clone' };
    const catalog = createToolCatalog({
      manifests: [OFFICECLI_MANIFEST, clone],
    });
    assert.equal(catalog.list().length, 1);
    assert.ok(catalog.rejected().some((r) => r.id === 'officecli-clone'));
  });
});

describe('tooling.resolveProfile', () => {
  it('code.core.v1 keeps Hermes and adds no tool package', async () => {
    const tooling = build();
    const resolved = await tooling.resolveProfile({
      surface: 'code',
      requestedProfileId: 'code.core.v1',
      projectRoot: tmpRoot,
      conversationId: 'c1',
    });
    assert.equal(resolved.ok, true);
    assert.equal(resolved.profileId, 'code.core.v1');
    assert.deepEqual(resolved.serverNames, ['trylo-hermes-capabilities']);
    // §4.3: Code keeps reading the user's own MCP servers — no strict flag.
    assert.equal(resolved.strictMcpConfig, false);
    assert.ok(!resolved.cliArgs.includes('--strict-mcp-config'));
  });

  it('work.core.v1 is strict and never reuses the Code argv (spec §4.3)', async () => {
    const tooling = build();
    const resolved = await tooling.resolveProfile({
      surface: 'work',
      projectRoot: tmpRoot,
      conversationId: 'c1',
    });
    assert.equal(resolved.ok, true);
    assert.equal(resolved.profileId, 'work.core.v1');
    assert.equal(resolved.strictMcpConfig, true);
    assert.ok(resolved.cliArgs.includes('--strict-mcp-config'));
  });

  it('refuses a profile that belongs to the other surface', async () => {
    const tooling = build();
    const resolved = await tooling.resolveProfile({
      surface: 'code',
      requestedProfileId: 'work.core.v1',
      projectRoot: tmpRoot,
      conversationId: 'c1',
    });
    assert.equal(resolved.ok, false);
    assert.equal(resolved.reasonCode, 'profile_surface_mismatch');
  });

  it('refuses an unknown profile instead of silently falling back', async () => {
    const tooling = build();
    const resolved = await tooling.resolveProfile({
      surface: 'work',
      requestedProfileId: 'work.does-not-exist.v1',
      projectRoot: tmpRoot,
      conversationId: 'c1',
    });
    assert.equal(resolved.ok, false);
    assert.equal(resolved.reasonCode, 'unknown_profile');
  });

  it('reports a missing package as an unavailable capability, not as a failure (§4.4)', async () => {
    const tooling = build();
    const resolved = await tooling.resolveProfile({
      surface: 'work',
      projectRoot: tmpRoot,
      conversationId: 'c1',
    });
    assert.equal(resolved.ok, true);
    const ids = resolved.unavailableCapabilities.map((c) => c.id);
    assert.ok(ids.includes('officecli'));
    assert.ok(ids.includes('playwright'));
    // The run still carries a usable config — Hermes is intact.
    assert.deepEqual(resolved.serverNames, ['trylo-hermes-capabilities']);
    assert.ok(resolved.mcpConfigPath);
  });

  it('every audited server is forced through "ask" — even when absent (§6.1)', async () => {
    const tooling = build();
    const resolved = await tooling.resolveProfile({
      surface: 'work',
      projectRoot: tmpRoot,
      conversationId: 'c1',
    });
    const settings = JSON.parse(fs.readFileSync(resolved.permissionSettingsPath, 'utf8'));
    assert.deepEqual(settings.permissions.ask.sort(), [
      'mcp__trylo-autocad__*',
      'mcp__trylo-blender__*',
      'mcp__trylo-browser__*',
      'mcp__trylo-chrome__*',
      'mcp__trylo-freecad__*',
      'mcp__trylo-jlceda__*',
      'mcp__trylo-kicad__*',
      'mcp__trylo-office__*',
      'mcp__trylo-solidworks__*',
      'mcp__trylo-windows__*',
    ]);
    // Nothing is pre-allowed: an allow rule would reach the model before the
    // host classifier ever sees the call (§6.1).
    assert.deepEqual(settings.permissions.deny, []);
  });

  it('writes both configs to content-addressed, stable paths (§9)', async () => {
    const tooling = build();
    const a = await tooling.resolveProfile({ surface: 'work', projectRoot: tmpRoot, conversationId: 'c1' });
    const b = await tooling.resolveProfile({ surface: 'work', projectRoot: tmpRoot, conversationId: 'c1' });
    assert.equal(a.mcpConfigPath, b.mcpConfigPath);
    assert.equal(a.mcpConfigHash, b.mcpConfigHash);
    assert.equal(a.permissionSettingsPath, b.permissionSettingsPath);
  });

  it('never embeds a secret or a "latest" reference in the written configs', async () => {
    const tooling = build();
    const resolved = await tooling.resolveProfile({ surface: 'work', projectRoot: tmpRoot, conversationId: 'c1' });
    for (const file of [resolved.mcpConfigPath, resolved.permissionSettingsPath]) {
      const text = fs.readFileSync(file, 'utf8');
      assert.ok(!/latest/i.test(text), `${file} must not reference latest`);
      assert.ok(!/sk-[a-z0-9]/i.test(text), `${file} must not carry a key`);
    }
  });
});

describe('tooling.resolveProfile with an available package', () => {
  it('injects OfficeCLI into work.core.v1 and keeps it out of code.core.v1', async () => {
    const exePath = path.join(tmpRoot, 'fake-officecli.exe');
    fs.writeFileSync(exePath, 'binary');
    // The dev override seam stands in for a pinned install; the profile
    // service is otherwise exercised end to end.
    const tooling = build({ overrides: { officecli: exePath } });

    const work = await tooling.resolveProfile({ surface: 'work', projectRoot: tmpRoot, conversationId: 'c1' });
    assert.equal(work.ok, true);
    assert.ok(work.serverNames.includes('trylo-office'));
    const mcp = JSON.parse(fs.readFileSync(work.mcpConfigPath, 'utf8'));
    assert.equal(mcp.mcpServers['trylo-office'].command, exePath);
    assert.deepEqual(mcp.mcpServers['trylo-office'].args, ['mcp']);

    const code = await tooling.resolveProfile({
      surface: 'code',
      requestedProfileId: 'code.core.v1',
      projectRoot: tmpRoot,
      conversationId: 'c1',
    });
    assert.ok(!code.serverNames.includes('trylo-office'));
    // The two surfaces must never land on the same config hash (§4.3).
    assert.notEqual(work.mcpConfigHash, code.mcpConfigHash);
  });

  it('a version mismatch degrades the package instead of shipping it (§4.4)', async () => {
    const exePath = path.join(tmpRoot, 'fake-officecli-2.exe');
    fs.writeFileSync(exePath, 'binary');
    const tooling = build({
      overrides: { officecli: exePath },
      // A binary that reports a version the pinned manifest does not allow.
      probe: async () => '9.9.9-drifted',
    });
    const resolved = await tooling.resolveProfile({ surface: 'work', projectRoot: tmpRoot, conversationId: 'c1' });
    assert.equal(resolved.ok, true);
    const office = resolved.packageHealth.find((p) => p.id === 'officecli');
    assert.equal(office.state, 'version-mismatch');
    assert.equal(office.available, false);
    assert.ok(!resolved.serverNames.includes('trylo-office'));
    assert.ok(
      resolved.unavailableCapabilities.some((c) => c.id === 'officecli' && c.reasonCode === 'version_mismatch'),
    );
  });
});

describe('tooling.health / listProfiles', () => {
  it('lists the stable profiles with their composition (§4.1)', () => {
    const tooling = build();
    const { profiles } = tooling.listProfiles();
    assert.deepEqual(profiles.map((p) => p.id).sort(), [
      'code.core.v1',
      'work.browser-debug.v1',
      'work.cad.v1',
      'work.core.v1',
    ]);
    // 办公基底 (rev 2): office + browser + desktop control in one default.
    const core = profiles.find((p) => p.id === 'work.core.v1');
    assert.deepEqual(core.packageIds, ['officecli', 'playwright', 'windows-mcp']);
  });

  it('health reports every catalog package, never throwing', async () => {
    const tooling = build();
    const health = await tooling.health({});
    assert.equal(health.ok, true);
    assert.deepEqual(health.packages.map((p) => p.id).sort(), [
      'autocad-mcp',
      'blender-mcp',
      'chrome-devtools',
      'freecad-mcp',
      'jlceda-mcp',
      'kicad-mcp',
      'officecli',
      'playwright',
      'solidworks-mcp',
      'windows-mcp',
    ]);
    for (const record of health.packages) {
      assert.equal(record.protocol, 'not-checked', 'protocol health is owned by the CLI run, not the sidecar');
    }
  });
});

// ── PR-2: install transports (spec §8.2) ─────────────────────────────

/** A test manifest whose digest matches `content` exactly. */
function packageWithDigest(content, overrides = {}) {
  const digest = crypto.createHash('sha256').update(content).digest('hex');
  return {
    ...OFFICECLI_MANIFEST,
    id: 'testpkg',
    version: '9.9.9',
    classifierId: 'testpkg',
    artifact: {
      ...OFFICECLI_MANIFEST.artifact,
      archiveSha256: digest,
      downloadUrl: 'https://releases.example.invalid/testpkg/9.9.9/asset.exe',
      ...overrides,
    },
    mcp: { ...OFFICECLI_MANIFEST.mcp, serverName: 'trylo-testpkg' },
  };
}

describe('tooling.install — pinned artefact placement (§8.2, PR-1 surface kept)', () => {
  // A fresh root PER TEST: failure-path tests assert what a FAILED install
  // leaves behind, so no earlier success case may have created the dir.
  let testSeq = 0;
  const freshRoot = () => path.join(tmpRoot, 'tool-packages-install-' + (++testSeq));

  it('installs from a local artefact after digest verification', async () => {
    const content = 'fake-pinned-binary';
    const manifest = packageWithDigest(content);
    const localPath = path.join(tmpRoot, 'local-asset.exe');
    fs.writeFileSync(localPath, content);
    const tooling = build({ manifests: [OFFICECLI_MANIFEST, manifest], installRoot: freshRoot() });

    const result = await tooling.install({ id: 'testpkg', archivePath: localPath });
    assert.equal(result.ok, true);
    const exe = path.join(result.installDir, manifest.artifact.executableRelativePath);
    assert.equal(fs.readFileSync(exe, 'utf8'), content);
    const state = JSON.parse(fs.readFileSync(path.join(result.installDir, 'install-state.json'), 'utf8'));
    assert.equal(state.autoUpdate, false, '§8.2: Trylo owns updates');
    assert.equal(state.sha256, manifest.artifact.archiveSha256);
  });

  it('rejects a local artefact whose digest drifts, placing nothing', async () => {
    const manifest = packageWithDigest('fake-pinned-binary');
    const localPath = path.join(tmpRoot, 'drifted-asset.exe');
    fs.writeFileSync(localPath, 'TAMPERED');
    const installRoot = freshRoot();
    const tooling = build({ manifests: [OFFICECLI_MANIFEST, manifest], installRoot });

    const result = await tooling.install({ id: 'testpkg', archivePath: localPath });
    assert.equal(result.ok, false);
    assert.equal(result.reasonCode, 'hash_mismatch');
    assert.equal(result.actual, crypto.createHash('sha256').update('TAMPERED').digest('hex'));
    assert.ok(!fs.existsSync(path.join(installRoot, 'testpkg', '9.9.9')));
  });

  it('a corrupted-length manifest digest yields hash_mismatch, not a crash', async () => {
    // Guards the constant-time comparison path against length mismatch.
    const manifest = packageWithDigest('fake-pinned-binary');
    manifest.artifact.archiveSha256 = 'deadbeef'; // wrong length for sha256 hex
    const localPath = path.join(tmpRoot, 'any-asset.exe');
    fs.writeFileSync(localPath, 'fake-pinned-binary');
    const tooling = build({ manifests: [OFFICECLI_MANIFEST, manifest] });

    const result = await tooling.install({ id: 'testpkg', archivePath: localPath });
    assert.equal(result.ok, false);
    assert.equal(result.reasonCode, 'hash_mismatch');
  });

  it('a pinned-python-env manifest without uv.lock data fails with a reason (PR-6 covers the real transport)', async () => {
    // The PR-6 transport now exists; this manifest only lacks the pinned
    // lock digest, so it must be REJECTED BY THE CATALOG, never half-installed.
    const manifest = packageWithDigest('x', { installStrategy: 'pinned-python-env' });
    const problems = validateManifest(manifest);
    assert.ok(problems.some((p) => p.includes('uvLockSha256')));
    const tooling = build({ manifests: [OFFICECLI_MANIFEST, manifest], installRoot: freshRoot() });
    const result = await tooling.install({ id: 'testpkg' });
    assert.equal(result.ok, false);
    assert.equal(result.reasonCode, 'unknown_package', 'the catalog refused the manifest, so install cannot resolve it');
  });
});

// ── PR-3: pinned-npm transport (spec §8.2 固定 npm 包版本与完整性 hash) ──

describe('tooling.install — pinned-npm transport (§8.2, PR-3)', () => {
  let testSeq = 0;
  const freshRoot = () => path.join(tmpRoot, 'tool-packages-npm-' + (++testSeq));
  let tgzSeq = 0;

  /**
   * Build a real .tgz (via the OS tar, exactly what the transport shells
   * out to) whose single root is `package/`, and return { path, sha256 }.
   */
  function makeTarball(rootDir, files) {
    const pkgDir = path.join(rootDir, 'package');
    fs.mkdirSync(pkgDir, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      const target = path.join(pkgDir, name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    }
    const tgz = path.join(rootDir, `pkg-${++tgzSeq}.tgz`);
    execFileSync(TAR_COMMAND, ['-czf', tgz, 'package'], { cwd: rootDir });
    const digest = crypto.createHash('sha256').update(fs.readFileSync(tgz)).digest('hex');
    return { path: tgz, digest };
  }

  /** A valid pinned-npm manifest whose closure is two tiny real tarballs. */
  function npmManifestWithTarballs(seam = {}) {
    const root = path.join(tmpRoot, `npm-fixture-${++tgzSeq}`);
    fs.mkdirSync(root, { recursive: true });
    const entry = makeTarball(path.join(root, 'entry'), {
      'cli.js': seam.entryContent ?? '#!/usr/bin/env node\nconsole.log("Version 1.0.0");\n',
      'package.json': '{"name":"@playwright/mcp","version":"1.0.0"}',
    });
    const dep = makeTarball(path.join(root, 'dep'), {
      'index.js': 'module.exports = 1;\n',
      'package.json': '{"name":"dep","version":"1.0.0"}',
    });
    const manifest = {
      ...OFFICECLI_MANIFEST,
      id: 'testnpm',
      version: '1.0.0',
      classifierId: 'testnpm',
      runtimeDirName: 'browser',
      artifact: {
        ...OFFICECLI_MANIFEST.artifact,
        installStrategy: 'pinned-npm',
        runner: 'node',
        packageName: '@playwright/mcp',
        archiveSha256: entry.digest,
        downloadUrl: 'https://registry.example.invalid/@playwright/mcp/-/mcp-1.0.0.tgz',
        executableRelativePath: 'node_modules/@playwright/mcp/cli.js',
        npmDependencies: [
          { name: 'dep', tarballUrl: 'https://registry.example.invalid/dep/-/dep-1.0.0.tgz', sha256: dep.digest },
        ],
        ...seam.artifact,
      },
      mcp: { ...OFFICECLI_MANIFEST.mcp, serverName: 'trylo-testnpm' },
    };
    const tarballs = new Map([
      [manifest.artifact.downloadUrl, entry.path],
      ['https://registry.example.invalid/dep/-/dep-1.0.0.tgz', dep.path],
    ]);
    return { manifest, tarballs, entryPath: entry.path, depPath: dep.path };
  }

  function buildNpm({ manifest, tarballs }, seam = {}) {
    const installRoot = freshRoot();
    const downloadCalls = [];
    const tooling = build({
      manifests: [OFFICECLI_MANIFEST, manifest],
      installRoot,
      probe: async () => 'Version 1.0.0',
      download: async (url, destPath) => {
        downloadCalls.push(url);
        const source = tarballs.get(url);
        if (!source) throw new Error(`unexpected url ${url}`);
        if (seam.swapDependencyBytes && url.endsWith('dep-1.0.0.tgz')) {
          fs.writeFileSync(destPath, 'TAMPERED-DEP');
          return;
        }
        fs.copyFileSync(source, destPath);
      },
    });
    return { tooling, installRoot, downloadCalls };
  }

  it('installs the pinned closure: entry + every dependency extracted and digest-verified', async () => {
    const fixture = npmManifestWithTarballs();
    const { tooling, downloadCalls, installRoot } = buildNpm(fixture);
    const result = await tooling.install({ id: 'testnpm' });
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(downloadCalls.sort(), [
      'https://registry.example.invalid/@playwright/mcp/-/mcp-1.0.0.tgz',
      'https://registry.example.invalid/dep/-/dep-1.0.0.tgz',
    ]);
    const entry = path.join(result.installDir, 'node_modules', '@playwright', 'mcp', 'cli.js');
    const dep = path.join(result.installDir, 'node_modules', 'dep', 'index.js');
    assert.ok(fs.existsSync(entry), 'entry package extracted at node_modules/@playwright/mcp');
    assert.ok(fs.existsSync(dep), 'dependency extracted at node_modules/dep');
    const state = JSON.parse(fs.readFileSync(path.join(result.installDir, 'install-state.json'), 'utf8'));
    assert.equal(state.autoUpdate, false, '§8.2: Trylo owns updates');
    assert.equal(state.sha256, fixture.manifest.artifact.archiveSha256);
    assert.deepEqual(Object.keys(state.dependencies), ['dep']);
    // No staging leftovers.
    const downloads = path.join(installRoot, '.downloads');
    assert.ok(!fs.existsSync(downloads) || fs.readdirSync(downloads).length === 0);
  });

  it('a tampered dependency is rejected with hash_mismatch and places nothing', async () => {
    const fixture = npmManifestWithTarballs();
    const { tooling, installRoot } = buildNpm(fixture, { swapDependencyBytes: true });
    const result = await tooling.install({ id: 'testnpm' });
    assert.equal(result.ok, false);
    assert.equal(result.reasonCode, 'hash_mismatch');
    assert.ok(!fs.existsSync(path.join(installRoot, 'testnpm', '1.0.0')), 'no half-installed version dir');
  });

  it('a re-install replaces the version directory wholesale (never merges)', async () => {
    const fixture = npmManifestWithTarballs();
    const { tooling } = buildNpm(fixture);
    const first = await tooling.install({ id: 'testnpm' });
    assert.equal(first.ok, true);
    // A stale marker inside the version dir must not survive a re-install.
    fs.writeFileSync(path.join(first.installDir, 'node_modules', 'STALE.txt'), 'stale');
    const second = await tooling.install({ id: 'testnpm' });
    assert.equal(second.ok, true);
    // The old tree is renamed aside (never rm'd in place — EBUSY while a
    // live MCP process holds handles) and the fresh tree renamed in, so a
    // merged-in STALE.txt can never survive (2026-09-03 acceptance). The
    // `.stale` sweep itself is best-effort: an antivirus scan may keep the
    // renamed tree alive until the next install, so it is not asserted here.
    assert.ok(!fs.existsSync(path.join(second.installDir, 'node_modules', 'STALE.txt')));
    assert.ok(fs.existsSync(path.join(second.installDir, 'node_modules', '@playwright', 'mcp', 'cli.js')));
  });

  it('a pinned-npm manifest missing its runner/package/closure is rejected at load', async () => {
    const fixture = npmManifestWithTarballs();
    const broken = JSON.parse(JSON.stringify(fixture.manifest));
    delete broken.artifact.runner;
    const tooling = build({ manifests: [OFFICECLI_MANIFEST, broken], installRoot: freshRoot() });
    // The catalog rejected the manifest, so the install answers unknown_package.
    const result = await tooling.install({ id: 'testnpm' });
    assert.equal(result.ok, false);
    assert.equal(result.reasonCode, 'unknown_package');
  });

  it('install/uninstall invalidate the health cache (a fresh install is never reported stale)', async () => {
    const fixture = npmManifestWithTarballs();
    const { tooling } = buildNpm(fixture);
    const before = await tooling.health({ id: 'testnpm' });
    assert.equal(before.packages[0].state, 'not-installed');
    const installed = await tooling.install({ id: 'testnpm' });
    assert.equal(installed.ok, true, installed.error);
    const afterInstall = await tooling.health({ id: 'testnpm' });
    assert.equal(afterInstall.packages[0].state, 'installed', 'the health cache must not outlive an install');
    assert.equal(afterInstall.packages[0].versionMatches, true);
    const removed = await tooling.uninstall({ id: 'testnpm' });
    assert.equal(removed.ok, true);
    const afterUninstall = await tooling.health({ id: 'testnpm' });
    assert.equal(afterUninstall.packages[0].state, 'not-installed', 'the health cache must not outlive an uninstall');
  });
});

describe('tooling.install — network release transport (§8.2, PR-2)', () => {
  let testSeq = 0;
  const freshRoot = () => path.join(tmpRoot, 'tool-packages-network-' + (++testSeq));

  function buildWithDownload(seam = {}) {
    const content = 'fake-pinned-binary';
    const manifest = packageWithDigest(content);
    const downloadCalls = [];
    const installRoot = freshRoot();
    const tooling = build({
      manifests: [OFFICECLI_MANIFEST, manifest],
      installRoot,
      probe: async () => '9.9.9',
      download: async (url, destPath) => {
        downloadCalls.push({ url, destPath });
        if (seam.failDownload) throw new Error('network unreachable');
        fs.writeFileSync(destPath, seam.downloadedContent ?? content);
      },
    });
    return { tooling, content, manifest, downloadCalls, installRoot };
  }

  it('downloads the pinned URL, verifies the digest, and places the binary', async () => {
    const { tooling, content, manifest, downloadCalls, installRoot } = buildWithDownload();
    const result = await tooling.install({ id: 'testpkg' });
    assert.equal(result.ok, true);
    assert.equal(downloadCalls.length, 1);
    assert.equal(downloadCalls[0].url, manifest.artifact.downloadUrl);
    const exe = path.join(result.installDir, manifest.artifact.executableRelativePath);
    assert.equal(fs.readFileSync(exe, 'utf8'), content);
    const state = JSON.parse(fs.readFileSync(path.join(result.installDir, 'install-state.json'), 'utf8'));
    assert.equal(state.autoUpdate, false);
    // The scratch download directory holds no leftovers after placement.
    const scratch = path.join(installRoot, '.downloads');
    assert.ok(!fs.existsSync(scratch) || fs.readdirSync(scratch).length === 0);
  });

  it('a tampered download is rejected with hash_mismatch and leaves nothing behind', async () => {
    const { tooling, installRoot } = buildWithDownload({ downloadedContent: 'TAMPERED-BYTES' });
    const result = await tooling.install({ id: 'testpkg' });
    assert.equal(result.ok, false);
    assert.equal(result.reasonCode, 'hash_mismatch');
    assert.ok(!fs.existsSync(path.join(installRoot, 'testpkg', '9.9.9')));
    const scratch = path.join(installRoot, '.downloads');
    assert.ok(!fs.existsSync(scratch) || fs.readdirSync(scratch).length === 0);
  });

  it('a failed download reports download_failed and leaves nothing behind', async () => {
    const { tooling, installRoot } = buildWithDownload({ failDownload: true });
    const result = await tooling.install({ id: 'testpkg' });
    assert.equal(result.ok, false);
    assert.equal(result.reasonCode, 'download_failed');
    assert.ok(!fs.existsSync(path.join(installRoot, 'testpkg', '9.9.9')));
  });

  it('a manifest without downloadUrl answers no_download_url instead of guessing', async () => {
    const content = 'fake-pinned-binary';
    const manifest = packageWithDigest(content, { downloadUrl: undefined });
    const tooling = build({ manifests: [OFFICECLI_MANIFEST, manifest], installRoot: freshRoot() });
    const result = await tooling.install({ id: 'testpkg' });
    assert.equal(result.ok, false);
    assert.equal(result.reasonCode, 'no_download_url');
  });

  it('the shipped officecli manifest pins an https download URL', () => {
    assert.ok(OFFICECLI_MANIFEST.artifact.downloadUrl.startsWith('https://'));
    assert.ok(OFFICECLI_MANIFEST.artifact.downloadUrl.includes('/v1.0.145/'), 'URL must pin the release tag');
  });
});

describe('manifest validation — downloadUrl (PR-2)', () => {
  it('accepts a well-formed https downloadUrl', () => {
    const problems = validateManifest({
      ...OFFICECLI_MANIFEST,
      artifact: { ...OFFICECLI_MANIFEST.artifact, downloadUrl: 'https://example.invalid/a.exe' },
    });
    assert.deepEqual(problems, []);
  });

  it('rejects an http:// downloadUrl (a MITM could swap the digest\u2019s bytes)', () => {
    const problems = validateManifest({
      ...OFFICECLI_MANIFEST,
      artifact: { ...OFFICECLI_MANIFEST.artifact, downloadUrl: 'http://example.invalid/a.exe' },
    });
    assert.ok(problems.some((p) => p.includes('https://')));
  });

  it('rejects a "latest" downloadUrl', () => {
    const problems = validateManifest({
      ...OFFICECLI_MANIFEST,
      artifact: { ...OFFICECLI_MANIFEST.artifact, downloadUrl: 'https://example.invalid/latest/a.exe' },
    });
    assert.ok(problems.some((p) => p.includes('latest')));
  });
});

// ── PR-3: playwright manifest + profile composition + artifact promoter ──

describe('playwright manifest (PR-3, §8.2/§10.2)', () => {
  it('passes validation and pins the full contract', () => {
    const problems = validateManifest(PLAYWRIGHT_MANIFEST);
    assert.deepEqual(problems, [], problems.join('; '));
    assert.equal(PLAYWRIGHT_MANIFEST.version, '0.0.79');
    assert.equal(PLAYWRIGHT_MANIFEST.mcp.serverName, 'trylo-browser');
    assert.equal(PLAYWRIGHT_MANIFEST.artifact.runner, 'node');
    assert.ok(PLAYWRIGHT_MANIFEST.mcp.expectedTools.length > 0, 'PR-3 asserts the exact pinned tool set');
    assert.equal(PLAYWRIGHT_MANIFEST.runtimeDirName, 'browser');
    assert.equal(PLAYWRIGHT_MANIFEST.mcp.args.includes('{runtimeDir}'), true, 'outputDir is the per-run runtime dir');
  });

  it('rejects a pinned-npm manifest with a floating dependency URL', () => {
    const broken = JSON.parse(JSON.stringify(PLAYWRIGHT_MANIFEST));
    broken.id = 'playwright-broken';
    broken.mcp.serverName = 'trylo-browser-broken';
    broken.artifact.npmDependencies[0].tarballUrl = 'https://registry.npmjs.org/playwright/-/playwright-latest.tgz';
    const problems = validateManifest(broken);
    assert.ok(problems.some((p) => p.includes('latest')));
  });

  it('rejects a pinned-npm manifest with a truncated dependency digest', () => {
    const broken = JSON.parse(JSON.stringify(PLAYWRIGHT_MANIFEST));
    broken.id = 'playwright-broken2';
    broken.mcp.serverName = 'trylo-browser-broken2';
    broken.artifact.npmDependencies[0].sha256 = 'deadbeef';
    const problems = validateManifest(broken);
    assert.ok(problems.some((p) => p.includes('sha256')));
  });
});

describe('profile composition with an installed playwright package (PR-3, §10.2)', () => {
  let testSeq = 0;
  function buildWithNodeRunner() {
    const installRoot = path.join(tmpRoot, 'pw-packages-' + (++testSeq));
    // Materialise the "installed" layout the transport produces: the entry
    // is a .js script inside the version directory.
    const entry = path.join(installRoot, 'playwright', PLAYWRIGHT_MANIFEST.version, 'node_modules', '@playwright', 'mcp', 'cli.js');
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.writeFileSync(entry, '#!/usr/bin/env node\n');
    const state = path.join(installRoot, 'playwright', PLAYWRIGHT_MANIFEST.version, 'install-state.json');
    fs.writeFileSync(state, JSON.stringify({ id: 'playwright', sha256: PLAYWRIGHT_MANIFEST.artifact.archiveSha256, autoUpdate: false }));
    const probeCalls = [];
    const tooling = createToolingServices({
      appDataDir: tmpRoot,
      sidecarsDir: tmpRoot,
      seam: {
        hermes: hermesStub(),
        installRoot,
        profilesRoot: path.join(tmpRoot, 'pw-profiles-' + testSeq),
        // Mirror the real probe: runner 'node' → node <entry> --version.
        probe: async (exe, _timeout, runner) => {
          probeCalls.push({ exe, runner });
          return 'Version 0.0.79';
        },
        // §3.3-7: the browser-body condition must not depend on the machine
        // running the tests — this suite pins the condition to ok (the
        // browser-condition suite owns the missing-browser behaviour).
        probeCondition: () => ({ ok: true, reasonCode: 'browser_ok', detail: 'test' }),
      },
    });
    return { tooling, probeCalls };
  }

  it('composes the browser server as node <entry> with the per-run outputDir', async () => {
    const { tooling } = buildWithNodeRunner();
    const projectRoot = path.join(tmpRoot, 'ws-pw');
    const resolved = await tooling.resolveProfile({ surface: 'work', projectRoot, conversationId: 'conv-pw' });
    assert.equal(resolved.ok, true, JSON.stringify(resolved.unavailableCapabilities ?? []));
    const server = resolved.mcpConfigPath ? JSON.parse(fs.readFileSync(resolved.mcpConfigPath, 'utf8')).mcpServers['trylo-browser'] : null;
    assert.ok(server, 'trylo-browser present in the composed mcp.json');
    // §8.2: command is the Node runtime; the entry path is the first argv.
    assert.equal(server.command, process.execPath);
    assert.match(server.args[0], /node_modules[\\/]@playwright[\\/]mcp[\\/]cli\.js$/);
    // §8.2: --isolated and the per-conversation runtime outputDir.
    const dirIdx = server.args.indexOf('--output-dir');
    assert.ok(dirIdx > 0, 'outputDir flag present');
    const expectedRuntime = path.join(projectRoot, '.trylo', 'runtime', 'browser', 'conv-pw');
    assert.equal(server.args[dirIdx + 1], expectedRuntime);
    assert.ok(fs.existsSync(expectedRuntime), 'the runtime dir is created by the resolve');
    // No --caps flag exists in the pinned build.
    assert.equal(server.args.includes('--caps'), false);
    // Health ran the version probe under node.
    const health = resolved.packageHealth.find((p) => p.id === 'playwright');
    assert.equal(health.available, true);
    assert.equal(health.versionMatches, true);
  });

  it('a not-installed playwright degrades to an unavailable capability (§4.4)', async () => {
    const tooling = createToolingServices({
      appDataDir: tmpRoot,
      sidecarsDir: tmpRoot,
      seam: {
        hermes: hermesStub(),
        installRoot: path.join(tmpRoot, 'pw-empty-' + (++testSeq)),
        profilesRoot: path.join(tmpRoot, 'pw-profiles-empty-' + testSeq),
        probe: async () => null,
      },
    });
    const resolved = await tooling.resolveProfile({ surface: 'work', projectRoot: tmpRoot, conversationId: 'conv-x' });
    assert.equal(resolved.ok, true);
    assert.ok(!resolved.serverNames.includes('trylo-browser'));
    assert.ok(resolved.unavailableCapabilities.some((c) => c.id === 'playwright'));
  });
});

describe('artifact promoter (PR-3, §6.5/§7.3)', () => {
  let testSeq = 0;
  function setup() {
    const projectRoot = path.join(tmpRoot, 'ws-promote-' + (++testSeq));
    const runtimeDir = path.join(projectRoot, '.trylo', 'runtime', 'browser', 'conv-1');
    fs.mkdirSync(path.join(runtimeDir, 'dl'), { recursive: true });
    fs.writeFileSync(path.join(runtimeDir, 'shot.png'), 'PNG-BYTES');
    fs.writeFileSync(path.join(runtimeDir, 'dl', 'report.pdf'), 'PDF-BYTES');
    const tooling = createToolingServices({ appDataDir: tmpRoot, sidecarsDir: tmpRoot, seam: { hermes: hermesStub() } });
    return { projectRoot, runtimeDir, tooling };
  }

  it('lists runtime artifacts of the conversation without touching .trylo/out', async () => {
    const { projectRoot, tooling } = setup();
    const list = await tooling.listRuntimeArtifacts({ projectRoot, conversationId: 'conv-1', packageId: 'playwright' });
    assert.equal(list.ok, true);
    const names = list.artifacts.map((a) => a.name).sort();
    assert.deepEqual(names, ['dl/report.pdf', 'shot.png']);
    assert.equal(fs.existsSync(path.join(projectRoot, '.trylo', 'out')), false);
  });

  it('promotes one artifact into .trylo/out (copy, not move) with a sha256', async () => {
    const { projectRoot, runtimeDir, tooling } = setup();
    const result = await tooling.promoteArtifact({ projectRoot, conversationId: 'conv-1', packageId: 'playwright', fileName: 'shot.png' });
    assert.equal(result.ok, true, result.error ?? result.reasonCode);
    const target = path.join(projectRoot, '.trylo', 'out', 'shot.png');
    assert.equal(fs.readFileSync(target, 'utf8'), 'PNG-BYTES');
    assert.equal(fs.readFileSync(path.join(runtimeDir, 'shot.png'), 'utf8'), 'PNG-BYTES', 'the temp copy survives');
    assert.match(result.sha256, /^[0-9a-f]{64}$/);
  });

  it('dedupes target names in .trylo/out (shot.png, shot-1.png, …)', async () => {
    const { projectRoot, tooling } = setup();
    await tooling.promoteArtifact({ projectRoot, conversationId: 'conv-1', packageId: 'playwright', fileName: 'shot.png' });
    const second = await tooling.promoteArtifact({ projectRoot, conversationId: 'conv-1', packageId: 'playwright', fileName: 'shot.png' });
    assert.equal(second.ok, true);
    assert.equal(path.basename(second.target), 'shot-1.png');
  });

  it('rejects path attacks and outside files without placing anything', async () => {
    const { projectRoot, tooling } = setup();
    fs.mkdirSync(path.join(projectRoot, 'private'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'private', 'secret.txt'), 'S');
    for (const fileName of ['../private/secret.txt', 'C:/Windows/win.ini', 'dl/../../secret.txt', '', 'CON.png', 'dl']) {
      const result = await tooling.promoteArtifact({ projectRoot, conversationId: 'conv-1', packageId: 'playwright', fileName });
      assert.equal(result.ok, false, `expected reject for ${JSON.stringify(fileName)}`);
      assert.equal(fs.existsSync(path.join(projectRoot, '.trylo', 'out')), false);
    }
  });

  it('a missing artifact answers artifact_missing', async () => {
    const { projectRoot, tooling } = setup();
    const result = await tooling.promoteArtifact({ projectRoot, conversationId: 'conv-1', packageId: 'playwright', fileName: 'nope.png' });
    assert.equal(result.ok, false);
    assert.equal(result.reasonCode, 'artifact_missing');
  });
});

// ── PR-4 (§7.1): BinaryRef tool-cache TTL sweeper ──────────────────────

describe('tooling.sweepToolCache — BinaryRef tool cache TTL (PR-4)', () => {
  function makeCacheRoot(label) {
    const appDataDir = fs.mkdtempSync(path.join(tmpRoot, `tool-cache-${label}-`));
    return { appDataDir, root: path.join(appDataDir, 'tool-cache') };
  }

  function touch(root, rel, ageMs) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, 'BLOB');
    const old = new Date(Date.now() - ageMs);
    fs.utimesSync(full, old, old);
  }

  it('removes entries older than the TTL and prunes empty fan-out dirs', async () => {
    const { appDataDir, root } = makeCacheRoot('sweep');
    touch(root, 'ab/abcd.png', 25 * 60 * 60 * 1000); // expired
    touch(root, 'ef/ef01.png', 0); // fresh
    const cache = createToolResultCache({ appDataDir });
    const stats = await cache.sweep();
    assert.equal(stats.ok, true);
    assert.equal(stats.removed, 1);
    assert.equal(fs.existsSync(path.join(root, 'ab', 'abcd.png')), false);
    assert.equal(fs.existsSync(path.join(root, 'ef', 'ef01.png')), true);
    assert.equal(fs.existsSync(path.join(root, 'ab')), false, 'empty fan-out dir pruned');
  });

  it('a symlinked entry is never followed out of the cache root', async () => {
    const { appDataDir, root } = makeCacheRoot('sym');
    const outside = path.join(appDataDir, 'outside');
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'KEEP');
    touch(root, 'ab/in.txt', 25 * 60 * 60 * 1000);
    // Windows: creating a symlink needs privileges — use a junction for a
    // directory; a file symlink requires admin, so assert on directory
    // links only (the walk skips non-directory non-file dirents anyway).
    try {
      fs.symlinkSync(outside, path.join(root, 'link'), 'junction');
    } catch {
      return; // environment without symlink/junction rights: skip
    }
    const cache = createToolResultCache({ appDataDir });
    const stats = await cache.sweep();
    assert.equal(stats.ok, true);
    assert.equal(fs.existsSync(path.join(outside, 'keep.txt')), true, 'outside file untouched');
  });

  it('no appDataDir degrades to no_root instead of throwing', async () => {
    const cache = createToolResultCache({});
    const stats = await cache.sweep();
    assert.equal(stats.ok, false);
    assert.equal(stats.reasonCode, 'no_root');
  });

  it('the tooling service surface exposes sweepToolCache and honours a ttl seam', async () => {
    const appDataDir = fs.mkdtempSync(path.join(tmpRoot, 'tool-cache-svc-'));
    const root = path.join(appDataDir, 'tool-cache');
    touch(root, 'cd/cdef.png', 2 * 60 * 60 * 1000); // 2 h old — expired for a 1 h TTL seam
    const tooling = createToolingServices({ appDataDir, sidecarsDir: tmpRoot, seam: { toolCacheTtlMs: 60 * 60 * 1000 } });
    const stats = await tooling.sweepToolCache();
    assert.equal(stats.ok, true);
    assert.equal(stats.removed, 1);
    tooling.dispose();
  });
});
