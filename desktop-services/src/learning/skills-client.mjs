// Trylo Desktop Services — read-only Skills list/view client (Phase 3A).
//
// Thin adapter that spawns `hermes-capabilities/skills_adapter.py`, which in
// turn calls the official Hermes `skills_list` / `skill_view`. No skill
// parsing, listing or threat logic lives here (arch §6.1: 数据面保持 Python
// 原样).
//
// Ownership: read-only by construction. Every mutation goes through the staged
// pending path in `pending-admin-service.mjs` (spec §7.5 / arch §6.6: 所有长期
// 写入 staged + 用户批准).
//
// Failure policy: mirrors `memory-context-client.js` — async spawn only,
// timeout, stdout/stderr caps, exit-code check, settle-once. Any failure
// resolves `{ ok:false, error }` so the Learning UI degrades instead of
// blocking Code/Work.

import path from 'node:path';
import { spawn } from 'node:child_process';

import { requireLegacyVendor } from './vendor-path.mjs';

const TIMEOUT_MS = 15000;
const MAX_STDOUT_BYTES = 512 * 1024;
const MAX_STDERR_BYTES = 32 * 1024;
const ADAPTER_NAME = 'skills_adapter.py';

/**
 * @param {{ storageRoot: string, capabilitiesDir?: string,
 *            spawn?: ((exe: string, args: string[], opts: object) => object)|null,
 *            resolver?: (() => string)|null }} options
 *   `spawn` / `resolver` are test seams only.
 */
export function createSkillsClient({
  storageRoot,
  capabilitiesDir = '',
  spawn: injectedSpawn = null,
  resolver: injectedResolver = null,
} = {}) {
  const spawnFn = injectedSpawn ?? spawn;

  function adapterPath() {
    const dir = capabilitiesDir || process.env.TRYLO_HERMES_CAPABILITIES_DIR || '';
    return dir ? path.join(dir, ADAPTER_NAME) : ADAPTER_NAME;
  }

  /** One adapter invocation. Never throws. */
  function call(request) {
    return new Promise((resolve) => {
      let pythonExe;
      try {
        pythonExe = injectedResolver
          ? injectedResolver()
          : requireLegacyVendor('hermes-python-resolver.js').resolveHermesPython();
      } catch (err) {
        resolve({ ok: false, error: `Hermes Python not found: ${err && err.message ? err.message : err}` });
        return;
      }
      if (!storageRoot) {
        resolve({ ok: false, error: 'hermes storage root is not configured' });
        return;
      }

      let child;
      try {
        child = spawnFn(pythonExe, [adapterPath()], {
          env: {
            ...process.env,
            HERMES_HOME: requireLegacyVendor('hermes-capability-manager.js').getHermesHome(storageRoot),
            PYTHONUTF8: '1',
            PYTHONIOENCODING: 'utf-8',
          },
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        });
      } catch (err) {
        resolve({ ok: false, error: `skills adapter failed to start: ${err && err.message ? err.message : err}` });
        return;
      }

      let out = '';
      let errText = '';
      let settled = false;
      const timer = setTimeout(() => {
        finish({ ok: false, error: `skills adapter timed out after ${TIMEOUT_MS}ms` });
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      }, TIMEOUT_MS);

      function finish(result) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { child.stdout.removeAllListeners(); child.stderr.removeAllListeners(); } catch { /* detached */ }
        resolve(result);
      }

      function parse() {
        let parsed;
        try {
          parsed = JSON.parse(out);
        } catch {
          finish({ ok: false, error: `skills adapter returned invalid JSON: ${(errText || out).slice(0, 200)}` });
          return;
        }
        if (!parsed || typeof parsed !== 'object') {
          finish({ ok: false, error: 'skills adapter returned a non-object payload' });
          return;
        }
        if (parsed.success !== true) {
          finish({ ok: false, error: String(parsed.error || 'skills adapter reported failure') });
          return;
        }
        finish({ ok: true, ...parsed });
      }

      child.stdout.on('data', (d) => {
        if (Buffer.byteLength(out) < MAX_STDOUT_BYTES) out += d;
      });
      child.stderr.on('data', (d) => {
        if (Buffer.byteLength(errText) < MAX_STDERR_BYTES) errText += d;
      });
      child.on('error', (e) => finish({ ok: false, error: `skills adapter error: ${e.message}` }));
      child.on('close', (code) => {
        if (settled) return;
        if (code !== 0 && !out.trim()) {
          finish({ ok: false, error: `skills adapter exited ${code}: ${errText.slice(0, 200)}` });
          return;
        }
        parse();
      });

      try {
        child.stdin.end(JSON.stringify(request));
      } catch (e) {
        finish({ ok: false, error: `skills adapter write failed: ${e.message}` });
      }
    });
  }

  return {
    /** List installed Skills. */
    list() {
      return call({ op: 'list' });
    },
    /** View one Skill's content by name. */
    view(name) {
      const skillName = String(name || '').trim();
      if (!skillName) return Promise.resolve({ ok: false, error: 'skill view requires a name' });
      return call({ op: 'view', name: skillName });
    },
  };
}
