// Trylo Desktop Services — browser-body condition tests (audit P0-A §3.3-7).
//
// Pins the honest two-state answer for the playwright browser:
//   - the probe finds a COMPLETE chromium build (executable marker present)
//     under the well-known ms-playwright roots, honouring
//     PLAYWRIGHT_BROWSERS_PATH;
//   - an incomplete build or an empty cache reads as browser_not_installed;
//   - the health service degrades an installed playwright package whose
//     browser body is missing to condition-missing (never 可用);
//   - `tooling.installBrowser` shells out to the package's OWN pinned
//     playwright CLI and clears the health cache.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { browserCacheRoots, probePlaywrightChromium } from '../../src/tooling/tool-browser-condition.mjs';
import { createToolingServices } from '../../src/tooling/index.mjs';
import { PLAYWRIGHT_MANIFEST } from '../../src/tooling/manifests/playwright.mjs';

const SAVED = {
  TRYLO_APP_DATA_DIR: process.env.TRYLO_APP_DATA_DIR,
  TRYLO_SIDECARS_DIR: process.env.TRYLO_SIDECARS_DIR,
  PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH,
};

let tmpRoot = '';
let cacheRoot = '';

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'trylo-browser-cond-'));
  cacheRoot = path.join(tmpRoot, 'ms-playwright');
  fs.mkdirSync(cacheRoot, { recursive: true });
  process.env.TRYLO_APP_DATA_DIR = tmpRoot;
  process.env.TRYLO_SIDECARS_DIR = tmpRoot;
  process.env.PLAYWRIGHT_BROWSERS_PATH = cacheRoot;
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

describe('browserCacheRoots', () => {
  it('honours PLAYWRIGHT_BROWSERS_PATH first', () => {
    const roots = browserCacheRoots({ PLAYWRIGHT_BROWSERS_PATH: '/x' });
    assert.equal(roots[0], '/x');
  });

  it('falls back to the platform cache roots', () => {
    const roots = browserCacheRoots({ LOCALAPPDATA: 'C:\\u\\AppData\\Local' });
    assert.ok(roots.length >= 1);
    assert.ok(roots[0].includes('ms-playwright'));
  });
});

describe('probePlaywrightChromium', () => {
  it('misses when the cache root does not exist', () => {
    const result = probePlaywrightChromium({
      env: { PLAYWRIGHT_BROWSERS_PATH: path.join(tmpRoot, 'nonexistent') },
    });
    assert.equal(result.ok, false);
    assert.equal(result.reasonCode, 'browser_not_installed');
  });

  it('misses an INCOMPLETE build (no executable marker)', () => {
    fs.mkdirSync(path.join(cacheRoot, 'chromium-9999', 'chrome-win'), { recursive: true });
    const result = probePlaywrightChromium({ env: { PLAYWRIGHT_BROWSERS_PATH: cacheRoot } });
    assert.equal(result.ok, false);
    assert.equal(result.reasonCode, 'browser_not_installed');
  });

  it('finds a complete build and reports it', () => {
    fs.writeFileSync(path.join(cacheRoot, 'chromium-9999', 'chrome-win', 'chrome.exe'), 'pe');
    const result = probePlaywrightChromium({ env: { PLAYWRIGHT_BROWSERS_PATH: cacheRoot } });
    assert.equal(result.ok, true);
    assert.equal(result.reasonCode, 'browser_ok');
    assert.equal(result.build, 'chromium-9999');
  });

  it('finds the MODERN chrome-win64 layout (playwright 1.49+, 2026-09-03 acceptance)', () => {
    // A current playwright machine cache only ever holds chrome-win64 — the
    // probe must read it as installed, not loop on 「安装浏览器」 forever.
    // Isolated root: the shared cacheRoot carries older-revision fixtures.
    const root64 = path.join(tmpRoot, 'ms-playwright-64');
    fs.mkdirSync(path.join(root64, 'chromium-1237', 'chrome-win64'), { recursive: true });
    fs.writeFileSync(path.join(root64, 'chromium-1237', 'chrome-win64', 'chrome.exe'), 'pe');
    const result = probePlaywrightChromium({ env: { PLAYWRIGHT_BROWSERS_PATH: root64 } });
    assert.equal(result.ok, true);
    assert.equal(result.build, 'chromium-1237');
    assert.ok(result.detail.includes('chrome-win64'));
  });

  it('prefers the newest complete build', () => {
    fs.mkdirSync(path.join(cacheRoot, 'chromium-10000', 'chrome-win'), { recursive: true });
    fs.writeFileSync(path.join(cacheRoot, 'chromium-10000', 'chrome-win', 'chrome.exe'), 'pe');
    const result = probePlaywrightChromium({ env: { PLAYWRIGHT_BROWSERS_PATH: cacheRoot } });
    assert.equal(result.build, 'chromium-10000');
  });
});

describe('health integration: playwright without its browser body', () => {
  // A fake pinned-install layout: the override exe sits at
  // <root>/node_modules/@playwright/mcp/cli.js so (a) resolve() reads
  // `override`/available, and (b) installBrowser finds the sibling pinned
  // playwright CLI at <root>/node_modules/playwright/cli.js.
  let installRoot = '';
  let fakeExe = '';
  let fakePlaywrightCli = '';
  before(() => {
    installRoot = path.join(tmpRoot, 'pkg-root');
    fakeExe = path.join(installRoot, 'node_modules', '@playwright', 'mcp', 'cli.js');
    fakePlaywrightCli = path.join(installRoot, 'node_modules', 'playwright', 'cli.js');
    fs.mkdirSync(path.dirname(fakeExe), { recursive: true });
    fs.mkdirSync(path.dirname(fakePlaywrightCli), { recursive: true });
    fs.writeFileSync(fakeExe, '// fake pinned entry\n');
    fs.writeFileSync(fakePlaywrightCli, '// fake pinned playwright cli\n');
  });

  function build(seam = {}) {
    return createToolingServices({
      appDataDir: tmpRoot,
      sidecarsDir: tmpRoot,
      seam: {
        installRoot: path.join(tmpRoot, 'tool-packages'),
        profilesRoot: path.join(tmpRoot, 'tool-profiles'),
        // The fake entry is not a real binary: inject the version handshake
        // so the playwright record reaches the condition check.
        probe: async () => PLAYWRIGHT_MANIFEST.version,
        ...seam,
      },
    });
  }

  it('degrades to condition-missing when the browser probe fails', async () => {
    const tooling = build({
      overrides: { playwright: fakeExe },
      probeCondition: () => ({ ok: false, reasonCode: 'browser_not_installed', detail: 'cache empty' }),
    });
    const health = await tooling.health({ id: 'playwright' });
    const record = health.packages[0];
    assert.equal(record.state, 'condition-missing');
    assert.equal(record.available, false);
    assert.equal(record.condition.ok, false);
    tooling.dispose();
  });

  it('stays available when the browser probe passes', async () => {
    const tooling = build({
      overrides: { playwright: fakeExe },
      probeCondition: () => ({ ok: true, reasonCode: 'browser_ok', detail: 'chromium ready' }),
    });
    const health = await tooling.health({ id: 'playwright' });
    // An override resolves as `override` — an available state (the §3.3
    // machine treats it as 可用); the condition rode along.
    assert.equal(health.packages[0].available, true);
    assert.equal(health.packages[0].condition.ok, true);
    tooling.dispose();
  });

  it('installBrowser runs the pinned playwright CLI and reports ok', async () => {
    const calls = [];
    const tooling = build({
      overrides: { playwright: fakeExe },
      runCommand: async (exe, args) => {
        calls.push({ exe, args });
        return true;
      },
    });
    const result = await tooling.installBrowser({ id: 'playwright' });
    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].args.join(' ').includes('install chromium'));
    assert.equal(calls[0].args[0], fakePlaywrightCli);
    tooling.dispose();
  });

  it('installBrowser refuses a package that is not installed', async () => {
    const tooling = build({
      runCommand: async () => true,
    });
    const result = await tooling.installBrowser({ id: 'playwright' });
    assert.equal(result.ok, false);
    assert.equal(result.reasonCode, 'package_not_installed');
    tooling.dispose();
  });

  it('installBrowser clears the health cache so the next health is fresh', async () => {
    let browserOk = false;
    let probes = 0;
    const tooling = build({
      overrides: { playwright: fakeExe },
      probeCondition: () => {
        probes += 1;
        return browserOk
          ? { ok: true, reasonCode: 'browser_ok', detail: 'ready' }
          : { ok: false, reasonCode: 'browser_not_installed', detail: 'missing' };
      },
      runCommand: async () => {
        browserOk = true;
        return true;
      },
    });
    const before = await tooling.health({ id: 'playwright' });
    assert.equal(before.packages[0].state, 'condition-missing');
    const installed = await tooling.installBrowser({ id: 'playwright' });
    assert.equal(installed.ok, true);
    const afterHealth = await tooling.health({ id: 'playwright' });
    assert.equal(afterHealth.packages[0].available, true);
    assert.ok(probes >= 2, 'the condition probe must re-run after the install');
    tooling.dispose();
  });
});
