// Trylo Desktop Services — tooling domain contract tests (appendix).
//
// PR-7 additions: Chrome DevTools MCP manifest contract (§4.1
// work.browser-debug.v1 / §8.2). The pinned-npm TRANSPORT itself is
// unchanged since PR-3 and is covered by tooling.test.mjs — what is new
// here is the BUNDLED closure shape (npmDependencies: []) and the CDP
// manifest's own pinned facts.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { createToolingServices } from '../../src/tooling/index.mjs';
import { validateManifest } from '../../src/tooling/tool-catalog.mjs';
import { OFFICECLI_MANIFEST } from '../../src/tooling/manifests/officecli.mjs';
import { PLAYWRIGHT_MANIFEST } from '../../src/tooling/manifests/playwright.mjs';
import { CHROME_DEVTOOLS_MANIFEST } from '../../src/tooling/manifests/chrome-devtools.mjs';

const SAVED = {
  TRYLO_APP_DATA_DIR: process.env.TRYLO_APP_DATA_DIR,
  TRYLO_SIDECARS_DIR: process.env.TRYLO_SIDECARS_DIR,
};

let tmpRoot = '';

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'trylo-tooling-cdp-'));
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

/** A Hermes adapter stub (same shape as tooling.test.mjs). */
function hermesStub() {
  return {
    mcpArgs() {
      return { ok: true, arg: [], warning: null, configPath: null };
    },
  };
}

describe('chrome-devtools manifest (PR-7, §4.1/§8.2)', () => {
  it('passes validation and pins the full contract', () => {
    const problems = validateManifest(CHROME_DEVTOOLS_MANIFEST);
    assert.deepEqual(problems, [], problems.join('; '));
    assert.equal(CHROME_DEVTOOLS_MANIFEST.version, '1.8.0');
    assert.equal(CHROME_DEVTOOLS_MANIFEST.mcp.serverName, 'trylo-chrome');
    assert.equal(CHROME_DEVTOOLS_MANIFEST.artifact.installStrategy, 'pinned-npm');
    assert.equal(CHROME_DEVTOOLS_MANIFEST.artifact.runner, 'node');
    assert.equal(CHROME_DEVTOOLS_MANIFEST.artifact.packageName, 'chrome-devtools-mcp');
    assert.equal(CHROME_DEVTOOLS_MANIFEST.activation, 'on-demand');
    assert.equal(CHROME_DEVTOOLS_MANIFEST.telemetry, 'forced-off');
    assert.equal(CHROME_DEVTOOLS_MANIFEST.healthCheck, 'version-handshake');
  });

  it('declares a BUNDLED closure — npmDependencies is an empty array', () => {
    // The 1.8.0 tarball rolls puppeteer-core et al. into build/src (a real
    // tarball inspection, PR-7 2026-09-02): the single pinned digest is the
    // whole trust chain and there is nothing left to float.
    assert.deepEqual([...CHROME_DEVTOOLS_MANIFEST.artifact.npmDependencies], []);
  });

  it('forces both telemetry channels off (env + argv)', () => {
    assert.equal(CHROME_DEVTOOLS_MANIFEST.mcp.env.CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS, 'true');
    assert.ok(
      CHROME_DEVTOOLS_MANIFEST.mcp.args.includes('--no-performance-crux'),
      'performance CrUX egress must be disabled in argv',
    );
    assert.ok(CHROME_DEVTOOLS_MANIFEST.mcp.args.includes('--isolated'), 'isolated profile per §8.2');
  });

  it('exposes exactly the 29 recorded tools', () => {
    assert.equal(CHROME_DEVTOOLS_MANIFEST.mcp.expectedTools.length, 29);
    assert.ok(CHROME_DEVTOOLS_MANIFEST.mcp.expectedTools.includes('evaluate_script'));
    assert.ok(CHROME_DEVTOOLS_MANIFEST.mcp.expectedTools.includes('navigate_page'));
  });

  it('declares NO origin lists (the CDP origin flags are URL patterns, not origins)', () => {
    assert.equal(CHROME_DEVTOOLS_MANIFEST.mcp.allowedOrigins, undefined);
    assert.equal(CHROME_DEVTOOLS_MANIFEST.mcp.blockedOrigins, undefined);
  });

  it('pins the tarball digest and the entry script', () => {
    assert.match(CHROME_DEVTOOLS_MANIFEST.artifact.archiveSha256, /^[0-9a-f]{64}$/);
    assert.ok(CHROME_DEVTOOLS_MANIFEST.artifact.downloadUrl.endsWith('chrome-devtools-mcp-1.8.0.tgz'));
    assert.ok(CHROME_DEVTOOLS_MANIFEST.artifact.downloadUrl.includes('/chrome-devtools-mcp/-/'));
    // Same placement layout contract as playwright: the transport extracts
    // the entry package into node_modules/<packageName>/.
    assert.equal(
      CHROME_DEVTOOLS_MANIFEST.artifact.executableRelativePath,
      'node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js',
    );
  });
});

describe('work.browser-debug.v1 composition (PR-7, §4.1)', () => {
  it('swaps Playwright OUT for chrome-devtools — the two never co-reside', async () => {
    // A fake pinned entry whose `--version` matches the manifest pin: the
    // version-handshake probe (runner node) exercises the REAL probe path,
    // while the tarball transport itself stays covered by tooling.test.mjs
    // and the PR-7 manual install+smoke recorded in the execution log.
    const fakeEntry = path.join(tmpRoot, 'fake-cdp', 'chrome-devtools-mcp.js');
    fs.mkdirSync(path.dirname(fakeEntry), { recursive: true });
    fs.writeFileSync(
      fakeEntry,
      "if (process.argv.includes('--version')) { console.log('1.8.0'); }\n",
      'utf8',
    );
    const tooling = createToolingServices({
      appDataDir: tmpRoot,
      sidecarsDir: tmpRoot,
      seam: {
        hermes: hermesStub(),
        installRoot: path.join(tmpRoot, 'tool-packages-cdp'),
        profilesRoot: path.join(tmpRoot, 'tool-profiles-cdp'),
        probe: async (exe) => {
          // Mirror the real node-runner probe (process.execPath [entry, --version]).
          const { execFileSync } = await import('node:child_process');
          return execFileSync(process.execPath, [exe, '--version'], { encoding: 'utf8' }).trim();
        },
        overrides: { 'chrome-devtools': fakeEntry },
      },
    });
    const resolved = await tooling.resolveProfile({
      surface: 'work',
      requestedProfileId: 'work.browser-debug.v1',
      projectRoot: tmpRoot,
      conversationId: 'conv-cdp',
    });
    assert.equal(resolved.ok, true, 'ok' in resolved ? JSON.stringify(resolved.error ?? resolved.reasonCode) : '');
    if (!resolved.ok) return;
    const servers = resolved.serverNames;
    // §4.1: Playwright replaced — never both at once. officecli degrades
    // (not installed) into unavailableCapabilities per §4.4.
    assert.ok(servers.includes('trylo-chrome'), 'chrome-devtools server composed');
    assert.ok(!servers.includes('trylo-browser'), 'playwright must be absent from the debug profile');
    // The launch contract: node runner + entry script + pinned args/env.
    const configPath = resolved.mcpConfigPath;
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const server = parsed.mcpServers['trylo-chrome'];
    assert.equal(server.command, process.execPath);
    assert.equal(server.args[0].endsWith('chrome-devtools-mcp.js'), true);
    assert.deepEqual(server.args.slice(1), ['--isolated', '--no-performance-crux']);
    assert.equal(server.env.CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS, 'true');
    // ask rules cover the new server (§6.1 defensive depth).
    const settings = JSON.parse(fs.readFileSync(resolved.permissionSettingsPath, 'utf8'));
    assert.ok(settings.permissions.ask.includes('mcp__trylo-chrome__*'));
  });

  it('the other three manifests remain valid alongside (no schema drift)', () => {
    for (const manifest of [OFFICECLI_MANIFEST, PLAYWRIGHT_MANIFEST]) {
      assert.deepEqual(validateManifest(manifest), [], manifest.id);
    }
  });
});
