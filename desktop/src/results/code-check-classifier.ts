// Trylo Desktop — Code check classifier (P2-1, spec §7.6).
//
// Purely classifies PAIRED structured tool events into typed checklist items
// using an explicit allowlist. It never searches stdout for `PASS`, never
// reads assistant text, and never persists the raw command/output — only a
// short, sanitised label. Unrecognised commands are simply not classified.

import type { LoopEvent } from '../host-adapter/loop-events';
import type { StoredCodeCheck, CodeCheckKind } from '../results/conversation-result-types';

/** Shell / Bash-family tool names (case-insensitive) that *may* carry a
 *  classified check. Non-shell tools are never classified. */
const SHELL_TOOLS = new Set(['bash', 'shell', 'terminal', 'sh', 'zsh', 'pwsh', 'powershell']);

function matches(cmd: string, pattern: RegExp): boolean {
  return pattern.test(cmd);
}

/** The "check" half of a command: drop any leading `cd <x> && …` chain and
 *  keep the LAST `&&` segment. `;` is deliberately NOT treated as a check
 *  separator (spec §7.6 only promises a single command or an explicit
 *  `cd <x> && <check>`), so a `a ; b && check` chain never mis-parses as one
 *  check and label + classification agree on the same segment. */
function checkSegment(command: string): string {
  const segs = command.split(/\s*&&\s*/).filter((s) => s.trim().length > 0);
  return (segs[segs.length - 1] ?? command).trim();
}

/** Classify a single command string. Returns null when the tool is not a
 *  safe, allowlisted check. Only the "check" half of `cd <x> && <check>`
 *  is inspected (spec §7.6). */
export function classifyCheckCommand(command: string): { kind: CodeCheckKind } | null {
  const cmd = checkSegment(command);
  // Spec §7.6 (M2): only a single command or an explicit `cd <x> && <check>`
  // is a check. A `;`-joined chain is NOT one check — refusing it here stops
  // `git add .; pnpm test` (or any `a; b && check`) being mislabeled.
  if (cmd.includes(';')) {
    return null;
  }

  // Explicit allowlist (spec §7.6). Order matters: format/branching first
  // so e.g. `cargo fmt --check` is not swallowed by a broad `build`.
  if (matches(cmd, /(?:^|\s)prettier\s+--check\b/) || matches(cmd, /cargo\s+fmt\s+--check\b/)) {
    return { kind: 'format' };
  }
  if (matches(cmd, /(?:^|\s)eslint\b/) || matches(cmd, /(?:^|\s)lint\b/) || matches(cmd, /cargo\s+clippy\b/)) {
    return { kind: 'lint' };
  }
  if (matches(cmd, /(?:^|\s)tsc\b/) || matches(cmd, /(?:^|\s)typecheck\b/)) {
    return { kind: 'typecheck' };
  }
  if (
    matches(cmd, /\b(pytest|jest|vitest|go\s+test|dotnet\s+test|cargo\s+test)\b/) ||
    matches(cmd, /(?:^|\s)(pnpm|npm|yarn|bun)\s+test\b/) ||
    // Tightened `test` (spec §7.6): only a `test` COMMAND with an argument
    // following it qualifies, so `echo test` or reading `test-utils.js` can
    // never be classified as a test run.
    matches(cmd, /\btest\s+\S+/)
  ) {
    return { kind: 'test' };
  }
  if (matches(cmd, /(?:^|\s)(pnpm|npm|yarn|bun)\s+.*\bbuild\b/) || matches(cmd, /cargo\s+build\b/)) {
    return { kind: 'build' };
  }
  return null;
}

/** Derive a short, human label from the command — from the SAME `&&`-split
 *  check segment used for classification (spec §7.6, M2), so `cd desktop &&
 *  pnpm test` labels as `pnpm test`, not `cd desktop`. Handles the
 *  `pnpm run typecheck` -> `pnpm typecheck` elision so labels stay minimal. */
export function checkLabel(command: string): string {
  const tokens = checkSegment(command).split(/\s+/);
  if (tokens.length === 0) return 'command';
  const [head, second, third] = tokens;
  if (second === 'run' && third) return `${head} ${third}`;
  if (second) return `${head} ${second}`;
  return head ?? 'command';
}

function isShellTool(tool: string): boolean {
  return SHELL_TOOLS.has(tool.toLowerCase());
}

/** Extract the shell command from a tool_use input record. */
function inputCommand(input: Record<string, unknown>): string | null {
  const value = input.command ?? input.cmd;
  return typeof value === 'string' && value.trim() ? value : null;
}

export interface ClassifyChecksOptions {
  readonly runId: string;
}

/**
 * Pair tool_use + tool_result events into StoredCodeCheck records.
 * - only shell tools pass the gate;
 * - an unrecognised command is never shown as a check;
 * - status comes ONLY from the paired tool_result `ok` flag;
 * - a classified tool_use with no matching result is dropped (no terminal
 *   status without a result — spec §7.6);
 * - a duplicate toolCallId upserts, never appends twice.
 */
export function classifyCodeChecks(
  events: readonly LoopEvent[],
  options: ClassifyChecksOptions,
): StoredCodeCheck[] {
  const pending = new Map<string, { label: string; kind: CodeCheckKind }>();
  const resolved = new Map<string, StoredCodeCheck>();

  for (const e of events) {
    if (e.type === 'tool_use') {
      const command = inputCommand(e.input);
      if (!command || !isShellTool(e.tool)) continue;
      const category = classifyCheckCommand(command);
      if (!category) continue;
      pending.set(e.id, {
        label: checkLabel(command),
        kind: category.kind,
      });
    } else if (e.type === 'tool_result') {
      const meta = pending.get(e.id);
      if (!meta) continue;
      const existing = resolved.get(e.id);
      if (existing?.status === 'cancelled') continue; // frozen by an abort
      resolved.set(e.id, {
        id: `${options.runId}:${e.id}`,
        label: meta.label,
        kind: meta.kind,
        status: e.ok ? 'passed' : 'failed',
        ...(e.durationMs > 0 ? { durationMs: e.durationMs } : {}),
      });
    } else if (e.type === 'aborted' && (e.reason === 'user' || e.reason === 'timeout')) {
      // M2 (spec §7.6): a run-level abort/cancel interrupts any still-running
      // classified check — map it to `cancelled` instead of silently dropping
      // the pending entry (or staling it).
      for (const [id, meta] of pending) {
        resolved.set(id, {
          id: `${options.runId}:${id}`,
          label: meta.label,
          kind: meta.kind,
          status: 'cancelled',
        });
      }
      pending.clear();
    }
  }

  // Insertion order: keep pending insertion order by scanning `resolved` in
  // the order ids were first seen in `events`.
  const order: string[] = [];
  for (const e of events) {
    if (e.type === 'tool_use' && resolved.has(e.id) && !order.includes(e.id)) {
      order.push(e.id);
    }
  }
  return order.map((id) => resolved.get(id)!).sort((a, b) => {
    if (a.kind !== b.kind) return a.kind.localeCompare(b.kind);
    return a.id.localeCompare(b.id);
  });
}