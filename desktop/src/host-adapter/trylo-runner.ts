// Trylo Desktop — Trylo CLI runner.
//
// The Trylo CLI (C:/trylo-cli/cli.js) is the
// real agent backend. v1.7.2 ran with a stub. v1.8 wires
// the real thing.
//
// Two output streams:
//   - stream-json on stdout (live text deltas, model typing)
//   - CLAUDE_CODE_LOOP_EVENTS_FILE on disk (28 typed events
//     per docs/EVENT_VOCABULARY.md, polled by a tailer)
//
// v1.16.6 (M4-A runtime ownership): the previous module-level
// `activeRunGeneration` / `activeHostProcessId` made the whole
// app look like ONE Code process: starting run B for another
// conversation made run A's stdout be ignored, and stopping any
// process cleared the single global handle. That global state now
// lives in the per-conversation `CodeRunController` (see
// ../runtime/conversation-run-supervisor.ts). This module stays a
// thin, testable spawn primitive: it emits stdout through a
// caller-provided `guard`, attaches debug metadata, and forwards
// `process.exited` via `onExit`.

import { hostAdapter } from './index';
import { cliSpawnCommand } from './cli-runtime-path';
import { localProcessIdentity } from './process-identity';
import type { FilePath } from './types';
import type { LoopEvent } from './loop-events';
import { legacyConnectionEnv } from './legacy-connection-env';
import { buildUserPrompt, type ControlFrame } from './control-protocol';
import { tailTryloEvents, type TailHandle } from './loop-event-tailer';
export { tailTryloEvents, type TailEventsArgs, type TailHandle } from './loop-event-tailer';
import { StreamTranslator } from './stream-translator';
import { createBinaryMaterializePump } from './binary-materialize-pump';
import {
  codePermissionMode,
  toolsForLevel,
  type PermissionLevel,
} from '../permission/permission-policy';
import type { ChatMessage } from '../components/chat/types';
import type { ProcessExitInfo } from './process-service';
import { desktopSystemPrompt } from './trylo-system-prompt';
export { TRYLO_CODE_IDENTITY_PROMPT } from './trylo-system-prompt';

function promptWithHistory(
  priorMessages: readonly ChatMessage[] | undefined,
  prompt: string,
): string {
  const history = (priorMessages ?? [])
    .filter((m) => m.kind === 'text' && m.text.trim() !== '')
    .map((m) => ({ role: m.role, content: m.kind === 'text' ? m.text : '' }));
  if (history.length === 0) return prompt;
  return [
    'Continue the conversation represented by the JSON history below.',
    'Treat it as prior context only. Respond only to current_user_message.',
    '<conversation_history_json>',
    JSON.stringify(history),
    '</conversation_history_json>',
    '<current_user_message>',
    prompt,
    '</current_user_message>',
  ].join('\n');
}

export interface TryloRunnerOptions {
  /** Absolute path to cli.js. */
  readonly cliPath: FilePath;
  readonly nodeProgram?: string;
  /** Working directory (the user's opened folder). */
  readonly cwd: FilePath;
  /** Anthropic API key. */
  readonly apiKey?: string;
  /** API host (for non-Anthropic endpoints). */
  readonly apiHost?: string;
  /** Model id. */
  readonly apiModel?: string;
  /** Process id returned by Rust's process_spawn. */
  readonly processId: string;
  /** Path to the events file (the host side controls this). */
  readonly eventsFile: FilePath;
  readonly onEvents?: (events: readonly LoopEvent[]) => void;
}

export interface TryloRunner {
  /** Stop tailing. */
  readonly stop: () => void;
}

/** The env + argv a CLI spawn needs. Shared by `startTrylo` (prompt
 *  write) and `startTryloPrewarm` (no prompt, idle). */
export interface BuildCliSpawnArgsInput {
  readonly cliPath: FilePath;
  readonly nodeProgram?: string;
  readonly cwd: FilePath;
  readonly apiKey?: string;
  readonly apiHost?: string;
  readonly apiModel?: string;
  readonly apiFormat?: 'anthropic' | 'openai';
  readonly apiKeyHeader?: string;
  readonly apiKeyPrefix?: string;
  readonly extraHeadersText?: string;
  readonly systemPrompt?: string;
  readonly codeMode?: 'plan' | 'agent' | 'chat';
  /** P2 (spec §4.4): the resolved UI permission level for THIS run.
   *  Snapshotted by `App.onSend` so a mid-run picker change cannot
   *  leak into a running CLI. When omitted, the run is treated as
   *  `workspace_write` (the recommended default) — bare spawn /
   *  prewarm never have a user-driven level, so the default keeps
   *  the legacy CLI surface unchanged. */
  readonly permissionLevel?: PermissionLevel;
  readonly eventsFile: FilePath;
  /**
   * Hermes MCP args (`--mcp-config {...}`) resolved by the Service Host
   * before the spawn (migration spec §7.2 / §7.3). Empty for a normal run:
   * the learning MCP profile is per-run, NEVER a global default, so a plain
   * Code/Work run keeps its current argv. Appended last so it wins over any
   * flag built above.
   *
   * When a Tool Profile was resolved it supplies these instead
   * (`--mcp-config` / `--settings` / `--strict-mcp-config`, spec §4.2).
   */
  readonly extraCliArgs?: readonly string[];
  /**
   * Process-level env contributed by the resolved Tool Profile
   * (spec §4.2). Kept separate from the auth env above so a Profile can
   * never overwrite `ANTHROPIC_*` — the Profile only ever adds keys.
   */
  readonly spawnEnv?: Readonly<Record<string, string>>;
}

// 2026-09-04 (CLI 单核): the workd daemon registration (TRYLO_WORKD_URL /
// TRYLO_WORKD_TOKEN subprocess env) retired with the daemon itself — the CLI
// is the single execution core and the managed-work AgentTool self-degrades.

function buildCliSpawnArgs(input: BuildCliSpawnArgsInput): {
  command: string;
  cliArgs: string[];
  env: Record<string, string>;
} {
  const env: Record<string, string> = {
    TRYLO_DESKTOP_FILE_DIFFS: '1',
    CLAUDE_CODE_LOOP_EVENTS_FILE: input.eventsFile,
    ...legacyConnectionEnv(input),
  };
  // §4.2: a Tool Profile contributes process env, but it must never rewrite
  // the connection/auth keys built above — a Profile is a leaf, not an owner.
  if (input.spawnEnv) {
    for (const [key, value] of Object.entries(input.spawnEnv)) {
      if (key.startsWith('ANTHROPIC_')) continue;
      env[key] = value;
    }
  }

  // This transport belongs to Desktop, including when a tool profile adds env.
  env.TRYLO_DESKTOP_TOOL_POLICY = '1';
  // P2: the permission level is the authoritative source for
  // `--permission-mode` + `--tools`. `codeMode` (chat/plan/agent) is
  // the user's interaction intent — it no longer implies permission.
  // When the caller omits the level (e.g. a prewarm spawn), fall back
  // to the recommended default; bare spawns should never run with an
  // unknown permission shape.
  const permissionLevel: PermissionLevel = input.permissionLevel ?? 'workspace_write';
  const { command, prefix: scriptPrefix } = cliSpawnCommand(input.cliPath, input.nodeProgram);

  const cliArgs = [
    ...scriptPrefix,
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--permission-prompt-tool', 'stdio',
    '--verbose',
    '--include-partial-messages',
    '--bare',
    '--permission-mode', codePermissionMode(permissionLevel),
    // Use `--tools=default` (with `=`) so clap treats it
    // as a single value, not a variadic.
    `--tools=${toolsForLevel(permissionLevel)}`,
  ];
  cliArgs.push('--append-system-prompt', desktopSystemPrompt(input.systemPrompt));
  if (input.extraCliArgs && input.extraCliArgs.length > 0) {
    cliArgs.push(...input.extraCliArgs.slice());
  }
  return { command, cliArgs, env };
}

/**
 * Guard owned by a `CodeRunController`. Start-of-run helpers check
 * it before emitting stdout so a superseded run (the user moved on
 * to another conversation) never projects its output, even though
 * the CLI process keeps running in the background.
 */
export interface RunGuard {
  /** Is this the controller's current run still authoritative? */
  readonly isSuperseded: () => boolean;
}

export interface StartTryloArgs {
  /** The user's prompt. */
  readonly prompt: string;
  /** Path to cli.js. */
  readonly cliPath: FilePath;
  readonly nodeProgram?: string;
  /** Workspace cwd. */
  readonly cwd: FilePath;
  /** API key (used as the `ANTHROPIC_API_KEY` env var). */
  readonly apiKey?: string;
  /** API host (sets `ANTHROPIC_BASE_URL`). */
  readonly apiHost?: string;
  /** Model id (sets `ANTHROPIC_MODEL`). */
  readonly apiModel?: string;
  /** Provider format. 'anthropic' (default) or 'openai'. */
  readonly apiFormat?: 'anthropic' | 'openai';
  /** For non-Anthropic providers: custom auth header name. */
  readonly apiKeyHeader?: string;
  /** For non-Anthropic providers: prefix before the key. */
  readonly apiKeyPrefix?: string;
  /** Raw JSON for extra headers. */
  readonly extraHeadersText?: string;
  /** System prompt override. */
  readonly systemPrompt?: string;
  /** UI code mode. Interaction intent (chat/plan/agent); no longer
   *  drives the CLI permission flags. */
  readonly codeMode?: 'plan' | 'agent' | 'chat';
  /** P2 (spec §4.4): the resolved UI permission level for THIS run.
   *  Required for any user turn — the supervisor snapshots it from
   *  `App.onSend` and refuses to read it from any mutable global.
   *  Prewarm adoption may carry the same level; a different level
   *  cannot reuse a prewarmed process (the argv differs). */
  readonly permissionLevel?: PermissionLevel;
  /** v1.15.7: callback for events parsed from the CLI's stdout. */
  readonly onEvents?: (events: readonly LoopEvent[]) => void;
  /** §6.4 (Code path): permission-prompt-tool stdio control frames
   *  (control_request / control_cancel_request) parsed off the same
   *  stdout stream. Answered via the permission registry. */
  readonly onControlFrame?: (frame: ControlFrame) => void;
  /** Recovery context for a fresh process. */
  readonly priorMessages?: readonly ChatMessage[];
  // M4-A runtime ownership:
  /** Unique id of this development run (the controller's runId). */
  readonly runId?: string;
  /** Guard the controller owns, so superseded runs stay silent.
   *  Defaults to never-superseded when omitted (bare spawn). */
  readonly guard?: RunGuard;
  /** Debug attribution for the Rust process table. */
  readonly projectKey?: string;
  readonly conversationId?: string;
  /** Called once when the child actually exits (process.exited). */
  readonly onExit?: (info: ProcessExitInfo) => void;
  /** Hermes MCP args for THIS run (spec §7.2). Empty ⇒ plain run. A prewarmed
   *  process is never adopted for a run that carries extra args, because its
   *  argv was fixed at prewarm time.
   *
   *  With a resolved Tool Profile this carries the Profile's flags
   *  (`--mcp-config`, `--settings`, `--strict-mcp-config`, spec §4.2).
   *  Config bodies and secrets are NOT in argv — they live in the
   *  content-addressed files the flag values point at (spec §4.2). */
  readonly extraCliArgs?: readonly string[];
  /** §4.2: process-level env contributed by the resolved Tool Profile. */
  readonly spawnEnv?: Readonly<Record<string, string>>;
}

/**
 * Spawn the Trylo CLI with the loop-events env var set. The
 * Rust process_spawn pipes stdout through the existing Channel
 * (live text deltas) and attaches the debug metadata so the
 * process table is attributable to a project / conversation / run.
 */
export async function startTrylo(args: StartTryloArgs): Promise<{
  processId: string;
  eventsFile: FilePath;
}> {
  const guard = args.guard ?? { isSuperseded: () => false };
  // The events file is Unique per run so background runs never
  // share a tail cursor. (The stdout path is the authoritative
  // stream; the events file is retained for the dev probe.)
  const processId = localProcessIdentity('trylo');
  const eventsFile = `${args.cwd}/.trylo/loop-${processId}.jsonl` as FilePath;

  // With `--input-format stream-json`, the CLI reads the user
  // prompt from STDIN as a JSON message, NOT from a positional
  // argv. We do NOT push the prompt here; after spawn returns we
  // write a structured user message to stdin below.
  const { command, cliArgs, env } = buildCliSpawnArgs({
    cliPath: args.cliPath,
    nodeProgram: args.nodeProgram,
    cwd: args.cwd,
    apiKey: args.apiKey,
    apiHost: args.apiHost,
    apiModel: args.apiModel,
    apiFormat: args.apiFormat,
    apiKeyHeader: args.apiKeyHeader,
    apiKeyPrefix: args.apiKeyPrefix,
    extraHeadersText: args.extraHeadersText,
    systemPrompt: args.systemPrompt,
    codeMode: args.codeMode,
    permissionLevel: args.permissionLevel,
    eventsFile,
    extraCliArgs: args.extraCliArgs,
    spawnEnv: args.spawnEnv,
  });

  // v1.15.7: the CLI's events file is unreliable — only
  // session_start lands there. We feed the CLI's stdout
  // (stream-json) through StreamTranslator instead.
  const translator = new StreamTranslator();
  translator.onControlFrame = args.onControlFrame ?? null;
  const pump = createBinaryMaterializePump();

  // P3-B2: the CLI's high-fidelity loop events only land in the events file,
  // never on stdout. Tail it for file-only events: subagent lifecycle (managed-
  // work binding + SubagentCards), `turn_end` usage (the context-window ring),
  // and compaction events. Stopped when the child exits.
  let subagentTail: TailHandle | null = null;

  const handle = await hostAdapter.process.spawn({
    command,
    args: cliArgs,
    label: 'trylo-cli',
    cwd: args.cwd,
    env,
    metadata: {
      projectKey: args.projectKey,
      conversationId: args.conversationId,
      runId: args.runId,
    },
    onOutput: (line: string) => {
      if (guard.isSuperseded()) return;
      const events = translator.feed(line);
      if (events.length > 0 && args.onEvents) {
        pump(events, args.onEvents);
      }
    },
    onExit: (info) => {
      subagentTail?.stop();
      subagentTail = null;
      args.onExit?.(info);
    },
  });
  if (guard.isSuperseded()) {
    await hostAdapter.process.stop(handle.id);
    throw new Error('Trylo runner was superseded before startup completed');
  }

  if (args.onEvents) {
    subagentTail = tailTryloEvents({
      eventsFile,
      onEvents: (events) => {
        if (guard.isSuperseded()) return;
        args.onEvents?.(events);
      },
      filter: isFileOnlyLoopEvent,
    });
  }

  // Send exactly one executable user frame. On recovery, prior
  // text is embedded as inert context inside that frame; separate
  // historical user frames would make stream-json run those old
  // turns again.
  try {
    await hostAdapter.process.send(handle.id, buildUserPrompt(promptWithHistory(args.priorMessages, args.prompt)));
  } catch (error) {
    await hostAdapter.process.stop(handle.id);
    throw new Error('Failed to write the initial Trylo prompt to stdin', {
      cause: error,
    });
  }

  return { processId: handle.id, eventsFile };
}

/** Prompt-free spawn args for prewarming an idle Code CLI.
 *  Shares `buildCliSpawnArgs` with `startTrylo` so the runtime
 *  is configured identically; the ONLY difference is that no
 *  user prompt is written to stdin, so the CLI idles in its
 *  ready loop instead of starting a model turn. */
export interface StartTryloPrewarmArgs {
  readonly cliPath: FilePath;
  readonly nodeProgram?: string;
  readonly cwd: FilePath;
  readonly apiKey?: string;
  readonly apiHost?: string;
  readonly apiModel?: string;
  readonly apiFormat?: 'anthropic' | 'openai';
  readonly apiKeyHeader?: string;
  readonly apiKeyPrefix?: string;
  readonly extraHeadersText?: string;
  readonly systemPrompt?: string;
  readonly codeMode?: 'plan' | 'agent' | 'chat';
  readonly projectKey?: string;
  readonly conversationId?: string;
  readonly runId?: string;
  /** Fired ONCE when the CLI finishes initializing. The ready
   *  gate is the structured `session_start` event (or the raw
   *  `system` init, which the StreamTranslator maps to
   *  `loop_start`) — NOT the Rust `process_spawn` return. */
  readonly onReady?: () => void;
  /** Routes ALL translated events (including ready frames and, once
   *  a turn adopts this idle process, that turn's output). The
   *  caller keeps its own generation guard here, so a superseded
   *  turn's output is dropped while the idle process survives. */
  readonly onEvents?: (events: readonly LoopEvent[]) => void;
  /** §6.4: control frames off the prewarmed process's stdout (a prompt
   *  may later be adopted onto this same process). */
  readonly onControlFrame?: (frame: ControlFrame) => void;
  readonly onExit?: (info: ProcessExitInfo) => void;
  /** P2 (spec §4.4): see `StartTryloArgs.permissionLevel`. A prewarm
   *  process adopts only into a run whose level matches (argv is
   *  fixed at spawn); defaults to `workspace_write` for plain
   *  prewarms. */
  readonly permissionLevel?: PermissionLevel;
  /**
   * Tool Profile flags for a Profile-aware prewarm (spec §9: 「Work 页面预热
   * work.core.v1」). A prewarm spawned with a Profile can only be adopted by
   * a run of the same Profile — the runtime fingerprint decides, not the
   * caller.
   */
  readonly extraCliArgs?: readonly string[];
  /** §4.2: process-level env contributed by the resolved Tool Profile. */
  readonly spawnEnv?: Readonly<Record<string, string>>;
}

/**
 * M4-C1: spawn the Code CLI WITHOUT writing a prompt, leaving it
 * idle so a later turn can adopt it (already parsed the 50.8 MiB
 * bundle) instead of paying cold-start on first send. This starts
 * only the local runtime: no model request, no conversation history.
 */
export async function startTryloPrewarm(
  args: StartTryloPrewarmArgs,
): Promise<{ processId: string; eventsFile: FilePath }> {
  const id = localProcessIdentity('prewarm');
  const eventsFile = `${args.cwd}/.trylo/loop-${id}.jsonl` as FilePath;

  const { command, cliArgs, env } = buildCliSpawnArgs({
    cliPath: args.cliPath,
    nodeProgram: args.nodeProgram,
    cwd: args.cwd,
    apiKey: args.apiKey,
    apiHost: args.apiHost,
    apiModel: args.apiModel,
    apiFormat: args.apiFormat,
    apiKeyHeader: args.apiKeyHeader,
    apiKeyPrefix: args.apiKeyPrefix,
    extraHeadersText: args.extraHeadersText,
    systemPrompt: args.systemPrompt,
    codeMode: args.codeMode,
    permissionLevel: args.permissionLevel,
    eventsFile,
    extraCliArgs: args.extraCliArgs,
    spawnEnv: args.spawnEnv,
  });

  const translator = new StreamTranslator();
  translator.onControlFrame = args.onControlFrame ?? null;
  let reportedReady = false;
  const pump = createBinaryMaterializePump();
  // P3-B2: same file-only tailer as startTrylo — a prewarmed process adopted
  // by a run still writes its subagent / turn_end / compaction events only to
  // the events file.
  let subagentTail: TailHandle | null = null;
  const handle = await hostAdapter.process.spawn({
    command,
    args: cliArgs,
    label: 'trylo-cli-prewarm',
    cwd: args.cwd,
    env,
    metadata: {
      projectKey: args.projectKey,
      conversationId: args.conversationId,
      runId: args.runId,
    },
    onOutput: (line: string) => {
      const events = translator.feed(line);
      if (events.length === 0) return;
      if (!reportedReady) {
        for (const ev of events) {
          if (ev.type === 'session_start' || ev.type === 'loop_start') {
            reportedReady = true;
            args.onReady?.();
            break;
          }
        }
      }
      pump(events, args.onEvents ?? (() => {}));
    },
    onExit: (info) => {
      subagentTail?.stop();
      subagentTail = null;
      args.onExit?.(info);
    },
  });

  if (args.onEvents) {
    subagentTail = tailTryloEvents({
      eventsFile,
      onEvents: (events) => args.onEvents?.(events),
      filter: isFileOnlyLoopEvent,
    });
  }

  return { processId: handle.id, eventsFile };
}

/** Stop a specific CLI process. Idempotent; no module global is
 *  consulted (M4-A: each controller stops only its own child). */
export async function stopTryloProcess(processId: string): Promise<void> {
  await hostAdapter.process.stop(processId);
}

/**
 * v1.16.0: send a raw user prompt to an already-running CLI
 * process. Used for slash commands like `/compact` and for a
 * CodeRunController's warm-path reuse of a live idle CLI.
 */
export async function sendControlLineToProcess(
  processId: string,
  line: string,
): Promise<boolean> {
  const payload = line.endsWith('\n') ? line : `${line}\n`;
  try {
    await hostAdapter.process.send(processId, payload);
    return true;
  } catch {
    // eslint-disable-next-line no-console
    console.warn('[trylo] sendControlLineToProcess: failed to write to', processId);
    return false;
  }
}

export async function sendPromptToProcess(
  processId: string,
  prompt: string,
): Promise<boolean> {
  try {
    await hostAdapter.process.send(processId, buildUserPrompt(prompt));
    return true;
  } catch {
    // Stdin write failure is non-fatal — the CLI is already done
    // or never came up. Surface in console so the dev sees it.
    // eslint-disable-next-line no-console
    console.warn('[trylo] sendPromptToProcess: failed to write to', processId);
    return false;
  }
}

/**
 * Event types the CLI writes ONLY to the loop-events file — they are never
 * synthesized by the stdout StreamTranslator slow path (which translates raw
 * stream-json SDK frames: system/init, assistant text/thinking/tool_use,
 * user tool_result, result). The events-file tailer must forward these or the
 * UI never sees them:
 *
 *  - `turn_end`            — carries `usage.input_tokens`; the context-window
 *                            ring in the InputBar reads the latest TurnMessage.
 *                            Without this the ring never moves (v1.16.0 bug).
 *  - `compaction_trigger` / `compact` — the compaction notice + summary card.
 *  - `subagent`            — managed-work / sub-agent lifecycle binding.
 *  - lifecycle signals     — model_fallback / permission_denied / aborted /
 *                            budget_breached / plan_mode_transition /
 *                            loop_finished (reducer no-ops or renders them).
 *
 * Deliberately EXCLUDED: loop_start, session_start, session_end, turn_start,
 * text, thinking, tool_use, tool_result, loop_end, api_call, api_stream — the
 * stdout slow path already produces these, so forwarding them from the file
 * would duplicate every bubble / tool card.
 */
const FILE_ONLY_EVENT_TYPES: ReadonlySet<LoopEvent['type']> = new Set([
  'turn_end',
  'compaction_trigger',
  'compact',
  'subagent',
  'model_fallback',
  'permission_denied',
  'aborted',
  'budget_breached',
  'plan_mode_transition',
  'loop_finished',
]);

/** Predicate for {@link tailTryloEvents}: forward only file-only events. */
export function isFileOnlyLoopEvent(e: LoopEvent): boolean {
  return FILE_ONLY_EVENT_TYPES.has(e.type);
}
