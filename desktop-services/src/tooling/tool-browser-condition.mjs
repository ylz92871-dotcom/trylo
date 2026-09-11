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
export function browserCacheRoots(env = process.env) {
  const roots = [];
  if (env.PLAYWRIGHT_BROWSERS_PATH && env.PLAYWRIGHT_BROWSERS_PATH.trim() !== '') {
    roots.push(env.PLAYWRIGHT_BROWSERS_PATH.trim());
  }
  const localAppData = env.LOCALAPPDATA ?? '';
  if (localAppData) roots.push(path.join(localAppData, 'ms-playwright'));
  const home = env.USERPROFILE ?? env.HOME ?? '';
  if (home) roots.push(path.join(home, 'AppData', 'Local', 'ms-playwright'));
  return roots;
}

/** The executable lives inside the build dir under a platform folder whose
 *  NAME DEPENDS ON THE PLAYWRIGHT GENERATION: 1.49+ ships `chrome-win64/`
 *  (win-x64 only), older releases shipped `chrome-win/`. A build counts
 *  when EITHER layout has the marker — the 2026-09-03 acceptance install
 *  succeeded while the probe (chrome-win only) kept reporting the browser
 *  missing, so the UI looped on 「安装浏览器」 forever. */
const CHROME_PLATFORM_SUBDIRS = Object.freeze(['chrome-win64', 'chrome-win']);

/**
 * Probe for an installed Chromium (any pinned revision) under the cache
 * roots. A build counts only when its executable marker is present, so a
 * cancelled download never reads as installed.
 *
 * @param {{ env?: Record<string, string | undefined>, buildPrefix?: string,
 *           executableMarker?: string }} [options]
 * @returns {{ ok: boolean, reasonCode: 'browser_ok'|'browser_not_installed',
 *             detail: string, root: string|null, build: string|null }}
 */
export function probePlaywrightChromium(options = {}) {
  const env = options.env ?? process.env;
  const buildPrefix = options.buildPrefix ?? 'chromium-';
  const executableMarker = options.executableMarker ?? 'chrome.exe';
  const roots = browserCacheRoots(env);

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
      for (const platformDir of CHROME_PLATFORM_SUBDIRS) {
        const exe = path.join(root, build, platformDir, executableMarker);
        try {
          if (fs.statSync(exe).isFile()) {
            return {
              ok: true,
              reasonCode: 'browser_ok',
              detail: `chromium ready: ${build} (${platformDir})`,
              root,
              build,
            };
          }
        } catch {
          // this build/platform is incomplete — keep looking
        }
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
