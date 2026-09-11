// Trylo Desktop Services — Hermes learning graph + Skill-quality adapter.
//
// Reuses the official Hermes 0.19.0 graph/usage/scanner through
// curation_adapter.py, then reuses the legacy deterministic signal builder
// and candidate detector. This module never edits a Skill and never applies a
// pending proposal; it is the read-only half of L5 governance.

import { spawn } from 'node:child_process';
import path from 'node:path';

import { requireLegacyVendor } from './vendor-path.mjs';

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_STDOUT_BYTES = 4 * 1024 * 1024;
const MAX_STDERR_BYTES = 16 * 1024;

function safeCandidate(pair) {
  return {
    a: String(pair?.a || ''),
    b: String(pair?.b || ''),
    reason: String(pair?.reason || ''),
    scores: {
      name: Number(pair?.scores?.name) || 0,
      desc: Number(pair?.scores?.desc) || 0,
      category: Number(pair?.scores?.category) || 0,
    },
    hardRejects: Array.isArray(pair?.hardRejects)
      ? pair.hardRejects.map(String).slice(0, 20)
      : [],
  };
}

/**
 * @param {{ storageRoot: string, capabilitiesDir: string, memento: object,
 *           log?: (message: string) => void,
 *           runAdapter?: ((options: object) => Promise<object>)|null }} options
 */
export function createCurationService({
  storageRoot,
  capabilitiesDir,
  memento,
  log = null,
  runAdapter: injectedRunAdapter = null,
} = {}) {
  let learningState = null;
  let signals = null;
  let detector = null;

  function legacy() {
    learningState ??= requireLegacyVendor('learning-loop/learning-state.js');
    signals ??= requireLegacyVendor('learning-loop/skill-quality/signals.js');
    detector ??= requireLegacyVendor('learning-loop/skill-quality/detector.js');
    return { learningState, signals, detector };
  }

  function requireRoot() {
    if (!storageRoot) throw new Error('curation: storage root is not configured');
    if (!capabilitiesDir) throw new Error('curation: capabilities directory is not configured');
  }

  async function runAdapter({ timeoutMs = DEFAULT_TIMEOUT_MS, signal } = {}) {
    requireRoot();
    if (injectedRunAdapter) return injectedRunAdapter({ timeoutMs, signal });

    const { resolveHermesPython } = requireLegacyVendor('hermes-python-resolver.js');
    const { getHermesHome } = requireLegacyVendor('hermes-capability-manager.js');
    const pythonExe = resolveHermesPython();
    const script = path.join(capabilitiesDir, 'curation_adapter.py');
    const hermesHome = getHermesHome(storageRoot);

    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error('curation: aborted'));
        return;
      }
      let child;
      try {
        child = spawn(pythonExe, [script], {
          env: { ...process.env, HERMES_HOME: hermesHome, PYTHONUTF8: '1' },
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        });
      } catch (err) {
        reject(new Error(`curation: spawn failed: ${err.message}`));
        return;
      }

      let stdout = '';
      let stderr = '';
      let settled = false;
      const finish = (value, error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (error) reject(error);
        else resolve(value);
      };
      const onAbort = () => {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        finish(null, new Error('curation: aborted'));
      };
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        finish(null, new Error(`curation: timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
        if (Buffer.byteLength(stdout, 'utf8') > MAX_STDOUT_BYTES) {
          try { child.kill('SIGKILL'); } catch { /* already gone */ }
          finish(null, new Error('curation: stdout exceeded limit'));
        }
      });
      child.stderr.on('data', (chunk) => {
        if (Buffer.byteLength(stderr, 'utf8') < MAX_STDERR_BYTES) stderr += chunk;
      });
      child.on('error', (err) => finish(null, new Error(`curation: ${err.message}`)));
      child.on('close', (code) => {
        if (settled) return;
        if (code !== 0) {
          finish(null, new Error(`curation adapter exited ${code}: ${stderr.slice(0, 500)}`));
          return;
        }
        try {
          const parsed = JSON.parse(stdout.trim());
          if (!parsed || parsed.success !== true) {
            finish(null, new Error(`curation adapter failed: ${parsed?.error || 'unknown'}`));
            return;
          }
          finish(parsed);
        } catch (err) {
          finish(null, new Error(`curation adapter JSON error: ${err.message}`));
        }
      });
      child.stdin.on('error', (err) => finish(null, new Error(`curation stdin: ${err.message}`)));
      signal?.addEventListener('abort', onAbort, { once: true });
      child.stdin.end('{}');
    });
  }

  async function scan(params = {}) {
    const summary = await runAdapter(params);
    const modules = legacy();
    const usageRecords = Object.entries(summary.usageReport || {}).map(([name, record]) => ({
      name,
      use_count: record?.usedCount,
      last_used_at: record?.lastUsedAt,
      last_activity_at: record?.lastActivityAt,
    }));
    const built = modules.signals.buildSignals({
      graphSummary: summary,
      usageRecords,
      frontmatter: summary.frontmatter,
    });
    const detected = modules.detector.detectCandidates({
      signals: built.signals,
      thresholds: params.thresholds,
      scope: params.scope,
    });

    const state = modules.learningState.loadState(memento);
    modules.learningState.updateSignals(state, built.signals, built.cappedMeta);
    modules.learningState.addHistoryScan(state, {
      runId: `scan-${Date.now()}`,
      startedAt: Date.now(),
      status: 'ok',
      stats: {
        signals: Object.keys(built.signals || {}).length,
        pairs: detected.pairs.length,
      },
    });
    await modules.learningState.saveState(memento, state);

    const candidates = detected.pairs.map(safeCandidate);
    return {
      ok: true,
      graph: summary,
      signals: Object.keys(built.signals || {}).length,
      candidates,
      stats: detected.stats,
    };
  }

  return {
    async graphSummary(params = {}) {
      try {
        return { ok: true, graph: await runAdapter(params) };
      } catch (err) {
        if (log) log(`curation graph failed: ${err.message}`);
        return { ok: false, error: err.message };
      }
    },

    async qualityScan(params = {}) {
      try {
        return await scan(params);
      } catch (err) {
        if (log) log(`skill quality scan failed: ${err.message}`);
        return { ok: false, error: err.message, signals: 0, candidates: [] };
      }
    },
  };
}
