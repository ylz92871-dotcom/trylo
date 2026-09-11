// Trylo Desktop — trylo-runner unit tests. See
// v1.15-handoff §3.1.
//
// We mock @tauri-apps/api so the test runs in plain jsdom
// (no Tauri webview). We assert that startTrylo:
//   - sets the env (apiKey, apiHost, apiModel) when provided
//   - uses the right cli path and prompt
//   - includes the loop-events env var pointing at the
//     workspace's .trylo/ folder
//   - does NOT include the apiKey env var when it's empty
//
// Note: this test imports the .ts source directly (not .tsx),
// so the @vitejs/plugin-react preamble issue doesn't apply.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface SpawnCall {
  command: string;
  args: readonly string[];
  cwd: string;
  env: Record<string, string>;
  label: string;
}

interface SendCall {
  processId: string | undefined;
  line: string;
}

const spawnCalls: SpawnCall[] = [];
const sendCalls: SendCall[] = [];
const stopCalls: string[] = [];
const outputCallbacks: Array<(line: string) => void> = [];
const invokeMock = vi.fn();
let sendError: Error | null = null;

vi.mock('@tauri-apps/api/core', () => {
  return {
    Channel: class {
      onmessage: ((msg: unknown) => void) | null = null;
    },
    invoke: (...args: unknown[]) => {
      invokeMock(...args);
      return Promise.resolve(undefined);
    },
  };
});

vi.mock('./index', async () => {
  return {
    hostAdapter: {
      process: {
        spawn: async (req: {
          command: string;
          args: readonly string[];
          cwd?: string;
          env?: Record<string, string>;
          label: string;
          onOutput: (line: string) => void;
        }) => {
          spawnCalls.push({
            command: req.command,
            args: req.args,
            cwd: req.cwd ?? '',
            env: { ...(req.env ?? {}) },
            label: req.label,
          });
          outputCallbacks.push(req.onOutput);
          // Return a handle with an id so the runner's
          // `handle.id` access doesn't throw, and so the
          // `send` mock can be exercised.
          return { id: `mock-process-${spawnCalls.length}` };
        },
        // v1.16.0: capture stdin writes so the priorMessages
        // context-replay path can be asserted on.
        send: async (processId: string | undefined, line: string) => {
          if (sendError) throw sendError;
          sendCalls.push({ processId, line });
        },
        stop: async (processId: string) => {
          stopCalls.push(processId);
        },
      },
      fs: { readFile: async () => '', statFile: async () => ({ size: 0 }) },
    },
  };
});

// Import after the mock.
import { sendPromptToProcess, startTrylo, startTryloPrewarm } from './trylo-runner';
import type { FilePath } from './types';

beforeEach(() => {
  spawnCalls.length = 0;
  sendCalls.length = 0;
  stopCalls.length = 0;
  outputCallbacks.length = 0;
  sendError = null;
  invokeMock.mockReset();
});

afterEach(() => {
  spawnCalls.length = 0;
  sendCalls.length = 0;
  stopCalls.length = 0;
  outputCallbacks.length = 0;
});

describe('startTrylo (env + args)', () => {
  it('passes the cli path and prompt to spawn', async () => {
    await startTrylo({
      prompt: 'hello',
      cliPath: 'D:/cli/cli.js' as FilePath,
      cwd: 'D:/work' as FilePath,
    });
    expect(spawnCalls).toHaveLength(1);
    const call = spawnCalls[0]!;
    // .js paths are run through `node` (Windows refuses
    // to load a .js as a Win32 PE).
    expect(call.command).toBe('node');
    expect(call.args[0]).toBe('D:/cli/cli.js');
    expect(call.args).not.toContain('hello');
    expect(JSON.parse(sendCalls[0]!.line).message.content[0].text).toBe('hello');
  });

  it('sets CLAUDE_CODE_LOOP_EVENTS_FILE to <cwd>/.trylo/loop-<id>.jsonl', async () => {
    await startTrylo({
      prompt: 'x',
      cliPath: 'D:/cli/cli.js' as FilePath,
      cwd: 'D:/work' as FilePath,
    });
    const call = spawnCalls[0]!;
    const file = call.env.CLAUDE_CODE_LOOP_EVENTS_FILE;
    expect(file).toMatch(/^D:\/work\/\.trylo\/loop-trylo-[a-z0-9]+\.jsonl$/);
  });

  it('includes ANTHROPIC_API_KEY only when set', async () => {
    await startTrylo({
      prompt: 'x',
      cliPath: 'D:/cli/cli.js' as FilePath,
      cwd: 'D:/work' as FilePath,
    });
    expect(spawnCalls[0]!.env.ANTHROPIC_API_KEY).toBeUndefined();

    await startTrylo({
      prompt: 'x',
      cliPath: 'D:/cli/cli.js' as FilePath,
      cwd: 'D:/work' as FilePath,
      apiKey: 'sk-ant-1',
    });
    expect(spawnCalls[1]!.env.ANTHROPIC_API_KEY).toBe('sk-ant-1');
  });

  it('forwards apiHost + apiModel to env when provided', async () => {
    await startTrylo({
      prompt: 'x',
      cliPath: 'D:/cli/cli.js' as FilePath,
      cwd: 'D:/work' as FilePath,
      apiHost: 'https://api.example.com',
      apiModel: 'claude-3-5-sonnet-latest',
    });
    const call = spawnCalls[0]!;
    expect(call.env.ANTHROPIC_BASE_URL).toBe('https://api.example.com');
    expect(call.env.ANTHROPIC_MODEL).toBe('claude-3-5-sonnet-latest');
  });

  it('forwards extraHeadersText as ANTHROPIC_CUSTOM_HEADERS', async () => {
    await startTrylo({
      prompt: 'x',
      cliPath: 'D:/cli/cli.js' as FilePath,
      cwd: 'D:/work' as FilePath,
      extraHeadersText: '{"X-Trace":"1"}',
    });
    expect(spawnCalls[0]!.env.ANTHROPIC_CUSTOM_HEADERS).toBe('{"X-Trace":"1"}');
  });

  it('openai format sets custom auth header (key + prefix)', async () => {
    await startTrylo({
      prompt: 'x',
      cliPath: 'D:/cli/cli.js' as FilePath,
      cwd: 'D:/work' as FilePath,
      apiKey: 'sk-openai-1',
      apiFormat: 'openai',
      apiKeyHeader: 'Authorization',
      apiKeyPrefix: 'Bearer ',
    });
    const env = spawnCalls[0]!.env;
    expect(env.ANTHROPIC_API_KEY).toBe('sk-openai-1');
    expect(env.Authorization).toBe('Bearer sk-openai-1');
  });

  it('uses --bare + --permission-mode + --tools mapped from permissionLevel (P2)', async () => {
    // P2 (spec §4.4): the CLI argv is driven by the resolved
    // permission level, not by the legacy `codeMode`. read_only
    // maps to the CLI's `plan` permission + an empty toolset.
    await startTrylo({
      prompt: 'x',
      cliPath: 'D:/cli/cli.js' as FilePath,
      cwd: 'D:/work' as FilePath,
      permissionLevel: 'read_only',
    });
    const args = spawnCalls[0]!.args;
    expect(args).toContain('--bare');
    expect(args).toContain('--permission-mode');
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('plan');
    // --tools is emitted as a single `--tools=<value>` arg
    // (so clap treats it as a single value, not variadic).
    expect(args).toContain('--tools=');
    // read_only disables built-in tools.
    const toolsIdx = args.findIndex((a) => a.startsWith('--tools='));
    expect(args[toolsIdx]).toBe('--tools=');
  });

  it('unrestricted level maps to bypassPermissions + default tools (P2)', async () => {
    await startTrylo({
      prompt: 'x',
      cliPath: 'D:/cli/cli.js' as FilePath,
      cwd: 'D:/work' as FilePath,
      permissionLevel: 'unrestricted',
    });
    const args = spawnCalls[0]!.args;
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('bypassPermissions');
    expect(args).toContain('--tools=default');
  });

  it('ask level maps to default permission + default tools (P2)', async () => {
    await startTrylo({
      prompt: 'x',
      cliPath: 'D:/cli/cli.js' as FilePath,
      cwd: 'D:/work' as FilePath,
      permissionLevel: 'ask',
    });
    const args = spawnCalls[0]!.args;
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('default');
    expect(args).toContain('--tools=default');
  });

  it('workspace_write level maps to acceptEdits + default tools (P2)', async () => {
    await startTrylo({
      prompt: 'x',
      cliPath: 'D:/cli/cli.js' as FilePath,
      cwd: 'D:/work' as FilePath,
      permissionLevel: 'workspace_write',
    });
    const args = spawnCalls[0]!.args;
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('acceptEdits');
    expect(args).toContain('--tools=default');
  });

  it('systemPrompt is inserted as --append-system-prompt before the prompt', async () => {
    await startTrylo({
      prompt: 'real prompt',
      cliPath: 'D:/cli/cli.js' as FilePath,
      cwd: 'D:/work' as FilePath,
      systemPrompt: 'be terse',
    });
    const args = spawnCalls[0]!.args;
    const idx = args.indexOf('--append-system-prompt');
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toContain('You are Trylo Code');
    expect(args[idx + 1]).toContain('be terse');
    expect(args).not.toContain('real prompt');
    expect(JSON.parse(sendCalls[0]!.line).message.content[0].text).toBe('real prompt');
  });

  it('includes the stream-json + verbose flags', async () => {
    await startTrylo({
      prompt: 'x',
      cliPath: 'D:/cli/cli.js' as FilePath,
      cwd: 'D:/work' as FilePath,
    });
    const call = spawnCalls[0]!;
    const joined = call.args.join(' ');
    expect(joined).toContain('--output-format stream-json');
    expect(joined).toContain('--input-format stream-json');
    expect(joined).toContain('--verbose');
    expect(joined).toContain('--include-partial-messages');
  });

  it('prepends `node` and the script path when cliPath ends in .js', async () => {
    await startTrylo({
      prompt: 'x',
      cliPath: 'D:/custom/cli.mjs' as FilePath,
      cwd: 'D:/work' as FilePath,
    });
    const call = spawnCalls[0]!;
    expect(call.command).toBe('node');
    expect(call.args[0]).toBe('D:/custom/cli.mjs');
  });

  it('does NOT prepend node when cliPath is an executable', async () => {
    await startTrylo({
      prompt: 'x',
      cliPath: 'D:/custom/trylo-core.exe' as FilePath,
      cwd: 'D:/work' as FilePath,
    });
    const call = spawnCalls[0]!;
    expect(call.command).toBe('D:/custom/trylo-core.exe');
  });

  it('returns the real host process id used for stdin writes', async () => {
    const started = await startTrylo({
      prompt: 'x',
      cliPath: 'D:/cli/cli.js' as FilePath,
      cwd: 'D:/work' as FilePath,
    });
    expect(started.processId).toBe('mock-process-1');
    expect(sendCalls[0]!.processId).toBe(started.processId);
  });

  it('stops the spawned process when its initial stdin write fails', async () => {
    sendError = new Error('closed stdin');
    await expect(startTrylo({
      prompt: 'x',
      cliPath: 'D:/cli/cli.js' as FilePath,
      cwd: 'D:/work' as FilePath,
    })).rejects.toThrow('Failed to write the initial Trylo prompt');
    expect(stopCalls).toEqual(['mock-process-1']);
  });

  it('drops stdout owned by a superseded runner', async () => {
    const firstEvents: unknown[] = [];
    const secondEvents: unknown[] = [];
    // v1.16.6 (M4-A): superseding is no longer a module-global
    // generation bumped in startTrylo — each caller supplies a
    // RunGuard. A guard whose snapshot flipped (controller bumped
    // its own generation) silences that runner's stdout.
    let superseded = false;
    await startTrylo({
      prompt: 'first', cliPath: 'D:/cli/cli.js' as FilePath, cwd: 'D:/work' as FilePath,
      runId: 'r1', guard: { isSuperseded: () => superseded },
      onEvents: (events) => firstEvents.push(...events),
    });
    await startTrylo({
      prompt: 'second', cliPath: 'D:/cli/cli.js' as FilePath, cwd: 'D:/work' as FilePath,
      runId: 'r2', guard: { isSuperseded: () => false },
      onEvents: (events) => secondEvents.push(...events),
    });
    superseded = true;
    const resultLine = JSON.stringify({
      type: 'result', subtype: 'success', result: 'done',
      stop_reason: 'end_turn', num_turns: 1, duration_ms: 10,
    });
    outputCallbacks[0]!(resultLine);
    outputCallbacks[1]!(resultLine);
    expect(firstEvents).toHaveLength(0);
    expect(secondEvents).not.toHaveLength(0);
  });
});

describe('sendPromptToProcess', () => {
  it('reports whether the live process accepted the prompt', async () => {
    await expect(sendPromptToProcess('live-1', 'next')).resolves.toBe(true);
    sendError = new Error('process exited');
    await expect(sendPromptToProcess('live-1', 'next')).resolves.toBe(false);
  });
});

// v1.16.0 (context fix): prior messages from the same
// window must be replayed to the CLI's stdin BEFORE the
// new prompt, so the agent sees the full conversation
// context. See extension.js:16630 + extension.js:1725.
describe('startTrylo (priorMessages context replay)', () => {
  it('writes only the new prompt when priorMessages is omitted', async () => {
    await startTrylo({
      prompt: 'hello',
      cliPath: 'D:/cli/cli.js' as FilePath,
      cwd: 'D:/work' as FilePath,
    });
    expect(sendCalls).toHaveLength(1);
    const written = JSON.parse(sendCalls[0]!.line.replace(/\n$/, ''));
    expect(written).toEqual({
      type: 'user',
      session_id: '',
      message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      parent_tool_use_id: null,
    });
  });

  it('bundles prior text history into one non-executable continuation prompt', async () => {
    const prior = [
      { id: 'u1', kind: 'text' as const, role: 'user' as const, createdAt: 1, text: 'first turn' },
      { id: 'a1', kind: 'text' as const, role: 'assistant' as const, createdAt: 2, text: 'first reply' },
      { id: 'u2', kind: 'text' as const, role: 'user' as const, createdAt: 3, text: 'second turn' },
      { id: 'a2', kind: 'text' as const, role: 'assistant' as const, createdAt: 4, text: 'second reply' },
    ];
    await startTrylo({
      prompt: 'third turn',
      cliPath: 'D:/cli/cli.js' as FilePath,
      cwd: 'D:/work' as FilePath,
      priorMessages: prior,
    });
    expect(sendCalls).toHaveLength(1);
    const written = JSON.parse(sendCalls[0]!.line.replace(/\n$/, ''));
    const text = written.message.content[0].text as string;
    expect(text).toContain(JSON.stringify([
      { role: 'user', content: 'first turn' },
      { role: 'assistant', content: 'first reply' },
      { role: 'user', content: 'second turn' },
      { role: 'assistant', content: 'second reply' },
    ]));
    expect(text).toContain('<current_user_message>\nthird turn\n</current_user_message>');
  });

  it('skips thinking / tool / notice messages (only text is context)', async () => {
    const prior = [
      { id: 'u1', kind: 'text' as const, role: 'user' as const, createdAt: 1, text: 'real question' },
      // thinking is the assistant's own state, not context.
      { id: 't1', kind: 'thinking' as const, role: 'assistant' as const, createdAt: 2, summary: 'reasoning', preview: '...', fullLength: 3, partial: false, turn: 1 },
      // tool calls are the assistant's own actions, not context.
      { id: 'tool1', kind: 'tool' as const, role: 'assistant' as const, createdAt: 3, tool: 'Bash', status: 'done' as const, summary: 'ls' },
      // system notice is not part of the conversation.
      { id: 'n1', kind: 'notice' as const, role: 'system' as const, createdAt: 4, text: 'session started' },
      { id: 'a1', kind: 'text' as const, role: 'assistant' as const, createdAt: 5, text: 'real answer' },
    ];
    await startTrylo({
      prompt: 'followup',
      cliPath: 'D:/cli/cli.js' as FilePath,
      cwd: 'D:/work' as FilePath,
      priorMessages: prior,
    });
    expect(sendCalls).toHaveLength(1);
    const text = JSON.parse(sendCalls[0]!.line).message.content[0].text as string;
    expect(text).toContain('real question');
    expect(text).toContain('real answer');
    expect(text).toContain('<current_user_message>\nfollowup');
    expect(text).not.toContain('reasoning');
    expect(text).not.toContain('session started');
  });

  it('skips empty text messages', async () => {
    const prior = [
      { id: 'u1', kind: 'text' as const, role: 'user' as const, createdAt: 1, text: 'real' },
      { id: 'u2', kind: 'text' as const, role: 'user' as const, createdAt: 2, text: '' },
      { id: 'u3', kind: 'text' as const, role: 'user' as const, createdAt: 3, text: '   ' },
      { id: 'a1', kind: 'text' as const, role: 'assistant' as const, createdAt: 4, text: 'reply' },
    ];
    await startTrylo({
      prompt: 'next',
      cliPath: 'D:/cli/cli.js' as FilePath,
      cwd: 'D:/work' as FilePath,
      priorMessages: prior,
    });
    expect(sendCalls).toHaveLength(1);
    const text = JSON.parse(sendCalls[0]!.line).message.content[0].text as string;
    expect(text).toContain(JSON.stringify([
      { role: 'user', content: 'real' },
      { role: 'assistant', content: 'reply' },
    ]));
    expect(text).not.toContain('"content":"   "');
    expect(text).toContain('<current_user_message>\nnext');
  });
});

// v1.16.x (M4-C1 prewarm): the same spawn primitive, but NO prompt
// is written — the CLI idles in its ready loop until a turn adopts
// it. The ready gate is the structured `session_start` event (or the
// raw `system` init mapped to `loop_start`), NOT the Rust
// process_spawn return.
describe('startTryloPrewarm', () => {
  it('spawns an idle CLI and never writes a prompt to stdin', async () => {
    const started = await startTryloPrewarm({
      cliPath: 'D:/cli/cli.js' as FilePath,
      cwd: 'D:/work' as FilePath,
    });
    expect(started.processId).toBe('mock-process-1');
    expect(sendCalls).toHaveLength(0);
    const call = spawnCalls[0]!;
    expect(call.label).toBe('trylo-cli-prewarm');
    expect(call.args).toContain('--bare');
    expect(call.command).toBe('node');
    expect(call.env.CLAUDE_CODE_LOOP_EVENTS_FILE).toMatch(/^D:\/work\/\.trylo\/loop-prewarm-[a-z0-9]+\.jsonl$/);
  });

  it('fires onReady exactly once when session_start arrives', async () => {
    let readyCount = 0;
    await startTryloPrewarm({
      cliPath: 'D:/cli/cli.js' as FilePath,
      cwd: 'D:/work' as FilePath,
      onReady: () => {
        readyCount += 1;
      },
    });
    // A warm prewarm writes no events-file tailer; stdout drives
    // the ready gate. Push multiple ready frames — only the first
    // should report.
    outputCallbacks[0]!(JSON.stringify({ type: 'session_start', sessionId: 's1', ts: 1 }));
    outputCallbacks[0]!(JSON.stringify({ type: 'session_start', sessionId: 's2', ts: 2 }));
    outputCallbacks[0]!(JSON.stringify({ type: 'loop_start', sessionId: 's3', ts: 3 }));
    expect(readyCount).toBe(1);
  });

  it('fires onReady from a raw system init (loop_start translation)', async () => {
    let ready = false;
    await startTryloPrewarm({
      cliPath: 'D:/cli/cli.js' as FilePath,
      cwd: 'D:/work' as FilePath,
      onReady: () => {
        ready = true;
      },
    });
    outputCallbacks[0]!(JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: 'abc',
      model: 'claude-x',
    }));
    expect(ready).toBe(true);
  });
});

// ── events-file tail filter (v1.16.0 context-ring bug) ──────────────
// The CLI writes turn_end (usage → context ring), compaction and
// subagent lifecycle ONLY to the loop-events file. The tailer must
// forward them; stdout-slow-path events must stay excluded to avoid
// duplicate bubbles/cards.
import { isFileOnlyLoopEvent } from './trylo-runner';

describe('isFileOnlyLoopEvent (events-file tail filter)', () => {
  it('forwards file-only events the UI otherwise never sees', () => {
    for (const type of ['turn_end', 'compaction_trigger', 'compact', 'subagent']) {
      expect(isFileOnlyLoopEvent({ type } as never)).toBe(true);
    }
  });

  it('excludes events the stdout slow path already produces', () => {
    for (const type of ['loop_start', 'turn_start', 'text', 'thinking', 'tool_use', 'tool_result', 'loop_end']) {
      expect(isFileOnlyLoopEvent({ type } as never)).toBe(false);
    }
  });
});
