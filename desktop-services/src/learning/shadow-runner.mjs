// Trylo Desktop Services — shadow CLI runner for the learning loop.
// See migration spec §7.6 / architecture doc §6.5.
//
// The learning orchestrator runs a SEPARATE, invisible CLI turn to review a
// finished task and propose memory/skill updates. It never touches the user's
// conversation: no events, no prompts, no transcript is persisted — only the
// evidence capsule the orchestrator builds (arch §6.5: 严禁把 events 或用户
// 原话入库).
//
// Ownership: this is the sidecar's own CLI invocation. The renderer has its
// own spawn path (`host-adapter/trylo-runner.ts`); the two MUST keep the same
// argv shape, so any change here must be mirrored there. Only the learning
// MCP args differ — they come from `learning.mcpArgs('learning')`.
//
// Failure policy: any failure resolves to a rejected promise with a short
// reason. The orchestrator records it as a diagnostic and the user's main
// task is never affected (spec §7.6: 失败只记 diagnostics，不阻断主功能).

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_STDOUT_BYTES = 8 * 1024 * 1024;
const MAX_ANSWER_CHARS = 64 * 1024;

function defaultArgv() {
  // Keep in sync with host-adapter/trylo-runner.ts buildCliSpawnArgs.
  return [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--bare',
  ];
}

/**
 * @param {{ mcpArgs: { mcpArgs: (p: object) => object },
 *           log?: (m: string) => void,
 *           spawn?: ((cmd: string, args: string[], opts: object) => object)|null }} options
 *   `spawn` is a test seam only.
 */
export function createShadowRunner({ mcpArgs, log = null, spawn: injectedSpawn = null } = {}) {
  const spawnFn = injectedSpawn ?? spawn;
  let cli = null;

  return {
    /** Per-run CLI configuration, supplied by the renderer (spec §6.4:
     *  config comes from Desktop settings, never from the sidecar). */
    configure(next) {
      if (next && next.cliPath) cli = next;
    },

    get configured() {
      return Boolean(cli);
    },

    /**
     * @param {string} prompt
     * @param {{ timeoutMs?: number, signal?: AbortSignal,
     *           profile?: 'learning'|'history' }} [options]
     * @returns {Promise<{ answer: string }>}
     */
    run(prompt, options = {}) {
      return new Promise((resolve, reject) => {
        if (!cli || !cli.cliPath) {
          reject(new Error('shadow run: no CLI configured'));
          return;
        }
        const profile = options.profile === 'history' ? 'history' : 'learning';
        const built = mcpArgs.mcpArgs({ profile });
        if (!built.ok) {
          const warning = built.warning ?? 'unknown';
          if (log) log(`shadow run: ${profile} MCP unavailable (${warning}); refusing plain fallback`);
          reject(new Error(`shadow run: ${profile} MCP unavailable (${warning})`));
          return;
        }
        if (options.signal?.aborted) {
          reject(new Error('shadow run: aborted'));
          return;
        }
        const nodeScript = /\.(m?js|cjs)$/i.test(cli.cliPath);
        const command = nodeScript ? 'node' : cli.cliPath;
        const args = [
          ...(nodeScript ? [cli.cliPath] : []),
          ...defaultArgv(),
          ...built.arg,
        ];

        const env = { ...process.env, CLAUDE_CODE_LOOP_EVENTS_FILE: '' };
        if (cli.apiKey) env.ANTHROPIC_API_KEY = cli.apiKey;
        if (cli.apiHost) env.ANTHROPIC_BASE_URL = cli.apiHost;
        if (cli.apiModel) env.ANTHROPIC_MODEL = cli.apiModel;
        if (cli.apiFormat === 'openai' && cli.apiKeyHeader) {
          env[cli.apiKeyHeader] = `${cli.apiKeyPrefix ?? ''}${cli.apiKey}`;
        }
        if (cli.extraHeadersText) env.ANTHROPIC_CUSTOM_HEADERS = cli.extraHeadersText;

        let shadowCwd;
        try {
          // A learning run must never inherit the user's project as cwd. The
          // MCP profile supplies the only allowed capabilities; the process
          // itself starts in an isolated, disposable directory.
          shadowCwd = mkdtempSync(join(tmpdir(), `trylo-${profile}-`));
        } catch (err) {
          reject(new Error(`shadow run: could not create isolated cwd: ${err.message}`));
          return;
        }

        let child;
        try {
          child = spawnFn(command, args, {
            cwd: shadowCwd,
            env,
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
          });
        } catch (err) {
          try { rmSync(shadowCwd, { recursive: true, force: true }); } catch { /* best effort */ }
          reject(new Error(`shadow run: spawn failed: ${err.message}`));
          return;
        }

        let answer = '';
        let stdoutBytes = 0;
        let buffer = '';
        let settled = false;
        let cleaned = false;
        const cleanupShadowCwd = () => {
          if (cleaned) return;
          try {
            rmSync(shadowCwd, { recursive: true, force: true });
            cleaned = true;
          } catch { /* retry after child close */ }
        };
        const abort = () => {
          try { child.kill('SIGKILL'); } catch { /* gone */ }
          finish(null, new Error('shadow run: aborted'));
        };
        const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
        const timer = setTimeout(() => {
          try { child.kill('SIGKILL'); } catch { /* gone */ }
          finish(null, new Error(`shadow run: timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        function finish(value, error) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          options.signal?.removeEventListener('abort', abort);
          try { child.stdout.removeAllListeners('data'); } catch { /* gone */ }
          try { child.stdin.removeAllListeners('error'); } catch { /* gone */ }
          cleanupShadowCwd();
          if (error) reject(error);
          else resolve({ answer });
        }

        function consume(line) {
          if (!line) return;
          let frame;
          try {
            frame = JSON.parse(line);
          } catch {
            return; // Non-JSON chatter on stdout is ignored, not fatal.
          }
          // Collect assistant text deltas only. The learning prompt asks for
          // a structured answer; the orchestrator parses it, not us.
          const message = frame && frame.message;
          const content = message && Array.isArray(message.content) ? message.content : null;
          if (frame && frame.type === 'assistant' && content) {
            for (const part of content) {
              if (part && part.type === 'text' && typeof part.text === 'string') {
                if (answer.length < MAX_ANSWER_CHARS) answer += part.text;
              }
            }
          }
        }

        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk) => {
          stdoutBytes += Buffer.byteLength(chunk, 'utf8');
          if (stdoutBytes > MAX_STDOUT_BYTES) {
            try { child.kill('SIGKILL'); } catch { /* gone */ }
            finish(null, new Error('shadow run: stdout exceeded limit'));
            return;
          }
          buffer += chunk;
          let index = buffer.indexOf('\n');
          while (index >= 0) {
            consume(buffer.slice(0, index).trim());
            buffer = buffer.slice(index + 1);
            index = buffer.indexOf('\n');
          }
        });
        child.stderr.on('data', () => { /* diagnostics only; never logged verbatim */ });
        child.on('error', (err) => finish(null, new Error(`shadow run: ${err.message}`)));
        child.on('close', (code) => {
          if (settled) {
            cleanupShadowCwd();
            return;
          }
          consume(buffer.trim());
          if (code !== 0 && !answer) {
            finish(null, new Error(`shadow run: CLI exited ${code}`));
            return;
          }
          finish({ answer });
        });

        options.signal?.addEventListener('abort', abort, { once: true });

        try {
          child.stdin.write(`${JSON.stringify({
            type: 'user',
            message: { role: 'user', content: prompt },
          })}\n`);
          child.stdin.end();
        } catch (err) {
          finish(null, new Error(`shadow run: stdin write failed: ${err.message}`));
        }
      });
    },
  };
}
