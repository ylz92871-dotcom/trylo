// Trylo Desktop — the ONE CLI runtime extension point (P08 §WP7.1/§5.1/§5.2).
//
// Desktop must not know how many CLI runtimes exist. It depends on this
// contract; the legacy CLI and the new CLI each implement it behind a
// factory, and everything above the factory speaks only canonical
// `LoopEvent`s and canonical turn requests.
//
// Two things here are deliberate and load-bearing:
//
//   1. `ResolvedCliRuntime` is BRANDED. `kind`, `protocol`, `command` and
//      `argsPrefix` come out of ONE resolution, and the brand makes it
//      impossible to write an object literal that pairs a protocol with
//      an executable that cannot speak it. That pairing is audit P0 —
//      settings said `legacy-stream-json` while the path pointed at the
//      new CLI, so a default run was handed `-p --input-format …` and
//      died with `unknown command: -p`. A type that cannot express the
//      mistake beats a comment asking people not to make it.
//
//   2. Capabilities are a TABLE keyed by kind, not a method an adapter
//      may override. §5.2: "能力值必须来自 adapter 的静态合同与 probe
//      result，不能由 UI 猜测" — and an adapter that could answer
//      differently per instance would make that uncheckable.
//
// The protocol union itself is owned by `runtime/cli-runtime-protocol.ts`
// and imported here as a TYPE only, so this module adds no runtime
// dependency in that direction.
//
// SIZE NOTE (纪律见 docs/00-总领/代码可读性可维护性与审计纪律.md:82 —
// "单文件约 400 行…超限必须在 review 中解释为何拆分会更差"): this file sits
// just over that guideline and is deliberately not split. The brand symbol
// (`RESOLVED_CLI_RUNTIME`) must NOT be exported, and it is needed by exactly
// two things — the interface that names it and the one constructor that
// writes it. Moving either one to another module forces the symbol to be
// exported, and an exported symbol is a documented forge path (see
// `cli-runtime-brand.test.ts`). A 15-line overage is cheaper than giving up
// the property that makes mismatched runtimes unexpressible.

import type { CliRuntimeProtocol } from '../runtime/cli-runtime-protocol';
import type { LoopEvent } from './loop-events';
import type { PermissionLevel } from '../permission/permission-policy';

// ── Kinds and the one kind ↔ protocol mapping ───────────────────────────

export type CliRuntimeKind = 'legacy' | 'trylo-v1';

/** The protocol the legacy kind speaks. Named so the fallbacks are not stray literals. */
const LEGACY_PROTOCOL: CliRuntimeProtocol = 'legacy-stream-json';

/** Where the resolved entry came from, in the vocabulary of §5.1. */
export type CliRuntimeSource = 'user' | 'development' | 'bundled';

/**
 * The mapping is a FUNCTION, not a pair of parameters, so there is no
 * call site that can pass `kind` and `protocol` independently.
 *
 * Written out here rather than imported from
 * `runtime/cli-runtime-protocol.ts` on purpose: the only dependency
 * between the two folders that exists in this codebase runs
 * `runtime → host-adapter`, and importing a value from `runtime/` here
 * would make it bidirectional. The two facts are therefore pinned by a
 * consistency test instead — the legacy kind must map to
 * `DEFAULT_CLI_RUNTIME_PROTOCOL`, and every kind must land inside
 * `CLI_RUNTIME_PROTOCOLS`. If someone flips the shipping default, that
 * test goes red before the mapping can drift.
 */
/**
 * One row per kind, as a `Record` rather than a ternary.
 *
 * A ternary would silently treat a future `'trylo-v2'` as `legacy`; this
 * shape makes adding a kind a COMPILE error until the table has a row for
 * it. The `??` fallback below is NOT for declared kinds — it only covers a
 * value rebuilt by hand from IPC, which `describeRuntimeMismatch` refuses
 * before anything is spawned.
 */
const PROTOCOL_FOR: Record<CliRuntimeKind, CliRuntimeProtocol> = {
  legacy: LEGACY_PROTOCOL,
  'trylo-v1': 'trylo-v1',
};

export function protocolOfKind(kind: CliRuntimeKind): CliRuntimeProtocol {
  return PROTOCOL_FOR[kind] ?? LEGACY_PROTOCOL;
}

/** The argv prefix that is fixed for a kind, independent of the turn. */
const ARGS_PREFIX_FOR: Record<CliRuntimeKind, readonly string[]> = {
  // Legacy has no fixed prefix: its resident process receives per-run
  // frames, not a subcommand.
  legacy: [],
  // v1: every turn is `run --format stream-json …`; `--workspace`,
  // `--resume`, `--provider`, `--model` and the permission flags vary per
  // turn and are appended by the adapter.
  'trylo-v1': ['run', '--format', 'stream-json'],
};

export function argsPrefixOfKind(kind: CliRuntimeKind): readonly string[] {
  return ARGS_PREFIX_FOR[kind] ?? ARGS_PREFIX_FOR.legacy;
}

// ── Capability matrix (§5.2) ────────────────────────────────────────────

export interface CliRuntimeAbilities {
  /** A CLI process that outlives one turn. */
  readonly persistentProcess: boolean;
  /** Reuse a live idle process for the next turn. */
  readonly warmReuse: boolean;
  /** Injecting another user frame while a turn runs. */
  readonly steering: 'none' | 'queued' | 'live';
  /** How the host may answer a permission prompt. */
  readonly approvals: 'none' | 'host-transport' | 'native';
  /** A session the CLI itself owns and can resume after a restart. */
  readonly durableSessions: boolean;
  /** Tool input/summary/duration per §6.7. */
  readonly richToolEvents: boolean;
  /** The v1 stream carries no learning events yet. */
  readonly learningEvents: boolean;
  /** Structured child lifecycle events, independently of Team sessions. */
  readonly subagentEvents: boolean;
}

const LEGACY_ABILITIES: CliRuntimeAbilities = {
  persistentProcess: true,
  warmReuse: true,
  steering: 'live',
  approvals: 'native',
  durableSessions: false,
  richToolEvents: true,
  learningEvents: false,
  subagentEvents: false,
};

const V1_ABILITIES: CliRuntimeAbilities = {
  // §3.3: one process per turn. Nothing that assumes a resident stdin is
  // available on this path — not degraded, explicitly unsupported.
  persistentProcess: false,
  warmReuse: false,
  steering: 'queued',
  approvals: 'host-transport',
  durableSessions: true,
  richToolEvents: false,
  learningEvents: false,
  subagentEvents: true,
};

const ABILITIES_FOR: Record<CliRuntimeKind, CliRuntimeAbilities> = {
  legacy: LEGACY_ABILITIES,
  'trylo-v1': V1_ABILITIES,
};

/**
 * A new kind cannot inherit another kind's capabilities by accident: the
 * `Record` above fails to compile until it has a row, and §5.2 requires
 * these values to come from a static table rather than from a default.
 */
export function abilitiesOfKind(kind: CliRuntimeKind): CliRuntimeAbilities {
  return ABILITIES_FOR[kind] ?? LEGACY_ABILITIES;
}

/**
 * Which kinds MUST carry the interpreter they were resolved with.
 *
 * This is the audit P1 fix as a table. `trylo-v1` is shipped with a pinned
 * Node next to it, so a resolution that produced a script and then dropped
 * the interpreter is a defect — the packaged app would silently depend on
 * whatever `node` happens to be on PATH, which is the exact failure the
 * audit found. `legacy` is a user-supplied `cli.js` that has always been
 * run by bare `node`; demanding a pinned interpreter for it would be a
 * behaviour change disguised as a safety rule.
 */
const REQUIRES_PINNED_INTERPRETER: Record<CliRuntimeKind, boolean> = {
  'trylo-v1': true,
  legacy: false,
};

export function requiresPinnedInterpreter(kind: CliRuntimeKind): boolean {
  return REQUIRES_PINNED_INTERPRETER[kind];
}

/** The interpreter name used when a kind does not pin one (legacy). */
export const BARE_NODE = 'node';

// ── The resolved runtime (branded) ──────────────────────────────────────

/**
 * Not exported on purpose. A module that cannot name this symbol cannot
 * produce a `ResolvedCliRuntime`, which is what makes "no mismatched
 * runtime" a property of the type system rather than of review.
 */
const RESOLVED_CLI_RUNTIME = Symbol('trylo.desktop.ResolvedCliRuntime');

export interface ResolvedCliRuntime {
  readonly [RESOLVED_CLI_RUNTIME]: true;
  readonly kind: CliRuntimeKind;
  /** Derived from `kind`; never passed in alongside it. */
  readonly protocol: CliRuntimeProtocol;
  /** The executable to spawn: the interpreter for a Node entry. */
  readonly command: string;
  /** Fixed argv that precedes the per-turn argv. */
  readonly argsPrefix: readonly string[];
  /** The entry script/host, when the command is an interpreter. */
  readonly entryScript?: string;
  /**
   * The interpreter from the SAME resolution as `entryScript`. A pinned
   * Node that never reaches the spawn is the same as no pinned Node
   * (audit P1), so a Node entry without one cannot be built at all.
   */
  readonly nodeProgram?: string;
  readonly source: CliRuntimeSource;
  readonly version?: string;
}

export interface DefineResolvedRuntimeInput {
  readonly kind: CliRuntimeKind;
  readonly entryScript: string;
  readonly nodeProgram?: string;
  readonly source: CliRuntimeSource;
  readonly version?: string;
}

export type CliRuntimeResolutionFailureCode =
  | 'entry_missing'
  | 'missing_node_program';

export interface CliRuntimeResolutionFailure {
  readonly ok: false;
  readonly code: CliRuntimeResolutionFailureCode;
  readonly detail: string;
}

export type CliRuntimeBuild =
  | { readonly ok: true; readonly runtime: ResolvedCliRuntime }
  | CliRuntimeResolutionFailure;

/** Fold a resolution failure into the failure shape callers already know. */
export function asResolutionFailure(
  code: CliRuntimeResolutionFailureCode,
  detail: string,
): CliRuntimeResolutionFailure {
  return { ok: false, code, detail };
}

function isNodeEntry(entry: string): boolean {
  return /\.(m?js|cjs)$/i.test(entry);
}

/**
 * The ONLY constructor. Validates, derives the pair, and freezes.
 *
 * It is stricter than `cliSpawnCommand` on exactly one point: a kind that
 * pins its interpreter (`trylo-v1`) cannot be built from a Node entry
 * without one, because a pinned Node that never reaches the spawn is the
 * same as no pinned Node (audit P1). The lax path stays for `legacy`,
 * whose bare-`node` spawn is long-standing correct behaviour.
 * `cli-runtime-path.ts` keeps the old helper for the modules that have not
 * moved to the adapter yet (WP7.3).
 */
export function defineResolvedRuntime(input: DefineResolvedRuntimeInput): CliRuntimeBuild {
  const entry = input.entryScript.trim();
  const kind = input.kind;
  if (entry === '') {
    return asResolutionFailure('entry_missing', `${kind}: no CLI entry was resolved`);
  }
  const nodeProgram = (input.nodeProgram ?? '').trim();
  const nodeEntry = isNodeEntry(entry);
  if (nodeEntry && nodeProgram === '' && requiresPinnedInterpreter(kind)) {
    return asResolutionFailure(
      'missing_node_program',
      `${kind}: ${entry} is a Node entry but the resolution carried no interpreter`,
    );
  }
  const pinned = nodeEntry ? nodeProgram : '';
  return {
    ok: true,
    runtime: Object.freeze({
      [RESOLVED_CLI_RUNTIME]: true as const,
      kind,
      protocol: protocolOfKind(kind),
      command: nodeEntry ? (pinned !== '' ? pinned : BARE_NODE) : entry,
      argsPrefix: argsPrefixOfKind(kind),
      entryScript: entry,
      ...(nodeEntry && pinned !== '' ? { nodeProgram: pinned } : {}),
      source: input.source,
      ...(input.version === undefined ? {} : { version: input.version }),
    }),
  };
}

/**
 * Provenance check: did this value come out of `defineResolvedRuntime`?
 *
 * Exported as a PREDICATE rather than as the symbol, so consumers can
 * verify provenance without gaining the ability to forge it. This is what
 * makes the brand do runtime work instead of being type-level decoration:
 * a hand-built object with a self-consistent `kind`/`protocol` pair would
 * otherwise sail past a consistency check alone.
 *
 * The type layer stops `{ kind, protocol, command, … }` literals, classes
 * and name-guessed symbols from being written at all; this catches the
 * remaining paths (`as unknown as`, and any value rebuilt after crossing
 * an IPC boundary).
 */
export function isResolvedCliRuntime(value: unknown): value is ResolvedCliRuntime {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<symbol, unknown>)[RESOLVED_CLI_RUNTIME] === true
  );
}

// ── Probe ───────────────────────────────────────────────────────────────

export type CliProbeFailureCode = 'not_found' | 'timeout' | 'spawn_failed' | 'unrecognized';

export type CliRuntimeProbeResult =
  | {
      readonly ok: true;
      readonly kind: CliRuntimeKind;
      readonly version: string;
      /** What the probe actually saw — kept so a diagnosis is not a guess. */
      readonly evidence: string;
        /** Advertised run flags, when the runtime supplied a help banner. */
        readonly supportedFlags?: readonly string[];
    }
  | { readonly ok: false; readonly code: CliProbeFailureCode; readonly detail: string };

// ── Turn contract (§5.2) ────────────────────────────────────────────────

export type CliCancelReason =
  | 'user'
  | 'superseded'
  | 'timeout'
  | 'shutdown'
  | 'adapter_replaced';

/**
 * Why a turn did not complete. Canonical, so the UI never has to read a
 * CLI-specific string to decide what to show.
 */
export type CliTurnFailureCode =
  | 'runtime_unavailable'
  | 'provider_unmapped'
  | 'provider_unreadable'
  | 'auth_missing'
  | 'approval_unavailable'
  | 'session_needs_probe'
  | 'spawn_failed'
  | 'prompt_write_failed'
  | 'input_close_failed'
  | 'protocol_rejected';

export interface CliTurnUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

/**
 * §5.2: "completion 区分 completed、failed、cancelled、timed_out 与
 * unknown_outcome". `unknown_outcome` is not a rounding error — it is the
 * honest state after a write whose effect we cannot observe, and it must
 * never be folded into `failed` (nor, worse, into `completed`).
 */
export type CliTurnCompletion =
  | { readonly state: 'completed'; readonly usage?: CliTurnUsage }
  | {
      readonly state: 'failed';
      readonly code: CliTurnFailureCode;
      readonly detail: string;
    }
  | { readonly state: 'cancelled'; readonly reason: CliCancelReason }
  | { readonly state: 'timed_out'; readonly detail: string }
  | { readonly state: 'unknown_outcome'; readonly detail: string };

/**
 * The canonical request. It deliberately has no `argv`, no `stdin` and no
 * `env`: those are the adapter's business (§5.2 "startTurn 只接收
 * canonical request，不接收某 CLI 的 argv").
 */
export interface CliTurnRequest {
  readonly prompt: string;
  readonly cwd: string;
  /** Snapshotted at start; a mid-turn settings change must not re-route it. */
  readonly protocol: CliRuntimeProtocol;
  readonly permissionLevel: PermissionLevel;
  readonly providerId?: string;
  readonly endpoint?: string;
  readonly model?: string;
  readonly projectKey?: string;
  readonly conversationId?: string;
  readonly runId?: string;
  /** Prior turns, replayed only when the runtime owns no session yet. */
  readonly priorMessages?: readonly {
    readonly role: string;
    readonly kind: string;
    readonly text?: string;
  }[];
  readonly onEvents: (events: readonly LoopEvent[]) => void;
  /** Superseded runs go silent but keep running (M4-A). */
  readonly guard?: { readonly isSuperseded: () => boolean };
}

export interface CliTurnHandle {
  readonly events: AsyncIterable<LoopEvent>;
  /** §5.2: an explicit lifecycle action, NOT the same thing as a kill. */
  cancel(reason: CliCancelReason): Promise<void>;
  readonly completion: Promise<CliTurnCompletion>;
}

export interface CliRuntimeAdapter {
  readonly id: CliRuntimeKind;
  /** The exact immutable resolution this adapter was built from. */
  readonly runtime: ResolvedCliRuntime;
  readonly abilities: CliRuntimeAbilities;
  probe(signal: AbortSignal): Promise<CliRuntimeProbeResult>;
  startTurn(request: CliTurnRequest): Promise<CliTurnHandle>;
  dispose(): Promise<void>;
}

/** Thrown when a turn is attempted on a disposed adapter. */
export class CliRuntimeDisposedError extends Error {
  constructor(kind: CliRuntimeKind) {
    super(`The ${kind} CLI runtime adapter has been disposed`);
    this.name = 'CliRuntimeDisposedError';
  }
}
