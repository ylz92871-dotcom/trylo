// Trylo Desktop Services — Tool Package Health.
//
// Spec TRYLO-CORE-AGENT-TOOL-EXTENSION-TECHNICAL-SPEC §4.4 / §8.2.
//
// Two tiers, deliberately separated because they have different costs and
// different owners:
//
//   LOCAL (this module, PR-1)
//     executable present, digest state matches the pinned manifest, and —
//     for `version-handshake` packages — a bounded `--version` probe. Cheap
//     enough to run on every Profile resolve.
//
//   PROTOCOL (`tools/list` vs `expectedTools`)
//     NOT performed by the sidecar. §8.1 forbids the Service Host from
//     spawning an MCP server the CLI also owns. The authoritative
//     `tools/list` is the one the CLI observes at startup; comparing it to
//     `expectedTools` is wired in PR-2 through the run diagnostics. This
//     module therefore reports `protocol: 'not-checked'` rather than
//     claiming a pass it cannot prove.
//
// Failure policy: never throws. A failed check produces a health record the
// Profile Resolver surfaces as an unavailable capability (§4.4) — never as
// a model error.

import { execFile } from 'node:child_process';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { probePlaywrightChromium } from './tool-browser-condition.mjs';
import { probeAppCondition } from './tool-app-condition.mjs';

const VERSION_PROBE_TIMEOUT_MS = 2000;
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * PR-6 (§8.2): read the pinned distribution's version from its OWN venv.
 * `<versionDir>/.venv/Scripts/python.exe -c "importlib.metadata.version(...)"`
 * is the only signal that cannot be faked by a stale console-script banner:
 * it proves the venv exists, the interpreter runs, and the distribution the
 * lock materialised is the one the manifest pins. Never rejects.
 */
export function defaultProbePythonMetadata(entryExecutable, expectedName, timeoutMs = VERSION_PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    // entryExecutable = <versionDir>/.venv/Scripts/windows-mcp.exe → the
    // interpreter sits in the same Scripts directory.
    const python = path.join(path.dirname(entryExecutable), 'python.exe');
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child?.kill();
      } catch {
        /* already gone */
      }
      resolve(value);
    };
    // eslint-disable-next-line no-empty-function
    const timer = setTimeout(() => finish(null), timeoutMs);
    let child;
    try {
      child = spawn(
        python,
        ['-c', `import importlib.metadata as md; print(md.version(${JSON.stringify(expectedName)}))`],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
      );
    } catch {
      finish(null);
      return;
    }
    let out = '';
    child.stdout?.on('data', (chunk) => {
      out += String(chunk);
    });
    child.on('error', () => finish(null));
    child.on('close', (code) => {
      const version = out.trim().split('\n')[0]?.trim() ?? '';
      finish(code === 0 && version !== '' ? version : null);
    });
  });
}

/**
 * Run `<exe> --version` with a hard bound. Returns the trimmed stdout, or
 * null on any failure. Never rejects — a slow or silent binary degrades the
 * health record, it does not stall the Profile resolve.
 *
 * PR-3: a `runner: 'node'` package's entry is a .js script — the probe
 * runs it under the same Node runtime the sidecar uses (§8.2), mirroring
 * exactly how the Profile composes the MCP command.
 */
export function probeVersion(executable, timeoutMs = VERSION_PROBE_TIMEOUT_MS, runner = null) {
  return probeVersionOnce(executable, timeoutMs, runner).then((first) => {
    if (first !== null) return first;
    // Real-install finding (PR-7): Windows real-time AV scanning can
    // transiently hold a freshly-placed binary — the FIRST probe after an
    // install may fail to start (observed: attempt 1 → null, attempt 2 →
    // the real version). One bounded retry turns that transient into the
    // real answer instead of a wrong `not-installed` verdict that the
    // health cache would then hold for its full TTL. Never rejects either
    // way — a probe that fails twice degrades the health record honestly.
    return new Promise((resolve) => setTimeout(resolve, 400)).then(() =>
      probeVersionOnce(executable, timeoutMs, runner),
    );
  });
}

function probeVersionOnce(executable, timeoutMs, runner) {  return new Promise((resolve) => {
    let settled = false;
    let child;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child?.kill();
      } catch {
        /* already gone */
      }
      resolve(value);
    };
    // eslint-disable-next-line no-empty-function
    const timer = setTimeout(() => finish(null), timeoutMs);
    const command = runner === 'node' ? process.execPath : executable;
    const args = runner === 'node' ? [executable, '--version'] : ['--version'];
    try {
      child = spawn(command, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      finish(null);
      return;
    }
    let out = '';
    child.stdout?.on('data', (chunk) => {
      out += String(chunk);
      if (out.length > 4096) finish(out.trim());
    });
    child.on('error', () => finish(null));
    child.on('close', () => finish(out.trim() || null));
  });
}

export function createToolHealthService({ packages, catalog, now = () => Date.now(), probe = probeVersion, probePythonMetadata = defaultProbePythonMetadata, probeCondition = probePlaywrightChromium, probeApp = probeAppCondition } = {}) {
  const cache = new Map();

  function cacheKey(manifest) {
    return `${manifest.id}@${manifest.version}`;
  }

  /**
   * @param {object} manifest
   * @param {{ deep?: boolean }} [opts] `deep` re-probes, ignoring the cache.
   */
  async function check(manifest, opts = {}) {
    const key = cacheKey(manifest);
    if (!opts.deep) {
      const hit = cache.get(key);
      if (hit && now() - hit.checkedAt < CACHE_TTL_MS) return hit;
    }

    const installed = await packages.resolve(manifest);
    const record = {
      id: manifest.id,
      version: manifest.version,
      displayName: manifest.displayName,
      adoption: manifest.adoption,
      serverName: manifest.mcp.serverName,
      state: installed.state,
      available: installed.state === 'installed' || installed.state === 'override',
      detail: installed.detail,
      autoUpdate: installed.autoUpdate,
      expectedTools: [...manifest.mcp.expectedTools],
      protocol: 'not-checked',
      checkedAt: now(),
      reportedVersion: null,
      versionMatches: null,
    };

    if (!record.available) {
      cache.set(key, record);
      return record;
    }

    // §8.2: an auto-updating package is a version-drift hazard — it is
    // reported, not silently accepted.
    if (record.autoUpdate) {
      record.state = 'hash-mismatch';
      record.available = false;
      record.detail = 'package reports autoUpdate=true; Trylo owns updates';
      cache.set(key, record);
      return record;
    }

    if (manifest.healthCheck === 'version-handshake') {
      const reported = await probe(installed.executable, VERSION_PROBE_TIMEOUT_MS, manifest.artifact?.runner ?? null);
      record.reportedVersion = reported;
      if (reported === null) {
        record.state = 'not-installed';
        record.available = false;
        record.detail = 'version probe produced no output';
      } else {
        record.versionMatches = reported.includes(manifest.version);
        if (!record.versionMatches) {
          record.state = 'version-mismatch';
          record.available = false;
          record.detail = `binary reports '${reported}', manifest pins ${manifest.version}`;
        } else {
          // Make the PASS visible too — Diagnostics must be able to show
          // that the pinned version was actually verified, not assumed.
          record.detail = `version verified: ${reported.trim()}`;
        }
      }
    } else if (manifest.healthCheck === 'python-metadata') {
      // PR-6 (§8.2 Windows-MCP): the uv console script answers `--version`
      // with a usage banner, not a version — a usage-banner probe would read
      // as a pass for ANY build. The honest probe asks the installed
      // distribution metadata inside the package's own venv interpreter.
      const pythonPackage = manifest.artifact?.pythonPackage ?? manifest.id;
      const reported = await probePythonMetadata(installed.executable, pythonPackage);
      record.reportedVersion = reported;
      if (reported === null) {
        record.state = 'not-installed';
        record.available = false;
        record.detail = 'python metadata probe produced no version';
      } else {
        record.versionMatches = reported === manifest.version;
        if (!record.versionMatches) {
          record.state = 'version-mismatch';
          record.available = false;
          record.detail = `installed distribution reports '${reported}', manifest pins ${manifest.version}`;
        } else {
          record.detail = `version verified: ${reported}`;
        }
      }
    } else if (manifest.healthCheck === 'source-entry') {
      // CAD/EDA source-run packages (pinned-pypi-env source mode) have no
      // installed distribution to read metadata from; the honest probe is
      // the pinned source ENTRY script existing in the installed tree next
      // to the transport's venv (TRYLO-CAD-EDA-TOOL-ADAPTER §6.2).
      const entryRelative = String(manifest.artifact?.sourceEntry ?? '');
      const entryPath = entryRelative
        ? path.join(installed.installDir, ...entryRelative.split(/[\\/]/))
        : '';
      let entryPresent = false;
      try {
        entryPresent = entryPath !== '' && fs.statSync(entryPath).isFile();
      } catch {
        entryPresent = false;
      }
      record.reportedVersion = entryPresent ? manifest.version : null;
      record.versionMatches = entryPresent;
      if (!entryPresent) {
        record.state = 'not-installed';
        record.available = false;
        record.detail = 'source entry script missing from the installed tree';
      } else {
        record.detail = `source entry verified: ${entryRelative}`;
      }
    }

    // §3.3-7: a manifest may declare a RUNTIME CONDITION beyond the package
    // itself (playwright → the Chromium body in the ms-playwright cache).
    // The condition failing degrades the record even when the package digest
    // and version are perfect — 「包已装但浏览器本体缺失时不能显示完全可用」.
    if (record.available && manifest.browserCondition?.kind === 'playwright-chromium') {
      const condition = probeCondition();
      record.condition = {
        ok: condition.ok,
        reasonCode: condition.reasonCode,
        detail: condition.detail,
      };
      if (!condition.ok) {
        record.state = 'condition-missing';
        record.available = false;
        record.detail = `package installed, but the browser body is missing (${condition.detail}) — run 安装浏览器`;
      }
    }

    // §3.3-7 extension (CAD/EDA): a manifest may declare a HOST-APPLICATION
    // condition (`installCondition`) — the package automates an application
    // that must be installed (and, for bridge kinds, running with its
    // automation port open). Same honest degradation: a perfect package
    // digest never reads as 可用 while the app it drives is missing.
    if (record.available && manifest.installCondition?.kind) {
      let condition;
      try {
        condition = await probeApp(manifest.installCondition);
      } catch (error) {
        condition = {
          ok: false,
          reasonCode: 'condition_probe_failed',
          detail: `condition probe failed: ${error?.message ?? error}`,
        };
      }
      record.condition = {
        ok: condition.ok,
        reasonCode: condition.reasonCode,
        detail: condition.detail,
      };
      if (!condition.ok) {
        record.state = 'condition-missing';
        record.available = false;
        record.detail =
          `package installed, but the host application is unavailable (${condition.detail})` +
          (typeof manifest.installCondition.remediation === 'string'
            ? ` — ${manifest.installCondition.remediation}`
            : '');
      }
    }

    cache.set(key, record);
    return record;
  }

  return {
    check,

    /** Health for every catalog entry (bounded by the cache). */
    async listAll(opts = {}) {
      const manifests = catalog.list();
      const out = [];
      for (const manifest of manifests) {
        // Never let one broken package hide the others.
        try {
          out.push(await check(manifest, opts));
        } catch (error) {
          out.push({
            id: manifest.id,
            version: manifest.version,
            displayName: manifest.displayName,
            adoption: manifest.adoption,
            serverName: manifest.mcp.serverName,
            state: 'not-installed',
            available: false,
            detail: `health check failed: ${error?.message ?? error}`,
            autoUpdate: false,
            expectedTools: [...manifest.mcp.expectedTools],
            protocol: 'not-checked',
            checkedAt: now(),
            reportedVersion: null,
            versionMatches: null,
          });
        }
      }
      return out;
    },

    /** Health for one package id, or null when the id is unknown. */
    async forId(id, opts = {}) {
      const manifest = catalog.get(id);
      return manifest ? check(manifest, opts) : null;
    },

    clearCache() {
      cache.clear();
    },
  };
}

export default createToolHealthService;
