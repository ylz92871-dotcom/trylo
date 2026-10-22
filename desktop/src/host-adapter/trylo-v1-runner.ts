// Trylo Desktop — one-shot runner for the new Trylo CLI (P08 §3.3/§4.3).
//
// The new CLI's `run` is ONE PROCESS PER TURN: it reads the prompt from
// stdin, streams Trylo Protocol events, emits one `run_result`, and exits.
// Desktop uses one framed prompt and keeps stdin open for correlated
// questions, approvals, guidance and cancellation. The process still exits
// after one turn; context reuse belongs to the CLI session journal.
//
// The lifecycle this class enforces:
//
//   idle → spawning → writing_prompt → streaming
//        → terminal(completed|failed|cancelled|unknown) → exited
//
// and the four invariants (spec §4.3):
//
//   1. one authoritative `run_result` per run, at most;
//   2. after `run_result` the UI may stop being busy, but the process is
//      still awaited for resource reclamation;
//   3. exiting WITHOUT `run_result` yields unknown/failed/cancelled —
//      never a fabricated `completed`;
//   4. an uncertain prompt delivery is never retried automatically: a retry
//      could re-run a turn that already had side effects.

import { hostAdapter } from './index';
import type { FilePath } from './types';
import type { LoopEvent } from './loop-events';
import type { ProcessExitInfo } from './process-service';
import { TryloV1EventAdapter, type TryloV1Outcome } from './trylo-v1-event-adapter';
import {
  markSessionEstablished,
  markSessionUnknown,
  sessionArgsFor,
  type CliSessionBinding,
  type SessionArgs,
} from './cli-session-binding';
import type { PermissionLevel } from '../permission/permission-policy';
import { codePermissionFlagsForV1 as permissionFlagsForV1 } from '../permission/permission-policy';
export { codePermissionFlagsForV1 as permissionFlagsForV1 } from '../permission/permission-policy';
import { cliSpawnCommand } from './cli-runtime-path';
import { buildUserPrompt, type ControlFrame } from './control-protocol';
import { readV1Control, usesV1ApprovalTransport } from './trylo-v1-control';
import { desktopSystemPrompt } from './trylo-system-prompt';
import { reasoningSelectionProblem, type ReasoningEffort } from '../settings/reasoning-effort';
import { registerSubagentInputProcess, closeSubagentInputProcess, consumeSubagentInputResult } from './trylo-v1-subagent-control';

/** stderr lines kept for terminal diagnosis (spec §5.1). */
const STDERR_HISTORY = 20;
const PENDING_CONTROL_LIMIT = 32;

export type TryloV1State =
  | 'idle'
  | 'spawning'
  | 'writing_prompt'
  | 'streaming'
  | 'terminal'
  | 'exited';

/** The v1 argv contract (spec §3.1). */
export interface TryloV1CliArgsInput {
  readonly cliPath: FilePath;
  /**
   * P08 §WP6: the pinned Node interpreter, resolved in the SAME step as
   * `cliPath`. Passing the script without it is what made a bundled Node
   * useless on a machine with none on PATH.
   */
  readonly nodeProgram?: string;
  readonly cwd: FilePath;
  /** M0: `fixture` / `fixture-write`; later `openai-compatible`. */
  readonly providerId?: string;
  readonly endpoint?: string;
  readonly model?: string;
  readonly reasoningEffort?: ReasoningEffort;
  /** Desktop instructions appended to the CLI-owned system seeds. */
  readonly systemPrompt?: string;
  readonly permissionLevel?: PermissionLevel;
  /**
   * WP-CL / B: forwarded verbatim as `--learning=<value>`. Absent keeps the
   * argv unchanged — the CLI's default is "learning off", and a Desktop that
   * guessed would be changing a global switch on the user's behalf.
   */
  readonly learning?: 'method' | 'user' | 'all';
}

export class TryloV1UnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TryloV1UnsupportedError';
  }
}

/**
 * Bootstrap carries only visible user/assistant text, separately from current
 * human authority. Old CLIs ignore this additive field and receive current text.
 */
export function buildBootstrapUserPrompt(
  priorMessages: readonly { readonly role: string; readonly kind: string; readonly text?: string }[],
  prompt: string,
): string {
  const history = priorMessages
    .filter((m) => m.kind === 'text' && (m.role === 'user' || m.role === 'assistant') && (m.text ?? '').trim() !== '')
    .map((m) => ({ role: m.role, content: m.text ?? '' }));
  if (history.length === 0) return buildUserPrompt(prompt);
  return `${JSON.stringify({ type: 'user', session_id: '', message: {
    role: 'user', content: [{ type: 'text', text: prompt }],
  }, parent_tool_use_id: null, bootstrap_context: { version: 1, messages: history } })}\n`;
}

/** Build the one-shot argv. The prompt NEVER travels in argv (spec §3.1). */
export function buildTryloV1Args(input: TryloV1CliArgsInput & {
  /** P08 §6.2: `--session` / `--resume`. Omitted ⇒ ephemeral (M0). */
  readonly session?: SessionArgs;
}): {
  command: string;
  args: string[];
} {
  // P08 §WP6: one helper decides the interpreter, so no module here
  // re-tests the extension and falls back to plain `node`.
  const { command, prefix } = cliSpawnCommand(input.cliPath, input.nodeProgram);
  const problem = reasoningSelectionProblem({ apiModel: input.model, reasoningEffort: input.reasoningEffort });
  if (problem) throw new TryloV1UnsupportedError(problem);
  const args = [
    ...prefix,
    'run',
    '--format', 'stream-json',
    '--workspace', input.cwd,
  ];
  // P08 §6.2: `--resume` once the CLI owns the context, `--session` while
  // it is being created, nothing at all for an ephemeral turn.
  const session = input.session;
  if (session && session.kind === 'resume') args.push('--resume', session.sessionId);
  else if (session && session.kind === 'session') args.push('--session', session.sessionId);
  if (input.providerId) args.push('--provider', input.providerId);
  if (input.endpoint) args.push('--endpoint', input.endpoint);
  if (input.model) args.push('--model', input.model);
  if (input.reasoningEffort !== undefined) args.push('--reasoning-effort', input.reasoningEffort);
  // WP-CL / B: the switch the person actually enabled, and nothing else.
  if (input.learning !== undefined) args.push(`--learning=${input.learning}`);
  args.push('--append-system-prompt', desktopSystemPrompt(input.systemPrompt));
  args.push('--subagent');
  args.push(...permissionFlagsForV1(input.permissionLevel ?? 'read_only'));
  // `-` = read the prompt from stdin. Required: the prompt must never be
  // an argv value (Windows command-line limits, argv in process logs).
  args.push('-');
  return { command, args };
}

/** Per-process state the runner keeps between spawn and exit. */
interface TryloV1Run {
  readonly exited: Promise<void>;
  readonly markExited: () => void;
  readonly adapter: TryloV1EventAdapter;
  readonly onEvents: (events: readonly LoopEvent[]) => void;
  readonly guard: { isSuperseded: () => boolean };
  stderr: string[];
  cancelled: boolean;
  state: TryloV1State;
  /** P08 §6.2: the session binding, advanced as the run progresses. */
  binding: CliSessionBinding;
  readonly onBindingChange?: (binding: CliSessionBinding) => void;
}

function sameBinding(a: CliSessionBinding, b: CliSessionBinding): boolean {
  if (a.state !== b.state) return false;
  const ida = a.state === 'none' ? '' : a.sessionId;
  const idb = b.state === 'none' ? '' : b.sessionId;
  return ida === idb;
}

function advanceBinding(run: TryloV1Run, next: CliSessionBinding): void {
  if (sameBinding(run.binding, next)) return;
  run.binding = next;
  run.onBindingChange?.(next);
}

/** Live runs, keyed by the Rust process id. Needed so `stop` can tell the
 *  exit handler "this was a cancellation", not a crash. */
const live = new Map<string, TryloV1Run>();

export interface StartTryloV1Args {
  readonly reasoningEffort?: ReasoningEffort;
  readonly spawnEnv?: Readonly<Record<string, string>>;
  /** Carries the owner id even when the child answers before start returns. */
  readonly onControlFrame?: (frame: ControlFrame, processId: string) => void;
  readonly prompt: string;
  readonly cliPath: FilePath;
  /** P08 §WP6: pinned Node, resolved with cliPath (never defaulted here). */
  readonly nodeProgram?: string;
  readonly cwd: FilePath;
  readonly providerId?: string;
  readonly endpoint?: string;
  readonly model?: string;
  /** Snapshotted at the caller; late settings changes cannot alter this turn. */
  readonly systemPrompt?: string;
  readonly permissionLevel?: PermissionLevel;
  /** WP-CL / B: forwarded verbatim as `--learning=<value>`; absent stays off. */
  readonly learning?: 'method' | 'user' | 'all';
  readonly projectKey?: string;
  readonly conversationId?: string;
  readonly runId?: string;
  readonly onEvents: (events: readonly LoopEvent[]) => void;
  readonly onTerminal?: (outcome: TryloV1Outcome) => void;
  readonly onExit?: (info: ProcessExitInfo) => void;
  /** P08 §6.2: the conversation's session binding. Omitted ⇒ ephemeral. */
  readonly binding?: CliSessionBinding;
  /** Fired whenever the binding advances (creating → established/unknown). */
  readonly onBindingChange?: (binding: CliSessionBinding) => void;
  /**
   * P08 §6.1: prior turns, carried as bootstrap context when (and only
   * when) this run has no CLI-owned session to continue. Ignored for an
   * established session — the CLI already holds that context.
   */
  readonly priorMessages?: readonly { readonly role: string; readonly kind: string; readonly text?: string }[];
  /** Superseded runs go silent but keep running (M4-A). */
  readonly guard?: { isSuperseded: () => boolean };
}

/**
 * Spawn one CLI process for one turn, hand it the prompt over stdin,
 * project its stream until it exits, retaining stdin only for approvals.
 *
 * Resolves once the prompt is written and the selected transport is ready.
 * Events keep flowing through `onEvents`; process exit is handled separately.
 */
export async function startTryloV1(args: StartTryloV1Args): Promise<{ processId: string; state: () => TryloV1State }> {
  if (usesV1ApprovalTransport(args.permissionLevel) && args.onControlFrame === undefined) {
    throw new TryloV1UnsupportedError('trylo-v1: Desktop approval requires a control-frame handler.');
  }
  const binding: CliSessionBinding = args.binding ?? { state: 'none' };
  const sessionArgs = sessionArgsFor(binding);
  if (sessionArgs.kind === 'needs_probe') {
    // §6.2: an unknown binding must be resolved by a probe, never by a
    // guess. Starting anyway could resume a session that does not exist
    // (exit 52, empty stdout — the UI would hang).
    throw new TryloV1UnsupportedError(
      `trylo-v1: session ${sessionArgs.sessionId} is in an unknown state; probe it before starting a run.`,
    );
  }

  const { command, args: cliArgs } = buildTryloV1Args({
    cliPath: args.cliPath,
    ...(args.nodeProgram ? { nodeProgram: args.nodeProgram } : {}),
    cwd: args.cwd,
    session: sessionArgs,
    ...(args.providerId ? { providerId: args.providerId } : {}),
    ...(args.endpoint ? { endpoint: args.endpoint } : {}),
    ...(args.model ? { model: args.model } : {}),
    ...(args.reasoningEffort === undefined ? {} : { reasoningEffort: args.reasoningEffort }),
    ...(args.systemPrompt ? { systemPrompt: args.systemPrompt } : {}),
    permissionLevel: args.permissionLevel ?? 'read_only',
    ...(args.learning === undefined ? {} : { learning: args.learning }),
  });

  const adapter = new TryloV1EventAdapter();
  let markExited: () => void = () => {};
  const exited = new Promise<void>(resolve => { markExited = resolve; });
  const run: TryloV1Run = {
    exited, markExited,
    adapter,
    onEvents: args.onEvents,
    guard: args.guard ?? { isSuperseded: () => false },
    stderr: [],
    cancelled: false,
    state: 'spawning',
    binding,
    ...(args.onBindingChange ? { onBindingChange: args.onBindingChange } : {}),
  };

  let ownerId: string | null = null;
  const pendingControls: ControlFrame[] = [];
  const handle = await hostAdapter.process.spawn({
    command,
    args: cliArgs,
    label: 'trylo-cli-v1',
    cwd: args.cwd,
    env: args.spawnEnv,
    metadata: {
      ...(args.projectKey ? { projectKey: args.projectKey } : {}),
      ...(args.conversationId ? { conversationId: args.conversationId } : {}),
      ...(args.runId ? { runId: args.runId } : {}),
    },
    onOutput: (line) => {
      if (run.guard.isSuperseded()) return;
      if (consumeSubagentInputResult(line, ownerId)) return;
      const control = readV1Control(line);
      if (control !== null) {
        if (adapter.hasTerminal) return;
        if (ownerId !== null) args.onControlFrame?.(control, ownerId);
        else if (pendingControls.length < PENDING_CONTROL_LIMIT) pendingControls.push(control);
        else run.onEvents([adapter.warn('control_overflow', 'Too many approval frames before process ownership was established.')]);
        return;
      }
      const hadTerminal = adapter.hasTerminal;
      const events = adapter.feed(line);
      if (run.state === 'writing_prompt') run.state = 'streaming';
      if (events.length > 0) {
        // §6.2: `run_start` is the CLI confirming the session it was given.
        //
        // We only accept the confirmation if it names OUR session. An
        // unmatched `run_start` means frames crossed — adopting its id
        // would quietly attach this conversation to another session's
        // journal, which is worse than never confirming (the binding
        // stays `creating`, and a crash lands it in `unknown` where a
        // probe will settle it).
        if (run.binding.state === 'creating' && events.some((e) => e.type === 'loop_start')) {
          const observed = adapter.summary().sessionId;
          if (observed !== null && observed === run.binding.sessionId) {
            advanceBinding(run, markSessionEstablished(run.binding));
          }
        }
        if (adapter.hasTerminal) run.state = 'terminal';
        run.onEvents(events);
        if (!hadTerminal && adapter.hasTerminal) args.onTerminal?.(adapter.summary().outcome ?? 'unknown');
      }
    },
    // Separate channel: a pre-run failure writes ONLY here (spec §4.2).
    onStderr: (line) => {
      if (run.guard.isSuperseded()) return;
      run.stderr.push(line);
      if (run.stderr.length > STDERR_HISTORY) run.stderr.shift();
    },
    onExit: (info) => {
      run.markExited();
      run.state = 'exited';
      // §6.2: died mid-creation ⇒ the session's fate is genuinely unknown.
      // Never assume the journal exists because "a file might be there".
      if (run.binding.state === 'creating') {
        advanceBinding(
          run,
          markSessionUnknown(run.binding, `process exited (code ${String(info.code)})`),
        );
      }
      if (!run.guard.isSuperseded() && !adapter.hasTerminal) {
        // Audit finding: when stdout carried bytes the wire guard
        // refused, "the run ended without a terminal event" is not the
        // real story — a protocol mismatch is. Say so, through the same
        // visible channel a CLI warning uses.
        if (adapter.rejectedLines().length > 0) {
          const warning = adapter.warn('protocol_rejected', adapter.describeRejections());
          run.onEvents([warning]);
        }
        // No authoritative terminal: synthesise one. `finalizeExit`
        // never reports `completed` (spec §4.3).
        const events = adapter.finalizeExit({
          exitCode: info.code,
          stderr: run.stderr,
          cancelled: run.cancelled,
        });
        if (events.length > 0) {
          run.onEvents(events);
          args.onTerminal?.(adapter.summary().outcome ?? 'unknown');
        }
      }
      if (ownerId !== null) { live.delete(ownerId); closeSubagentInputProcess(ownerId); }
      args.onExit?.(info);
    },
  });

  const handleKey = handle.id;
  ownerId = handleKey;
  if (run.state === 'exited') return { processId: handleKey, state: () => run.state };
  live.set(handleKey, run);
  registerSubagentInputProcess(handleKey);
  if (run.guard.isSuperseded()) {
    live.delete(handleKey);
    closeSubagentInputProcess(handleKey);
    await hostAdapter.process.stop(handleKey).catch(() => undefined);
    throw new Error('trylo-v1 runner was superseded before startup completed');
  }
  for (const frame of pendingControls) args.onControlFrame?.(frame, handleKey);

  // Keep stdin open for correlated answers, guidance and cancellation.
  run.state = 'writing_prompt';
  try {
    // §6.2: with an established session the CLI owns the context, so
    // replaying history here would duplicate every turn.
    const frame =
      sessionArgs.kind === 'resume'
        ? buildUserPrompt(args.prompt)
        : buildBootstrapUserPrompt(args.priorMessages ?? [], args.prompt);
    await hostAdapter.process.send(handleKey, frame);
  } catch (error) {
    live.delete(handleKey);
    await hostAdapter.process.stop(handleKey).catch(() => undefined);
    closeSubagentInputProcess(handleKey);
    throw new Error('Failed to write the prompt to the trylo-v1 CLI stdin', { cause: error });
  }

  if (!adapter.hasTerminal) run.state = 'streaming';
  return { processId: handleKey, state: () => run.state };
}

/**
 * Ask the CLI to cancel and seal its journal; terminate the process tree if
 * an older or unresponsive control channel cannot acknowledge by exiting.
 */
export async function stopTryloV1(processId: string): Promise<void> {
  const run = live.get(processId);
  if (run) {
    run.cancelled = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await hostAdapter.process.send(processId, `${JSON.stringify({ type: 'control_request',
        request_id: `interrupt-${processId}`, request: { subtype: 'interrupt' } })}\n`);
      const graceful = await Promise.race([run.exited.then(() => true),
        new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), 3000); })]);
      if (graceful) return;
    } catch { /* Broken or older control channels fall back to process-tree termination. */ }
    finally { clearTimeout(timer); }
  }
  await hostAdapter.process.stop(processId);
}

/** True while a v1 run owns this process id. */
export function isTryloV1Process(processId: string): boolean {
  return live.has(processId);
}
