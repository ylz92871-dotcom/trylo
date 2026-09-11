// Trylo Desktop — RunTelemetry.
//
// M4-C5 (architecture spec §7.2): one telemetry schema for every
// Code / Work run so cold vs warm latency can be split into the
// segments the audit couldn't measure (prewarm infra guarantees
// CLI cold-start and provider TTFT get separated, not merged).
//
// This module is PURE: no Tauri, no React, no clock. The controller
// feeds it a sequence of `mark()` timestamps (in SubmitOrder); it
// produces a `RunTelemetryRecord` plus derived latencies grouped by
// `mode + model + provider + coldOrWarm + historyBucket`.
//
// Design rules from the architecture doc:
//   - every timestamp is OPTIONAL — a warm run may never reach
//     spawn, a busy run may fill no latency slice;
//   - `childCreatedAt` proves only the OS child was created; the
//     ready gate is `cliSessionReadyAt` (spec §7.1: process_spawn
//     return ≠ runtime ready);
//   - derived latencies only materialise when BOTH endpoints exist;
//   - totals never appear as a context "used" figure (that is the
//     WorkContextAdapter's concern, not telemetry's).
//
// The record is a plain object so it can be serialised to the
// telemetry log file; it intentionally carries no credentials or
// message text.

export type RunMode = "code" | "work";

export type ColdOrWarm = "cold" | "warm";

export type TelemetryMark =
  | "sendClickAt" // user submitted
  | "userMessageCommittedAt" // user bubble in state
  | "reuseAttemptAt" // warm-process reuse attempt started
  | "reuseOkAt" // reuse accepted (stdin write ok)
  | "spawnRequestedAt" // cold spawn requested
  | "childCreatedAt" // OS child created
  | "cliSessionReadyAt" // CLI init done (session_start) — NOT child created
  | "promptWrittenAt" // user prompt written to stdin
  | "providerRequestStartedAt" // first model request
  | "firstRawFrameAt" // first raw stdout frame
  | "firstSemanticEventAt" // first text/thinking/tool
  | "firstPaintAt" // first UI paint
  | "terminalAt"; // run ended

export interface RunTelemetrySnapshot {
  readonly runId: string;
  readonly mode: RunMode;
  readonly projectKey: string | undefined;
  readonly conversationId: string | undefined;
  readonly model: string | undefined;
  readonly provider: string | undefined;
  readonly coldOrWarm: ColdOrWarm | undefined;
  readonly historyMessageCount: number;
  readonly historyApproxBytes: number;
  readonly marks: Readonly<Partial<Record<TelemetryMark, number>>>;
}

/**
 * Min/max allowed for a latency slice, in ms. `NaN` / negative
 * slices are dropped by the derived-latency step.
 */
export interface TelemetryOptions {
  readonly mode: RunMode;
  readonly projectKey?: string;
  readonly conversationId?: string;
  readonly model?: string;
  readonly provider?: string;
  readonly historyMessageCount?: number;
  readonly historyApproxBytes?: number;
}

/** Order in which marks advance. Used only to sanity-filter
 *  physically-impossible slices. */
const MARK_ORDER: readonly TelemetryMark[] = [
  "sendClickAt",
  "userMessageCommittedAt",
  "reuseAttemptAt",
  "reuseOkAt",
  "spawnRequestedAt",
  "childCreatedAt",
  "cliSessionReadyAt",
  "promptWrittenAt",
  "providerRequestStartedAt",
  "firstRawFrameAt",
  "firstSemanticEventAt",
  "firstPaintAt",
  "terminalAt",
];

/** Mutable working copy — satisfies the read-only `RunTelemetrySnapshot`
 *  view on `finish()`. Kept internal so the snapshot can be built up
 *  incrementally (marks are set one at a time). */
interface MutableSnapshot {
  readonly runId: string;
  readonly mode: RunMode;
  readonly projectKey: string | undefined;
  readonly conversationId: string | undefined;
  readonly model: string | undefined;
  readonly provider: string | undefined;
  coldOrWarm: ColdOrWarm | undefined;
  readonly historyMessageCount: number;
  readonly historyApproxBytes: number;
  marks: Partial<Record<TelemetryMark, number>>;
}

export class RunTelemetry {
  private readonly snapshot: MutableSnapshot;

  constructor(readonly opts: TelemetryOptions) {
    this.snapshot = {
      runId: newRunId(),
      mode: opts.mode,
      projectKey: opts.projectKey,
      conversationId: opts.conversationId,
      model: opts.model,
      provider: opts.provider,
      coldOrWarm: undefined,
      historyMessageCount: opts.historyMessageCount ?? 0,
      historyApproxBytes: opts.historyApproxBytes ?? 0,
      marks: {},
    };
  }

  /** Record the first observed timestamp for a mark. Later calls
   *  for the same mark are ignored (a run has one start time per
   *  segment). Marks must advance monotonically in `MARK_ORDER`:
   *  adding a timestamp that already-set marks contradict (an
   *  earlier slot after a later slot) is refused. */
  mark(name: TelemetryMark, at = Date.now()): void {
    if (this.snapshot.marks[name] !== undefined) return;
    const idx = MARK_ORDER.indexOf(name);
    for (const set of Object.keys(this.snapshot.marks) as TelemetryMark[]) {
      const other = this.snapshot.marks[set];
      if (other === undefined) continue;
      const otherIdx = MARK_ORDER.indexOf(set);
      if (otherIdx < idx && other > at) return; // earlier slot is later in time
      if (otherIdx > idx && other < at) return; // later slot is earlier in time
    }
    this.snapshot.marks = { ...this.snapshot.marks, [name]: at };
  }

  /** Declare the run was cold (a spawn happened) or warm.
   *  Only the first declaration sticks. */
  setColdOrWarm(v: ColdOrWarm): void {
    if (this.snapshot.coldOrWarm === undefined) this.snapshot.coldOrWarm = v;
  }

  /** Final record. `coldOrWarm` defaults to `warm` when it was
   *  never declared but a listen/run clearly reused something
   *  (callers set it explicitly); otherwise it stays undefined. */
  finish(): RunTelemetrySnapshot {
    return this.snapshot;
  }

  /** Derived latencies. Each is present only when both endpoints
   *  exist and form a non-negative span. All in ms. */
  derived(): DerivedLatencies {
    return deriveLatencies(this.snapshot.marks);
  }
}

/** Latencies a caller can publish to the telemetry sink. */
export interface DerivedLatencies {
  /** sendClickAt → firstPaintAt. */
  readonly uiSubmitToPaint?: number;
  /** sendClickAt → terminalAt. */
  readonly totalDuration?: number;
  /** reuseAttemptAt → reuseOkAt (warm) OR spawnRequestedAt →
   *  childCreatedAt (cold). Fall through to nothing if neither. */
  readonly spawnLatency?: number;
  /** childCreatedAt → cliSessionReadyAt (OS child → CLI init). */
  readonly runtimeReadyLatency?: number;
  /** cliSessionReadyAt → providerRequestStartedAt (time to build
   *  the first request after init). */
  readonly runtimeQueueLatency?: number;
  /** providerRequestStartedAt → firstSemanticEventAt (provider
   *  time to first model token). */
  readonly providerTTFT?: number;
  /** firstSemanticEventAt → firstPaintAt (adapter → paint). */
  readonly adapterLatency?: number;
  /** firstRawFrameAt → firstSemanticEventAt (raw frame parsing).
   *  Usually the stream-translator's accumulation window. */
  readonly eventToSemantic?: number;
}

function deriveLatencies(
  marks: Readonly<Partial<Record<TelemetryMark, number>>>,
): DerivedLatencies {
  const t = (a: TelemetryMark, b: TelemetryMark): number | undefined => {
    const x = marks[a];
    const y = marks[b];
    if (x === undefined || y === undefined) return undefined;
    return y - x;
  };
  const span = (v: number | undefined, min = 0): number | undefined =>
    v !== undefined && Number.isFinite(v) && v >= min ? v : undefined;

  const uiSubmitToPaint = span(t("sendClickAt", "firstPaintAt"));
  const totalDuration = span(t("sendClickAt", "terminalAt"));
  const spawnLatency = span(
    t("reuseAttemptAt", "reuseOkAt") ?? t("spawnRequestedAt", "childCreatedAt"),
  );
  const runtimeReadyLatency = span(t("childCreatedAt", "cliSessionReadyAt"));
  const runtimeQueueLatency = span(t("cliSessionReadyAt", "providerRequestStartedAt"));
  const providerTTFT = span(t("providerRequestStartedAt", "firstSemanticEventAt"));
  const adapterLatency = span(t("firstSemanticEventAt", "firstPaintAt"));
  const eventToSemantic = span(t("firstRawFrameAt", "firstSemanticEventAt"), 0);

  return {
    uiSubmitToPaint,
    totalDuration,
    spawnLatency,
    runtimeReadyLatency,
    runtimeQueueLatency,
    providerTTFT,
    adapterLatency,
    eventToSemantic,
  };
}

function newRunId(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof (crypto as { randomUUID?: () => string }).randomUUID === "function"
  ) {
    return `tl:${crypto.randomUUID()}`;
  }
  return `tl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}