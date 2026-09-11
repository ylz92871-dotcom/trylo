'use strict';

/*
 * prompt-client.js
 *
 * Node-side async client that calls the learning_prompt_adapter.py to fetch
 * official Hermes 0.19.0 prompts. Uses async spawn (never spawnSync).
 *
 * Reuses hermes-python-resolver.js for the Hermes Python interpreter and
 * Trylo-owned HERMES_HOME.
 */

const path = require('node:path');
const { spawn } = require('node:child_process');
const { resolveHermesPython } = require('../hermes-python-resolver');
const { getHermesHome } = require('../hermes-capability-manager');

// PATCH 6 (see desktop-services/vendor/PATCHES.md): resolve the Python
// capabilities dir from the host env (fallback keeps the upstream layout).
const ADAPTER_SCRIPT = path.join(
  process.env.TRYLO_HERMES_CAPABILITIES_DIR || path.join(__dirname, '..', 'hermes-capabilities'),
  'learning_prompt_adapter.py',
);

const TIMEOUT_MS = 15000;
const MAX_STDOUT_BYTES = 500 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const MAX_PROMPT_LENGTH = 200 * 1024;
const EXPECTED_HERMES_VERSION = '0.19.0';
const SHA256_RE = /^sha256:[0-9a-f]{64}$/;

/**
 * Strictly validate the adapter response against the expected schema.
 * Returns { valid: true } or { valid: false, error: string }.
 */
function _validatePromptResult(parsed, expectedMode) {
  if (!parsed || typeof parsed !== 'object') {
    return { valid: false, error: 'adapter output is not an object' };
  }
  if (parsed.success !== true) {
    return { valid: false, error: String(parsed.error || 'adapter reported failure') };
  }
  const mode = String(parsed.mode || '').trim().toLowerCase();
  if (mode !== String(expectedMode || '').trim().toLowerCase()) {
    return { valid: false, error: `mode mismatch: expected ${expectedMode}, got ${mode}` };
  }
  if (String(parsed.hermesVersion || '').trim() !== EXPECTED_HERMES_VERSION) {
    return { valid: false, error: `hermes version mismatch: expected ${EXPECTED_HERMES_VERSION}, got ${parsed.hermesVersion}` };
  }
  const prompt = parsed.prompt;
  if (typeof prompt !== 'string' || prompt.trim().length === 0) {
    return { valid: false, error: 'prompt is not a non-empty string' };
  }
  if (prompt.length > MAX_PROMPT_LENGTH) {
    return { valid: false, error: `prompt exceeds length limit (${prompt.length} > ${MAX_PROMPT_LENGTH})` };
  }
  const hash = String(parsed.promptHash || '').trim();
  if (!SHA256_RE.test(hash)) {
    return { valid: false, error: `promptHash is not a valid sha256 hash: ${hash.slice(0, 40)}` };
  }
  // Verify hash matches the prompt
  const crypto = require('node:crypto');
  const computed = 'sha256:' + crypto.createHash('sha256').update(prompt, 'utf8').digest('hex');
  if (computed !== hash) {
    return { valid: false, error: 'promptHash does not match the prompt content' };
  }
  return { valid: true };
}

/**
 * Call the Python prompt adapter.
 *
 * @param {object} params
 * @param {string} params.mode - 'implicit' | 'explicit'
 * @param {string} [params.request] - user request for explicit /learn
 * @param {string} [params.globalStoragePath] - VS Code globalStorage path for HERMES_HOME
 * @returns {Promise<{ success: boolean, mode: string, prompt?: string, hermesVersion?: string, promptHash?: string, error?: string }>}
 */
function fetchPrompt({ mode, request, globalStoragePath }) {
  return new Promise((resolve, reject) => {
    let pythonExe;
    try {
      pythonExe = resolveHermesPython();
    } catch (err) {
      // Hermes unavailable — fail closed, Learning degrades gracefully
      resolve({
        success: false,
        error: `Hermes Python not found: ${err.message}`,
      });
      return;
    }

    const input = JSON.stringify({
      mode: mode || 'implicit',
      request: String(request || ''),
    });

    const hermesHome = globalStoragePath
      ? getHermesHome(globalStoragePath)
      : (process.env.HERMES_HOME || '');

    const child = spawn(pythonExe, [ADAPTER_SCRIPT], {
      env: {
        ...process.env,
        HERMES_HOME: hermesHome,
        PYTHONUTF8: '1',
        PYTHONIOENCODING: 'utf-8',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill();
        resolve({
          success: false,
          error: 'Prompt adapter timed out',
        });
      }
    }, TIMEOUT_MS);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (Buffer.byteLength(stdout, 'utf8') > MAX_STDOUT_BYTES) {
        if (!settled) {
          settled = true;
          child.kill();
          resolve({
            success: false,
            error: 'Prompt adapter stdout exceeded limit',
          });
        }
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => {
      stderr += chunk;
      if (Buffer.byteLength(stderr, 'utf8') > MAX_STDERR_BYTES) {
        stderr = stderr.slice(0, MAX_STDERR_BYTES);
      }
    });

    child.on('error', err => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({
          success: false,
          error: `Prompt adapter spawn failed: ${err.message}`,
        });
      }
    });

    child.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      if (code !== 0) {
        resolve({
          success: false,
          error: `Prompt adapter exited ${code}: ${stderr.slice(0, 500)}`,
        });
        return;
      }

      try {
        const parsed = JSON.parse(stdout.trim());
        const validation = _validatePromptResult(parsed, mode);
        if (!validation.valid) {
          resolve({ success: false, error: validation.error });
          return;
        }
        resolve(parsed);
      } catch (err) {
        resolve({
          success: false,
          error: `Prompt adapter JSON parse error: ${err.message}`,
        });
      }
    });

    // Handle stdin EPIPE — child may exit before we finish writing
    child.stdin.on('error', err => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        try { child.kill(); } catch {}
        resolve({
          success: false,
          error: `Prompt adapter stdin error: ${err.message}`,
        });
      }
    });

    try {
      child.stdin.write(input);
      child.stdin.end();
    } catch (err) {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({
          success: false,
          error: `Prompt adapter stdin write failed: ${err.message}`,
        });
      }
    }
  });
}

module.exports = { fetchPrompt, TIMEOUT_MS, _validatePromptResult, EXPECTED_HERMES_VERSION };