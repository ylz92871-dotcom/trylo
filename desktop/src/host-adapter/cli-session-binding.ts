// Trylo Desktop — new-CLI session binding (P08 §6.2 / WP4).
//
// M0 ran every turn on an ephemeral session with the history stuffed
// into the prompt. That is fine for a two-turn dev loop and wrong for
// real use: long histories, compaction and crash recovery all need the
// CLI to own the context. This module is the M2 binding.
//
// The hard rule from §6.2: after a crash during creation the binding is
// `unknown`, and the ONLY way out is a structured probe — asking the CLI
// whether that session is resumable. We must never infer success from
// "a file might exist on disk": the CLI owns the journal format, the
// lock and the format version, so it is the only thing that can answer.
//
// Verified 2026-09-22 against the real CLI:
//   --session desktop-<uuid>  → accepted, echoing the same sessionId
//   --resume  desktop-<uuid>  → continues the same session
//   session list --json       → {"sessions":[{id,path,bytes,…}]}

import { hostAdapter } from './index';
import type { FilePath } from './types';
import { cliSpawnCommand } from './cli-runtime-path';

export type CliSessionBinding =
  | { readonly state: 'none' }
  | { readonly state: 'creating'; readonly sessionId: string; readonly runId: string }
  | { readonly state: 'established'; readonly sessionId: string }
  | { readonly state: 'unknown'; readonly sessionId: string; readonly reason: string };

/** Prefix marks Desktop-owned sessions in the CLI's own list. */
const SESSION_PREFIX = 'desktop-';

/** How long the read-only session probe may take. */
const DEFAULT_PROBE_TIMEOUT_MS = 5000;

/**
 * A fresh session id.
 *
 * Unpredictable on purpose (§6.2: 「生成不可预测且合法的 sessionId」) — a
 * guessable id lets one conversation's run attach to another's session
 * journal. Uses the platform CSPRNG; the fallback exists only for
 * environments without `crypto.randomUUID` and still draws from
 * `getRandomValues`.
 */
export function newCliSessionId(random: () => string = randomHex): string {
  return `${SESSION_PREFIX}${random()}`;
}

function randomHex(): string {
  const c: Crypto | undefined = typeof globalThis.crypto === 'undefined' ? undefined : globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  if (c && typeof c.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    c.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  // Last resort. NOT silent: a predictable session id is a correctness
  // and isolation problem, so callers must be able to see this happened.
  // eslint-disable-next-line no-console
  console.warn('[trylo-v1] no CSPRNG available; session id is not unpredictable');
  return `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

/** Start creating a session for a run. */
export function beginSessionCreate(runId: string, sessionId?: string): CliSessionBinding {
  return {
    state: 'creating',
    sessionId: sessionId ?? newCliSessionId(),
    runId,
  };
}

/** The CLI confirmed the session (we saw `run_start` for it). */
export function markSessionEstablished(binding: CliSessionBinding): CliSessionBinding {
  if (binding.state === 'none') return binding;
  return { state: 'established', sessionId: binding.sessionId };
}

/**
 * The run died before we could learn whether its session exists.
 *
 * stays `unknown` until a probe answers — there is no safe default.
 */
export function markSessionUnknown(binding: CliSessionBinding, reason: string): CliSessionBinding {
  if (binding.state === 'none') return binding;
  return { state: 'unknown', sessionId: binding.sessionId, reason };
}

/** What to put on the CLI's argv for this binding. */
export type SessionArgs =
  /** No session flag: an ephemeral, one-shot turn (M0 behaviour). */
  | { readonly kind: 'none' }
  /** First turn of a new session. */
  | { readonly kind: 'session'; readonly sessionId: string }
  /** Continuing an established session. */
  | { readonly kind: 'resume'; readonly sessionId: string }
  /** `unknown` and not yet probed: the caller MUST resolve it first. */
  | { readonly kind: 'needs_probe'; readonly sessionId: string };

export function sessionArgsFor(binding: CliSessionBinding): SessionArgs {
  switch (binding.state) {
    case 'none':
      return { kind: 'none' };
    case 'creating':
      // Creating is retried with the SAME id: re-inventing one here would
      // orphan the first attempt's journal.
      return { kind: 'session', sessionId: binding.sessionId };
    case 'established':
      return { kind: 'resume', sessionId: binding.sessionId };
    case 'unknown':
      return { kind: 'needs_probe', sessionId: binding.sessionId };
    default:
      return { kind: 'none' };
  }
}

export interface CliSessionEntry {
  readonly id: string;
  readonly bytes: number;
}

export type CliSessionProbe =
  | { readonly ok: true; readonly sessions: readonly CliSessionEntry[] }
  | { readonly ok: false; readonly reason: 'spawn_failed' | 'timeout' | 'nonzero_exit' | 'malformed_json' | 'bad_shape'; readonly detail: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseSessionList(
  line: string,
): { ok: true; sessions: CliSessionEntry[] } | { ok: false; reason: 'malformed_json' | 'bad_shape' } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch {
    return { ok: false, reason: 'malformed_json' };
  }
  if (!isRecord(parsed) || !Array.isArray(parsed['sessions'])) {
    return { ok: false, reason: 'bad_shape' };
  }
  const sessions: CliSessionEntry[] = [];
  for (const raw of parsed['sessions']) {
    if (!isRecord(raw)) return { ok: false, reason: 'bad_shape' };
    const id = raw['id'];
    if (typeof id !== 'string') return { ok: false, reason: 'bad_shape' };
    sessions.push({ id, bytes: typeof raw['bytes'] === 'number' ? raw['bytes'] : 0 });
  }
  return { ok: true, sessions };
}

/**
 * Ask the CLI which sessions it considers resumable.
 *
 * Read-only and one-shot, run through the same process bridge (stdin
 * closed immediately, bounded by a timeout) so a hung CLI cannot wedge
 * the app.
 */
export async function probeCliSessions(args: {
  readonly cliPath: FilePath;
  /** Pinned Node from the same resolution as cliPath. */
  readonly nodeProgram?: string;
  /** Recover only this association; avoid parsing unrelated journals. */
  readonly sessionId?: string;
  readonly timeoutMs?: number;
}): Promise<CliSessionProbe> {
  const timeoutMs = args.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  // P08 §WP6: interpreter and script travel together.
  const { command, prefix } = cliSpawnCommand(args.cliPath, args.nodeProgram);

  let stdout = '';
  let lines = 0;
  let exitCode: number | null = null;
  const gate: { resolve: (() => void) | null } = { resolve: null };
  const done = new Promise<void>((resolve) => {
    gate.resolve = resolve;
  });

  let handle: { id: string } | null = null;
  try {
    handle = await hostAdapter.process.spawn({
      command,
      args: [...prefix, 'session', 'list', '--json',
        ...(args.sessionId ? ['--search', args.sessionId, '--all'] : [])],
      label: 'trylo-cli-session-probe',
      onOutput: (line) => {
        lines += 1;
        stdout = lines === 1 ? line : `${stdout}\n${line}`;
      },
      onExit: (info) => {
        exitCode = info.code;
        gate.resolve?.();
      },
    });
    await hostAdapter.process.closeInput(handle.id).catch(() => undefined);
  } catch (error) {
    gate.resolve?.();
    return {
      ok: false,
      reason: 'spawn_failed',
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timer = new Promise<void>((resolve) => {
    timeout = setTimeout(resolve, timeoutMs);
  });
  await Promise.race([done, timer]);
  clearTimeout(timeout);
  if (exitCode === null) {
    await hostAdapter.process.stop(handle.id).catch(() => undefined);
    return { ok: false, reason: 'timeout', detail: `no exit within ${timeoutMs}ms` };
  }
  if (exitCode !== 0) return { ok: false, reason: 'nonzero_exit', detail: `exit=${exitCode}` };
  const parsed = parseSessionList(stdout);
  if (!parsed.ok) return { ok: false, reason: parsed.reason, detail: stdout.slice(0, 200) };
  return { ok: true, sessions: parsed.sessions };
}

/**
 * Is this session resumable? `null` means we could not find out.
 *
 * Three-valued on purpose: `false` ("the CLI says no") and `null`
 * ("we don't know") must not collapse into the same branch, or a probe
 * failure would silently drop the user's history.
 */
export function isSessionResumable(probe: CliSessionProbe, sessionId: string): boolean | null {
  if (!probe.ok) return null;
  return probe.sessions.some((s) => s.id === sessionId);
}

/**
 * Resolve an `unknown` binding using a real probe answer.
 *
 *   resumable === true   → established (keep the history)
 *   resumable === false  → none (start a fresh session)
 *   resumable === null   → stay unknown (fail closed; never guess)
 */
export function resolveUnknownBinding(
  binding: CliSessionBinding,
  resumable: boolean | null,
): CliSessionBinding {
  if (binding.state !== 'unknown') return binding;
  if (resumable === true) return { state: 'established', sessionId: binding.sessionId };
  if (resumable === false) return { state: 'none' };
  return binding;
}
