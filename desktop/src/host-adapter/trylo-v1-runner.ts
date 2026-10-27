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
import { registeredProcessIds } from './process-snapshot';
import type { FilePath } from './types';
import type { LoopEvent } from './loop-events';
import type { ProcessExitInfo, ProcessHandle } from './process-service';
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
  readonly contextTokenLimit?: number;
  readonly modelContextWindow?: number;
  /** Desktop instructions appended to the CLI-owned system seeds. */
  readonly systemPrompt?: string;
  readonly permissionLevel?: PermissionLevel;
  readonly teamMode?: boolean;
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
  if (input.contextTokenLimit !== undefined) args.push('--context-window', String(input.contextTokenLimit));
  if (input.modelContextWindow !== undefined) args.push('--model-context-window', String(input.modelContextWindow));
  // WP-CL / B: the switch the person actually enabled, and nothing else.
  if (input.learning !== undefined) args.push(`--learning=${input.learning}`);
  args.push('--append-system-prompt', desktopSystemPrompt(input.systemPrompt));
  args.push('--subagent');
  if (input.teamMode && input.permissionLevel === 'workspace_write') args.push('--allow-writes');
  args.push(...permissionFlagsForV1(input.permissionLevel ?? 'read_only'));
  // `-` = read the prompt from stdin. Required: the prompt must never be
  // an argv value (Windows command-line limits, argv in process logs).
  args.push('-');
  return { command, args };
}

/** Per-process state the runner keeps between spawn and exit. */
interface TryloV1Run {
  handle: ProcessHandle | null;
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
  readonly onTerminal?: (outcome: TryloV1Outcome) => void;
  readonly onExit?: (info: ProcessExitInfo) => void;
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

function hasExited(run: TryloV1Run | undefined): boolean {
  return run?.state === 'exited';
}

/** Native delivery and independent exit confirmation share one terminal owner. */
function observeRunExit(run: TryloV1Run, info: ProcessExitInfo): void {
  if (hasExited(run)) return;
  run.markExited();
  run.state = 'exited';
  if (run.handle && live.get(run.handle.id) === run) {
    live.delete(run.handle.id);
    closeSubagentInputProcess(run.handle.id);
  }
  if (!run.guard.isSuperseded() && info.outputComplete === false) {
    run.onEvents([run.adapter.warn('process_output_incomplete', '进程已退出，尾部输出未完整接收；保留当前可核实结果。')]);
  }
  if (run.binding.state === 'creating') {
    advanceBinding(run, markSessionUnknown(run.binding, `process exited (code ${String(info.code)})`));
  }
  if (!run.guard.isSuperseded() && !run.adapter.hasTerminal) {
    if (run.adapter.rejectedLines().length > 0) {
      run.onEvents([run.adapter.warn('protocol_rejected', run.adapter.describeRejections())]);
    }
    // Missing run_result never proves completion, even with a successful exit.
    const events = run.adapter.finalizeExit({ exitCode: info.code, stderr: run.stderr, cancelled: run.cancelled });
    if (events.length > 0) {
      run.onEvents(events);
      run.onTerminal?.(run.adapter.summary().outcome ?? 'unknown');
    }
  }
  run.onExit?.(info);
}

export interface StartTryloV1Args {
  readonly contextTokenLimit?: number;
  readonly modelContextWindow?: number;
  readonly recoveryIdentity?: import('./process-service').ProcessRecoveryIdentity;
  /** Native ownership is available before the first, possibly blocked write. */
  readonly onSpawn?: (handle: ProcessHandle) => void;
  readonly teamMode?: boolean;
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
    ...(args.contextTokenLimit === undefined ? {} : { contextTokenLimit: args.contextTokenLimit }),
    ...(args.modelContextWindow === undefined ? {} : { modelContextWindow: args.modelContextWindow }),
    ...(args.systemPrompt ? { systemPrompt: args.systemPrompt } : {}),
    permissionLevel: args.permissionLevel ?? 'read_only',
    ...(args.teamMode === undefined ? {} : { teamMode: args.teamMode }),
    ...(args.learning === undefined ? {} : { learning: args.learning }),
  });

  const adapter = new TryloV1EventAdapter();
  let markExited: () => void = () => {};
  const exited = new Promise<void>(resolve => { markExited = resolve; });
  const run: TryloV1Run = {
    handle: null,
    exited, markExited,
    adapter,
    onEvents: args.onEvents,
    guard: args.guard ?? { isSuperseded: () => false },
    stderr: [],
    cancelled: false,
    state: 'spawning',
    binding,
    ...(args.onBindingChange ? { onBindingChange: args.onBindingChange } : {}),
    ...(args.onTerminal ? { onTerminal: args.onTerminal } : {}),
    ...(args.onExit ? { onExit: args.onExit } : {}),
  };

  const pendingControls: ControlFrame[] = [];
  const handle = await hostAdapter.process.spawn({
    command,
    args: cliArgs,
    label: 'trylo-cli-v1',
    cwd: args.cwd,
    env: args.spawnEnv,
    recoveryIdentity: args.recoveryIdentity,
    metadata: {
      ...(args.projectKey ? { projectKey: args.projectKey } : {}),
      ...(args.conversationId ? { conversationId: args.conversationId } : {}),
      ...(args.runId ? { runId: args.runId } : {}),
    },
    onOutput: (line) => {
      if (hasExited(run) || run.guard.isSuperseded()) return;
      const ownerId = run.handle?.id ?? null;
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
      if (hasExited(run) || run.guard.isSuperseded()) return;
      run.stderr.push(line);
      if (run.stderr.length > STDERR_HISTORY) run.stderr.shift();
    },
    onExit: info => observeRunExit(run, info),
  });

  const handleKey = handle.id;
  run.handle = handle;
  if (run.state === 'exited') return { processId: handleKey, state: () => run.state };
  live.set(handleKey, run);
  registerSubagentInputProcess(handleKey);
  try {
    // A late acquired handle still needs an owner after cancellation. Cleanup
    // uses the same bounded stop and actual-exit proof as an ordinary Stop.
    args.onSpawn?.(handle);
    if (run.guard.isSuperseded()) throw new Error('Startup was superseded before prompt dispatch.');
    for (const frame of pendingControls) args.onControlFrame?.(frame, handleKey);
    // Keep stdin open for correlated answers, guidance and cancellation.
    run.state = 'writing_prompt';
    // §6.2: with an established session the CLI owns the context, so
    // replaying history here would duplicate every turn.
    const frame =
      sessionArgs.kind === 'resume'
        ? buildUserPrompt(args.prompt)
        : buildBootstrapUserPrompt(args.priorMessages ?? [], args.prompt);
    const delivered = await completesWithin(Promise.race([
      run.exited, hostAdapter.process.send(handleKey, frame),
    ]), 5000);
    if (!delivered) throw new Error('Initial prompt write acknowledgement timed out.');
  } catch (error) {
    if (hasExited(run)) return { processId: handleKey, state: () => run.state };
    if (!run.guard.isSuperseded()) {
      run.onEvents([adapter.warn('prompt_delivery_uncertain', '提示写入未确认，未自动重试；正在停止原执行，停止失败时请重试停止。')]);
    }
    try { await stopTryloV1(handleKey); }
    catch (cleanupError) {
      // Keep live/subagent ownership until the actual exit callback; both the
      // original delivery failure and the retained cleanup failure matter.
      throw new AggregateError([error, cleanupError], run.guard.isSuperseded()
        ? 'Superseded startup cleanup is unconfirmed.' : 'Failed to write the prompt; process cleanup is unconfirmed.');
    }
    if (run.guard.isSuperseded()) throw new Error('trylo-v1 runner was superseded before prompt dispatch', { cause: error });
    throw new Error('Failed to write the prompt to the trylo-v1 CLI stdin', { cause: error });
  }

  if (!hasExited(run) && !adapter.hasTerminal) run.state = 'streaming';
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
    try {
      const interrupt = hostAdapter.process.send(processId, `${JSON.stringify({ type: 'control_request',
        request_id: `interrupt-${processId}`, request: { subtype: 'interrupt' } })}\n`);
      // The graceful window includes stdin IO. Exit is independent of the
      // IPC receipt; a blocked writer must not hide an already reaped child.
      const graceful = await completesWithin(Promise.race([
        run.exited, interrupt.then(() => run.exited),
      ]), 3000);
      if (graceful) return;
    } catch { /* Broken or older control channels fall back to process-tree termination. */ }
  }
  if (hasExited(run)) return;
  try {
    const receipt = hostAdapter.process.stop(processId);
    const acknowledged = await completesWithin(run ? Promise.race([run.exited, receipt]) : receipt, 5000);
    if (!acknowledged) {
      throw new Error('等待原生停止回执超时，尚未确认进程退出，请重试停止。');
    }
    if (run && !await completesWithin(run.exited, 1000)) {
      throw new Error('Stop command was acknowledged without a process exit receipt; termination is unconfirmed.');
    }
  }
  catch (error) {
    if (hasExited(run)) return;
    if (run && await confirmMissingExit(run, error)) return;
    throw error;
  }
}

/** Native removes this immutable id only after wait(); absent callback data stays unknown. */
async function confirmMissingExit(run: TryloV1Run, stopError: unknown): Promise<boolean> {
  const handle = run.handle;
  if (!handle) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let confirmed: boolean;
  try {
    confirmed = await Promise.race([
      run.exited.then(() => true),
      hostAdapter.process.list().then(rows => !registeredProcessIds(rows).has(handle.id)),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Native process list confirmation timed out.')), 1000);
      }),
    ]);
  } catch (listError) {
    if (hasExited(run)) return true;
    throw new AggregateError([stopError, listError], 'Stop failed; native process list could not confirm exit.');
  } finally { clearTimeout(timer); }
  // Late list settlement has no side effects: only the winning witness acts.
  if (confirmed && !hasExited(run)) {
    observeRunExit(run, { id: handle.id, pid: handle.pid, code: null, signal: null, outputComplete: false });
  }
  return confirmed;
}

/** Releases only this waiter; late IPC settlement remains observed by the race. */
async function completesWithin(completion: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([completion.then(() => true),
      new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); })]);
  } finally { clearTimeout(timer); }
}

/** True while a v1 run owns this process id. */
export function isTryloV1Process(processId: string): boolean {
  return live.has(processId);
}
