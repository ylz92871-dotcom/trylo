// Trylo Desktop Services — Playwright browser-body condition probe.
//
// Spec TRYLO-CORE-AGENT-TOOL-EXTENSION-TECHNICAL-SPEC §3.3-7 (audit P0-A
// acceptance): 「Playwright 单独检查浏览器本体；包已装但 Chromium/Chrome
// 不可启动时不能显示'完全可用'」. The MCP package being installed does NOT
// mean a browser binary exists — playwright-core downloads Chromium into the
// shared ms-playwright cache the FIRST time something runs
// `playwright install`, and a fresh machine has neither.
//
// The probe is a filesystem existence check over the well-known cache roots
// (cheap, side-effect free, never spawns a browser). A directory that exists
// but cannot launch is a deeper failure the run diagnostics own; the health
// record only needs the honest two-state answer the Settings UI shows.
//
// Failure policy: never throws. Any fs error degrades to "condition missing"
// with a reason — the same §4.4 contract as every other health check.

import fs from 'node:fs';
import path from 'node:path';

/** Well-known ms-playwright cache roots, in probe order. The env override
 *  wins (PLAYWRIGHT_BROWSERS_PATH is playwright-core's own contract). */
export function browserCacheRoots(env = process.env, platform = process.platform) {
  const roots = [];
  if (env.PLAYWRIGHT_BROWSERS_PATH && env.PLAYWRIGHT_BROWSERS_PATH.trim() !== '') {
    roots.push(env.PLAYWRIGHT_BROWSERS_PATH.trim());
  }
  if (platform === 'win32') {
    if (env.LOCALAPPDATA) roots.push(path.join(env.LOCALAPPDATA, 'ms-playwright'));
    const home = env.USERPROFILE ?? env.HOME;
    if (home) roots.push(path.join(home, 'AppData', 'Local', 'ms-playwright'));
  } else if (platform === 'darwin' && env.HOME) {
    roots.push(path.join(env.HOME, 'Library', 'Caches', 'ms-playwright'));
  }
  return roots;
}

/** Resolve the executable shared by the health probe and the viewport launcher. */
export function chromiumExecutable(root, build, options = {}) {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const layouts = platform === 'darwin'
    ? [arch === 'arm64' ? 'chrome-mac-arm64' : 'chrome-mac-x64', 'chrome-mac']
    : platform === 'win32' ? ['chrome-win64', 'chrome-win'] : [];
  const markers = options.executableMarker ? [options.executableMarker]
    : platform === 'darwin'
      ? [
          'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
          'Chromium.app/Contents/MacOS/Chromium',
        ]
      : ['chrome.exe'];
  for (const platformDir of layouts) {
    for (const marker of markers) {
      const executable = path.join(root, build, platformDir, marker);
      try {
        if (!fs.statSync(executable).isFile()) continue;
        if (platform === 'darwin') fs.accessSync(executable, fs.constants.X_OK);
        return { executable, platformDir };
      } catch {
        // Incomplete build. Check other supported layouts.
      }
    }
  }
  return null;
}

/**
 * Probe for an installed Chromium (any pinned revision) under the cache
 * roots. A build counts only when its executable marker is present, so a
 * cancelled download never reads as installed.
 *
 * @param {{ env?: Record<string, string | undefined>, buildPrefix?: string, platform?: string, arch?: string,
 *           executableMarker?: string }} [options]
 * @returns {{ ok: boolean, reasonCode: 'browser_ok'|'browser_not_installed',
 *             detail: string, root: string|null, build: string|null }}
 */
export function probePlaywrightChromium(options = {}) {
  const env = options.env ?? process.env;
  const buildPrefix = options.buildPrefix ?? 'chromium-';
  const roots = browserCacheRoots(env, options.platform);

  let anyRootExists = false;
  for (const root of roots) {
    let entries;
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    anyRootExists = true;
    // Newest revision LAST. Playwright revisions are numeric and NOT
    // zero-padded (9999 > 10000 lexicographically), so sort numerically by
    // the suffix; a non-numeric suffix sorts first (treated as oldest).
    const builds = entries
      .filter((e) => e.isDirectory() && e.name.startsWith(buildPrefix))
      .map((e) => e.name)
      .sort((a, b) => {
        const na = Number.parseInt(a.slice(buildPrefix.length), 10);
        const nb = Number.parseInt(b.slice(buildPrefix.length), 10);
        if (Number.isNaN(na) || Number.isNaN(nb)) return a.localeCompare(b);
        return na - nb;
      });
    for (let i = builds.length - 1; i >= 0; i -= 1) {
      const build = builds[i];
      const browser = chromiumExecutable(root, build, options);
      if (browser) {
        return {
          ok: true,
          reasonCode: 'browser_ok',
          detail: `chromium ready: ${build} (${browser.platformDir})`,
          root,
          build,
        };
      }
    }
  }
  return {
    ok: false,
    reasonCode: 'browser_not_installed',
    detail: anyRootExists
      ? 'ms-playwright cache has no complete chromium build'
      : 'ms-playwright browser cache not found',
    root: anyRootExists ? roots.find((r) => {
      try { fs.statSync(r); return true; } catch { return false; }
    }) ?? null : null,
    build: null,
  };
}

export default probePlaywrightChromium;
