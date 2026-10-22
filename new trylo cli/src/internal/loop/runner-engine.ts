import { contextFromProfile } from "../contract/context.js";
import type { AddressedUserInput } from "../domain/input-queue.js";
import type { IterationBudget, UsagePricing } from "../domain/iteration.js";
import { initialState, type ExecutionState } from "../domain/state.js";
import { emptyUsage, type ProviderMessage, type ProviderUsage, type SystemPromptDirective } from "../ports/provider.js";
import type { JsonObject } from "../protocol/envelope.js";
import type { Transcript } from "../protocol/transcript.js";
import {
  adoptResumedWindow,
  createCompactionLedger,
  type CompactionLedger,
  type ReportedRequestBasis,
} from "./compact-boundary.js";
import { checkpointState, type CheckpointGateState } from "./checkpoint-gate.js";
import { createTurnDiffTracker, type TurnDiffSummary, type TurnDiffTracker } from "./turn-diff.js";
import { createDoomLoopTracker, type DoomLoopTracker } from "./doom-loop.js";
import { createExecutionJournal } from "./journal.js";
import type { EnvelopeSink } from "./journal-emit.js";
import { createPermissionGrantCache, type PermissionGrantCache } from "./permission-grants.js";
import { resumedTranscriptFor, seedMessagesOf } from "./request.js";
import type { LoopPorts, RunTurnRequest, RunTurnResult } from "./runner.js";
import { journalView } from "./compact-ledger.js";
import { pairCancelledToolCalls } from "./transcript-append.js";

/**
 * Where a turn's runtime host is built, and where it is read back.
 *
 * `Engine` is mutable on purpose and local on purpose: `runner.ts` mutates one
 * instance across a whole turn, and the views it hands out (`toolHost`,
 * `gapHost`) expose one capability each so nothing else can reach the rest.
 * The assembly lives here rather than in the turn itself for the same reason —
 * `runTurn` then reads as the sequence of phases it is, instead of carrying a
 * thirty-line object literal in its middle.
 */

export type Engine = {
  state: ExecutionState;
  seq: number;
  issued: Set<string>;
  committed: Set<string>;
  checksums: string[];
  journal: ReturnType<typeof createExecutionJournal>;
  abort: AbortController;
  /** Inert summary calls may stop immediately without interrupting tool writes. */
  readonly compactionSignal: AbortSignal;
  boundAttempt?: string;
  cancelAfter?: "streaming";
  sawText: boolean;
  model: string;
  budget: IterationBudget;
  iterations: number;
  /**
   * Steps this turn has already been forgiven (WP08.2).
   *
   * A steer refunds the steps the run spent going the wrong way, and it does
   * that out of an allowance no larger than one turn's budget — so redirecting
   * a run can at most double the steps it takes, never unbind them. Without the
   * allowance, a steer at every gap reset the counter every time and a turn
   * whose budget was 3 ran 41 provider requests for 40 messages; the ceiling
   * existed on paper and nowhere else.
   */
  refunded: number;
  usage: ProviderUsage;
  /** Next-view basis after a gap, otherwise last reported input; never billed usage. */
  promptTokens: number;
  /**
   * The run's accumulated priced cost in USD (WP09.3/L07). Priced per stream
   * when the caller stated a pricing pair; stays 0 when it did not, which is
   * every caller that predates the dollar budget.
   */
  costUsd: number;
  /** The pricing pair the caller resolved; absent means usage is not priced. */
  pricing?: UsagePricing;
  /**
   * The server-reported size of the last request and how much transcript it
   * covered (WP09.1/C35). The gap's compaction basis is this report plus the
   * items appended since; undefined until the first stream reports.
   */
  promptReport?: ReportedRequestBasis;
  transcript: Transcript;
  /** Only acknowledged immutable envelopes can be omitted from later flushes. */
  progressEnvelopeCount: number;
  /** An immutable transcript view is reusable only after its write was acknowledged. */
  progressTranscript?: Transcript;
  compaction: CompactionLedger;
  seedMessages: ReadonlyArray<ProviderMessage>;
  grants: PermissionGrantCache;
  doom: DoomLoopTracker;
  contextDegradedReason?: string;
  contextDegradationReported: boolean;
  queue: ReadonlyArray<AddressedUserInput>;
  /**
   * Input the turn was handed and refused at the ceiling (WP08.1). Kept apart
   * from `queue` because these were never admitted: they cannot be promoted,
   * and mixing them in would let a refusal be delivered by the back door.
   */
  setAsideInput: ReadonlyArray<AddressedUserInput>;
  /** Gap compactions this turn; a second one would spin on a full context. */
  gapCompactions: number;
  /**
   * Reactive recoveries this turn (WP09.3/L06): a provider rejection that a
   * compaction can answer is retried at most once, so a provider that keeps
   * rejecting meets the turn's own failure instead of an internal retry loop.
   */
  reactiveCompactions: number;
  checkpoint: CheckpointGateState;
  /**
   * The turn's net file diff (WP11/C20), fed by every successful mutating
   * tool outcome through the runner host. Live-turn only, like Codex: a
   * restarted turn rebuilds from the durable `file_write` facts, not from
   * previews, which do not survive the journal.
   */
  turnDiff: TurnDiffTracker;
  /**
   * Caller system prompt and response schema for every request this turn
   * builds (WP18.3). Absent — every caller that predates these fields — means
   * the requests are exactly the ones the un-wired path builds.
   */
  systemPrompt?: SystemPromptDirective;
  systemPromptAppend?: string;
  responseSchema?: JsonObject;
  /**
   * The turn's envelope observer, copied from the request (WP D1). Absent on
   * every path that does not watch the turn, which is every path but `host.ts`.
   */
  onEnvelope?: EnvelopeSink;
  /** Lent by the host (`RunTurnRequest.now`); the loop never reads a clock itself. */
  now: () => number;
};

/**
 * Assemble the host for one turn: the profile-derived seed messages, the
 * transcript the turn starts from, and every injected port defaulted.
 *
 * Profile-derived (system) messages are assembled once here; the user turn is
 * recorded as a transcript item by the caller, so the transcript alone can
 * rebuild a provider request after a restart.
 */
export async function assembleEngine(
  ports: LoopPorts,
  request: RunTurnRequest,
  abort: AbortController,
): Promise<Engine> {
  const assembled = await contextFromProfile(ports.profile).assemble({
    taskId: request.turnId,
    // The caller's own messages, or none. This is the seam the CLI host sends
    // project instructions and platform facts through; the loop passes them on
    // without knowing what they are, which is why a caller that passes nothing
    // gets byte-identical requests to the ones it got before this field existed.
    messages: request.callerMessages ?? [],
    signal: abort.signal,
  });
  const transcript: Transcript = resumedTranscriptFor(request.resumedTranscript, request.text, request.resumedRecords);
  const engine: Engine = {
    state: initialState(),
    seq: 0,
    issued: new Set<string>(),
    committed: new Set<string>(),
    checksums: [],
    journal: createExecutionJournal(),
    abort,
    compactionSignal: request.cancelSignal === undefined ? abort.signal
      : AbortSignal.any([abort.signal, request.cancelSignal]),
    sawText: false,
    model: request.model ?? "default",
    budget: request.budget ?? {},
    iterations: 0,
    refunded: 0,
    usage: emptyUsage("snapshot"),
    promptTokens: 0,
    costUsd: 0,
    ...(request.pricing === undefined ? {} : { pricing: request.pricing }),
    transcript: [...transcript],
    progressEnvelopeCount: 0,
    compaction: createCompactionLedger(),
    seedMessages: seedMessagesOf(assembled.messages),
    grants: ports.grants ?? createPermissionGrantCache(),
    doom: ports.doom ?? createDoomLoopTracker(),
    contextDegradationReported: false,
    queue: [],
    setAsideInput: [],
    gapCompactions: 0,
    reactiveCompactions: 0,
    checkpoint: checkpointState(),
    turnDiff: createTurnDiffTracker(),
    now: request.now ?? (() => 0),
    ...(assembled.degradedReason !== undefined
      ? { contextDegradedReason: assembled.degradedReason }
      : {}),
    ...(request.cancelAfter !== undefined ? { cancelAfter: request.cancelAfter } : {}),
    ...(request.onEnvelope !== undefined ? { onEnvelope: request.onEnvelope } : {}),
    ...(request.systemPrompt === undefined ? {} : { systemPrompt: request.systemPrompt }),
    ...(request.systemPromptAppend === undefined ? {} : { systemPromptAppend: request.systemPromptAppend }),
    ...(request.responseSchema === undefined ? {} : { responseSchema: request.responseSchema }),
  };
  adoptResumedWindow(engine.compaction, request.resumedWindow, request.resumedRecords, transcript);
  return engine;
}

/**
 * Pair a cancelled turn's open `tool_use` blocks, on the engine's own state.
 *
 * # Why this cannot live only in `buildTurnResult`
 *
 * The recorder is handed `engine.transcript` by `flushProgress`, so a pairing
 * performed solely on the value `buildTurnResult` returns leaves the durable
 * journal holding `tool_use` blocks that nothing answers — and a resumed turn
 * then rebuilds a conversation missing the calls the user watched the model make.
 * The live transcript and the persisted one must be the same conversation, so the
 * pairing is applied to the engine *before* the flush, and the result reads it
 * back rather than producing its own copy.
 *
 * A cancel can land while a stream is open, and a stream that has already emitted
 * `tool_call` blocks will have put them in the transcript with no `tool_result`
 * to answer them — measured in
 * `evidence/2026-10-05-WP07/probe-l04-orphan-tool-use.mjs`, where two calls were
 * left dangling. A dangling `tool_use` makes the next request invalid, which is
 * why the legacy runtime closed the gap on its abort path
 * (`yieldMissingToolResultBlocks`, `trylo cli/src/query.ts:124`).
 *
 * # Why only for `cancelled`
 *
 * A *completed* turn with orphans is a different defect and must not be papered
 * over: labelling it "cancelled" would attribute a pairing bug to a user's
 * Ctrl-C. Those are left visible for `decideIterationEnd` and the next turn to
 * deal with, rather than being dressed up here.
 *
 * Idempotent — a transcript with nothing open is returned unchanged — so running
 * it both before the flush and again while building the result is harmless.
 */
export function settleTranscript(engine: Engine): void {
  if (engine.state.terminalReason !== "cancelled") return;
  engine.transcript = pairCancelledToolCalls(engine.transcript);
}

/** The turn's public result, read off the engine it just ran. */
export function buildTurnResult(engine: Engine): RunTurnResult {
  settleTranscript(engine);
  const transcript = engine.transcript;
  const netDiff = engine.turnDiff.unifiedDiff();
  return {
    state: engine.state,
    envelopes: engine.journal.events(),
    checksums: [...engine.checksums],
    issuedKeys: [...engine.issued],
    committedKeys: [...engine.committed],
    inputs: engine.journal.inputs(),
    transcript,
    usage: engine.usage,
    iterations: engine.iterations,
    compactions: engine.compaction.entries.map((entry) => entry.draft),
    ...(engine.compaction.entries.length === 0 ? {} : { compactionSourceRecords: journalView(
      engine.state.sessionId ?? "", transcript, engine.compaction.entries, engine.compaction.resumed,
    ) }),
    promptView: engine.compaction.window,
    // What the turn took from its inbox and never delivered, followed by what
    // it was handed and refused at the ceiling. Empty on every turn that
    // consumed what it took; non-empty is a fact for the surface to act on,
    // never something the engine may quietly forget (WP08.3).
    unconsumedInput: [...engine.queue, ...engine.setAsideInput],
    turnDiff: {
      diff: netDiff,
      summary: engine.turnDiff.summary(),
      valid: engine.turnDiff.valid,
      ...(engine.turnDiff.invalidReason === undefined ? {} : { invalidReason: engine.turnDiff.invalidReason }),
    },
  };
}

export type TurnDiffSnapshot = {
  readonly diff: string | undefined;
  readonly summary: TurnDiffSummary;
  readonly valid: boolean;
  readonly invalidReason?: string;
};
