// Internal prompt transport only. The official Python functions own wording.
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { resolveHermesPython } = require('../vendor/legacy/hermes-python-resolver.js');
const { getHermesHome } = require('../vendor/legacy/hermes-capability-manager.js');
const { _validatePromptResult } = require('../vendor/legacy/learning-loop/prompt-client.js');
const script = fileURLToPath(new URL('./native-prompt.py', import.meta.url));
const capabilities = fileURLToPath(new URL('../vendor/legacy/hermes-capabilities/', import.meta.url));
const unavailable = () => ({ success: false, error: 'hermes_native_prompt_unavailable' });

/** No request text in argv, no global env mutation, no raw process diagnostics. */
export async function fetchNativePrompt({ mode, request = '', globalStoragePath } = {}) {
  if (!['implicit', 'explicit'].includes(mode) || typeof request !== 'string' || request.length > 128_000
    || globalStoragePath !== undefined && typeof globalStoragePath !== 'string') {
    return { success: false, error: 'hermes_native_prompt_invalid' };
  }
  let python, home;
  try {
    python = resolveHermesPython();
    home = globalStoragePath ? getHermesHome(globalStoragePath) : process.env.HERMES_HOME ?? '';
  } catch { return unavailable(); }
  return new Promise(resolve => {
    let child;
    try {
      child = execFile(python, [script, '--capabilities-dir', capabilities], {
        encoding: 'utf8', timeout: 15_000, maxBuffer: 500 * 1024, windowsHide: true,
        env: { ...process.env, HERMES_HOME: home, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
      }, (error, stdout) => {
        if (error) { resolve(unavailable());return; }
        try {
          const parsed = JSON.parse(stdout);
          resolve(_validatePromptResult(parsed, mode).valid ? parsed : unavailable());
        } catch { resolve(unavailable()); }
      });
      if (!child.stdin) { child.kill();resolve(unavailable());return; }
      child.stdin.on('error', () => { child.kill();resolve(unavailable()); });
      child.stdin.end(JSON.stringify({ mode, request }));
    } catch {
      // A synchronous spawn/stdin failure has the same fixed failure boundary.
      child?.kill();resolve(unavailable());
    }
  });
}
