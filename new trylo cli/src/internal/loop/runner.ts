import type { ProfilePort } from "../contract/profile.js";
import type { Message } from "../contract/execution.js";
import type { VerificationStatus } from "../contract/execution.js";
import type { ReduceInput } from "../domain/input.js";
import { decideIterationEnd, streamCostUsd, type IterationBudget, type UsagePricing } from "../domain/iteration.js";
import { budgetCeiling, outputBudgetSpent, fitRequestToContext } from "./budget-gate.js";
import type { ExecutionState } from "../domain/state.js";
import type { CompactRecordDraft, CompactWindow } from "../ports/compaction.js";
import type { PermissionPort } from "../ports/permission.js";
import { accumulateUsage, providerContinuationScope, type ProviderPort, type ProviderUsage, type SystemPromptDirective } from "../ports/provider.js";
import type { SessionRecord } from "../ports/session.js";
import type { ToolPort, ToolSandbox } from "../ports/tools.js";
import type { Envelope, JsonObject } from "../protocol/envelope.js";
import type { Transcript } from "../protocol/transcript.js";
import { promptContextFor, type CompactionWiring } from "./compact-boundary.js";
import type { DoomLoopTracker } from "./doom-loop.js";
import type { MethodChannelTake } from "./method-channel.js";
import type { MethodLearningPort } from "./method-port.js";
import { recordFielding, recordFeedback } from "./method-attribution.js";
import type { ToolGapTake } from "./tool-gap-channel.js";
import type { ToolGapPort } from "./tool-gap-port.js";
import { reportBeat, reportToolGapBeat, reportTurnEnd, teachingFor } from "./method-signal.js";
import { emitRaw, nextId, type EnvelopeSink } from "./journal-emit.js";
import type { PermissionGrantCache } from "./permission-grants.js";
import { buildRequest } from "./request.js";
import { consumeProviderStream } from "./stream.js";
import { isSuccessfulStreamFinish } from "./stream-verdict.js";
import { nextTranscriptSequence } from "./transcript-messages.js";
import type { CheckpointWiring } from "./checkpoint-gate.js";
import type { AddressedUserInput } from "../domain/input-queue.js";
import { drainPendingInput, promoteGapInput, waitingReasonFor } from "./iteration-gap.js";
import { assembleEngine, buildTurnResult, settleTranscript, type Engine, type TurnDiffSnapshot } from "./runner-engine.js";
import { cancellationStanding, followCancellation, type CancelWatch } from "./cancel.js";
import {
  applyStreamInputs,
  currentPhase,
  dispatch,
  unsettledToolCallCount,
  views,
} from "./runner-effects.js";
import { emitCompactionFor, gapHostFor } from "./host-views.js";
import { createToolArgumentNormalizer } from "./tool-boundary.js";
import type { ExecutionProgressPort } from "../ports/execution-progress.js";
import type { ExecPolicyGuard } from "./tool-admission.js";
import { flushProgress, flushStreamItems, preserveOpenBlocks } from "./progress.js";
import { applyTurnRepairs } from "./turn-repairs.js";
import { budgetIteration, type BudgetIteration } from "./budget-final-report.js";

/**
 * How many provider-rejection recoveries one turn may attempt (WP09.3/L06).
 * One, not zero: a refusal a compaction can answer deserves its answer. One,
 * not two: a provider that rejects the compacted view too has said something
 * the loop cannot fix, and the turn must end as that failure.
 */
const MAX_REACTIVE_RECOVERIES_PER_TURN = 1;

export type LoopPorts = {
  /** A host-configured command policy participates in the same admission owner. */
  readonly execPolicy?: ExecPolicyGuard;
  /** Awaited durable facts before effects; absent preserves the library path. */
  readonly progress?: ExecutionProgressPort;
  readonly provider: ProviderPort;
  readonly tools: ToolPort;
  readonly permission: PermissionPort;
  readonly profile: ProfilePort;
  /**
   * Absent means nothing may mutate the workspace: approval-needing calls stop
   * at the sandbox step before any question is asked.
   */
  readonly sandbox?: ToolSandbox;
  /** Injected so a host can carry remembered decisions across turns. */
  readonly grants?: PermissionGrantCache;
  readonly doom?: DoomLoopTracker;
  /**
   * Absent means the transcript goes whole. Present means the iteration gap —
   * tools settled, next request not built — may replace it with one window.
   */
  readonly compaction?: CompactionWiring;
  /**
   * Absent means the method subsystem never ticks: no beat reported, no slot
   * compiled, no text held back, every request byte for byte the un-wired one.
   */
  readonly method?: MethodLearningPort;
  /**
   * Absent means the tool-gap awareness layer never ticks: no self-report
   * prompt, no second stripper, no beat observation. Independent of `method`
   * because it is a different subsystem (P05 tool learning §2 source ③).
   */
  readonly toolGap?: ToolGapPort;
  /**
   * Mid-run messages from the person driving the turn; absent means never.
   *
   * Called with the id of the turn that is asking, because the loop is the only
   * party that knows which turn is asking: a host holding words typed for a
   * turn that has already ended must be able to answer "nothing for you" rather
   * than hand them to whoever came next (WP08.1). The loop still filters what
   * comes back — the same two halves as the reducer's `turning` boundary, so the
   * guarantee survives a host that answers loosely.
   */
  readonly pendingInput?: (turnId: string) => ReadonlyArray<AddressedUserInput>;
  /** Absent means a write runs with no undo. Present is one snapshot a turn. */
  readonly checkpoint?: CheckpointWiring;
};

export type RunTurnRequest = {
  readonly sessionId: string;
  readonly turnId: string;
  readonly correlationId: string;
  readonly text: string;
  readonly model?: string;
  readonly budget?: IterationBudget;
  /**
   * The pricing pair the caller resolved for this run (WP09.3/L07). Present,
   * every stream's usage is priced into the engine's accumulated cost, which
   * a `maxCostUsd` budget ceiling reads. Absent — every caller that predates
   * the dollar budget — means usage is not priced and the ceiling cannot fire.
   */
  readonly pricing?: UsagePricing;
  readonly cancelAfter?: "streaming";
  /**
   * A cancellation the caller can raise while the turn is in flight
   * (WP `2026-09-16-WP-传统CLI-交付面收尾波` D3). Aborting it is a *state
   * transition*, not an exception: the loop applies the same `cancel` input a
   * reducer decision would, so the turn ends `cancelled` and the journal holds
   * `user_cancel`. Absent — every caller that has nobody to interrupt it —
   * means the turn cannot be stopped from outside, exactly as it was before
   * this field existed.
   */
  readonly cancelSignal?: AbortSignal;
  /**
   * Milliseconds since the epoch, for envelope timestamps. The host owns the
   * clock and lends it here; absent — every caller that has none, including
   * every hermetic test — stamps the fixed epoch, so a run without a clock is
   * deterministic rather than wall-clocked.
   */
  readonly now?: () => number;
  /**
   * An observer of this turn's journal (WP D1). Present, it is called once
   * per envelope in emit order; absent — every caller before this field
   * existed — means the turn runs exactly as it did without it. It is an
   * observer only: its return value is ignored, a throw is swallowed and
   * reported as a degradation, and it has no way to end or steer the turn.
   */
  readonly onEnvelope?: EnvelopeSink;
  readonly retryOnce?: boolean;
  readonly verifyAfter?: Exclude<VerificationStatus, "unset">;
  /**
   * Transcript reloaded from a durable session: the messages sent to the
   * provider are rebuilt from this, not from UI text.
   */
  readonly resumedTranscript?: Transcript;
  /**
   * The window a durable session projects under. Without it a resume replays
   * the text a stored window already replaced.
   */
  readonly resumedWindow?: CompactWindow;
  /** The journal a resume was loaded from: its windows are already live. */
  readonly resumedRecords?: ReadonlyArray<SessionRecord>;
  /**
   * Canonical messages the caller has already decided this turn must carry —
   * the project's own engineering rules and the real platform, in WP-CLI-B1
   * terms. They are assembled by the CLI host and enter the request through the
   * one existing seam (`contextFromProfile.assemble`), so the loop still knows
   * nothing about where they came from.
   *
   * Absent — every caller that predates this field, which is every hermetic test
   * — means the turn carries exactly the messages it always did. They are not
   * transcript items: a resume rebuilds its own history from the journal, and
   * re-reading whatever the host said last turn would be a second, drifting
   * source for the same rules.
   */
  readonly callerMessages?: ReadonlyArray<Message>;
  /**
   * A caller-supplied system prompt (`--system-prompt` replace or
   * `--append-system-prompt` append). Absent — every caller that predates
   * this field — means the seeds are exactly the ones the un-wired path
   * assembles.
   */
  readonly systemPrompt?: SystemPromptDirective;
  /**
   * Text appended as a system message after the seeds. Applied after
   * `systemPrompt`, so the two flags compose in legacy order.
   */
  readonly systemPromptAppend?: string;
  /**
   * JSON Schema the final answer must satisfy (`--output-schema`). Absent
   * means the provider decides its own shape, exactly as before this field
   * existed.
   */
  readonly responseSchema?: JsonObject;
};

export type RunTurnResult = {
  readonly state: ExecutionState;
  readonly envelopes: readonly Envelope[];
  readonly checksums: readonly string[];
  readonly issuedKeys: readonly string[];
  readonly committedKeys: readonly string[];
  readonly inputs: readonly ReduceInput[];
  readonly transcript: Transcript;
  readonly usage: ProviderUsage;
  readonly iterations: number;
  /** Windows stored this turn, oldest first; the loop writes no journal itself. */
  readonly compactions: readonly CompactRecordDraft[];
  /** Derived decision numbering for mapping compact bounds onto durable records. */
  readonly compactionSourceRecords?: ReadonlyArray<SessionRecord>;
  readonly promptView: CompactWindow | undefined;
  /** The turn's net file diff (WP11/C20), aggregated live from committed outcomes. */
  readonly turnDiff: TurnDiffSnapshot;
  /**
   * Messages the turn took from its inbox and never delivered: accepted, and
   * then orphaned by a turn that ended before it could promote them (WP08.3).
   *
   * Empty on every turn that consumed what it took — which is every turn that
   * predates this field. Non-empty is a fact the surface must act on: restore
   * the text into the composer, or offer it to the next turn. Returning them is
   * the only thing that makes "accepted, then never answered" visible instead
   * of something the engine quietly garbage-collects.
   */
  readonly unconsumedInput: ReadonlyArray<AddressedUserInput>;
};

export async function runTurn(ports: LoopPorts, request: RunTurnRequest): Promise<RunTurnResult> {
  const abort = new AbortController();
  // The host — seed messages, transcript, every port defaulted — is assembled
  // out of line; what follows is the turn's phases, in the order they happen.
  const engine = await assembleEngine(ports, request, abort);
  await flushProgress(engine, ports);
  const cancelled = followCancellation(request.cancelSignal, engine);
  await dispatch(engine, ports, {
    type: "start_turn",
    eventId: nextId(engine),
    sessionId: request.sessionId,
    turnId: request.turnId,
    correlationId: request.correlationId,
    text: request.text,
  });
  await runIterations(engine, ports, cancelled);
  await applyTurnRepairs(engine, ports, request, cancelled, runIterations);
  await reportTurnEnd(ports.method, engine.state.turnId);
  // Before the flush, not on the way out: the recorder persists
  // `engine.transcript`, so a cancelled turn's open calls have to be answered in
  // the journal itself and not only in the value this function returns.
  settleTranscript(engine);
  await flushProgress(engine, ports);
  return buildTurnResult(engine);
}

/**
 * The turn loop. One iteration is one provider stream plus every tool call it
 * produced; the loop — not the provider, not a reducer command — decides
 * whether the turn continues, so nested streams cannot interleave.
 *
 * Both guards below return a boolean rather than acting, so the loop body stays
 * readable as the four questions it asks in order: is the turn over, is it
 * cancelled, is the budget still standing, and what did this iteration settle.
 */
async function runIterations(
  engine: Engine,
  ports: LoopPorts,
  cancelled: CancelWatch,
): Promise<void> {
  for (;;) {
    if (currentPhase(engine) === "terminal") {
      return;
    }
    // `cancellationStanding` reads the phase itself, so this is the same
    // question the guard above asked — plus the two ways a cancel is raised.
    if (cancellationStanding(cancelled, engine)) {
      await dispatch(engine, ports, { type: "cancel", eventId: nextId(engine) });
      return;
    }
    if (await budgetCeiling(engine, ports)) {
      return;
    }
    const iteration = budgetIteration(engine, ports);
    const outcome = await runOneIteration(engine, iteration.ports, cancelled, iteration.purpose);
    if (currentPhase(engine) === "terminal") {
      // The stream ended the turn: nothing settled, so there is no beat.
      return;
    }
    // Checked before the iteration is settled, not after: a turn whose last beat
    // is one tool call away from `completed` must still obey a cancel that
    // arrived while that call was running.
    if (cancellationStanding(cancelled, engine)) {
      await dispatch(engine, ports, { type: "cancel", eventId: nextId(engine) });
      return;
    }
    // D5: a provider-side truncation (`finish_reason: length`, i.e. the
    // `max_tokens` we sent — or the provider's own ceiling — cut the stream)
    // is a failure, never a completion. Without this a `--max-tokens` run that
    // the provider truncated ends `completed` exit 0: the flag silently did
    // nothing observable. The usage-budget check beside it is the client-side
    // half: a provider that ignored `max_tokens` and stopped normally with the
    // budget spent still fails instead of completing.
    if (await outputBudgetSpent(engine, ports)) {
      return;
    }
    const decision = decideIterationEnd({
      providerFinished: outcome.finished,
      unsettledToolInputCount: engine.state.openToolInputIds.length,
      unsettledToolCallCount: unsettledToolCallCount(engine.state),
      requiresFollowUp: engine.state.requiresFollowUp,
      budgetVerdict: { kind: "within_budget" },
      pendingUserInputCount: drainPendingInput(gapHostFor(engine, ports, views), engine.state.turnId),
    });
    // Reported before the loop decides what comes next, so a card learned on a
    // turn's *last* beat is archived too: archiving never waited for one.
    await reportBeat({
      port: ports.method,
      turnId: engine.state.turnId,
      beat: engine.iterations,
      transcript: engine.transcript,
      tools: iteration.ports.tools,
      take: outcome.method,
      emit: (kind, payload) => emitRaw(engine, kind, payload),
    });
    await reportToolGapBeat({
      port: ports.toolGap,
      turnId: engine.state.turnId,
      beat: engine.iterations,
      transcript: engine.transcript,
      tools: iteration.ports.tools,
      take: outcome.toolGap,
      emit: (kind, payload) => emitRaw(engine, kind, payload),
    });
    if (!(await settleIteration(engine, ports, decision))) {
      return;
    }
  }
}

/** Apply one iteration's decision; true means another iteration follows. */
async function settleIteration(
  engine: Engine,
  ports: LoopPorts,
  decision: ReturnType<typeof decideIterationEnd>,
): Promise<boolean> {
  if (decision.kind === "continue") {
    // The gap: every tool call has settled and the next request is not built
    // yet, so replacing history here cannot race a stream.
    await promoteGapInput(gapHostFor(engine, ports, views));
    await emitCompactionFor(engine, ports);
    return true;
  }
  if (decision.kind === "complete") {
    await dispatch(engine, ports, { type: "turn_complete", eventId: nextId(engine) });
    return false;
  }
  await dispatch(engine, ports, {
    type: "turn_failed",
    eventId: nextId(engine),
    reason: decision.kind === "wait" ? waitingReasonFor(decision.reason) : decision.reason,
  });
  return false;
}

/**
 * Whether the turn continues, and the proposal this beat's channel extracted. */
type IterationOutcome = {
  readonly finished: boolean;
  readonly method: MethodChannelTake | undefined;
  readonly toolGap: ToolGapTake | undefined;
};

/** True when the provider stream reached a terminal `finish`. */
async function runOneIteration(
  engine: Engine,
  ports: LoopPorts,
  cancelled: CancelWatch,
  purpose: BudgetIteration["purpose"],
): Promise<IterationOutcome> {
  await dispatch(engine, ports, { type: "begin_stream", eventId: nextId(engine) });
  if (engine.contextDegradedReason !== undefined && !engine.contextDegradationReported) {
    emitRaw(engine, "observation", {
      degraded: true,
      reason: engine.contextDegradedReason,
    });
    engine.contextDegradationReported = true;
  }
  if (currentPhase(engine) === "terminal") {
    return { finished: false, method: undefined, toolGap: undefined };
  }
  engine.iterations += 1;
  // The transcript length the request about to be built will cover; the
  // server's report for it is only comparable to a later basis if the world it
  // measured is recorded beside the number (WP09.1/C35).
  const requestTranscriptLength = engine.transcript.length;
  const teaching = await teachingFor(
    ports.method,
    ports.toolGap,
    engine.state.turnId,
    engine.iterations,
    ports.tools,
  );
  const assembledRequest = buildRequest({
    attemptId: engine.state.currentAttemptId,
    model: engine.model,
    continuationScope: providerContinuationScope(engine.state.sessionId, engine.state.turnId),
    ...(purpose === "final_report" ? { finalReport: "budget_limit" as const } : {}),
    tools: ports.tools,
    prompt: promptContextFor(engine, ports.compaction, ports.tools),
    // The budget lives on the engine; the request states it so the adapter
    // actually sends it (D5: --max-tokens never reached the wire before).
    ...(engine.budget.maxOutputTokens === undefined
      ? {}
      : { maxOutputTokens: engine.budget.maxOutputTokens - engine.usage.outputTokens }),
    ...(teaching.slot === undefined ? {} : { slot: teaching.slot.message }),
    ...(teaching.toolGapSlot === undefined ? {} : { toolGapSlot: teaching.toolGapSlot }),
    // WP18.3: caller prompt and schema ride the same way — stated on the
    // request so the adapter sends them, absent when never asked for.
    ...(engine.systemPrompt === undefined ? {} : { systemPrompt: engine.systemPrompt }),
    ...(engine.systemPromptAppend === undefined ? {} : { systemPromptAppend: engine.systemPromptAppend }),
    ...(engine.responseSchema === undefined ? {} : { responseSchema: engine.responseSchema }),
  });
  const request = await fitRequestToContext(engine, ports, assembledRequest);
  if (request === undefined) return { finished: false, method: undefined, toolGap: undefined };
  const streamedInputs = new Set<string>();
  const observation = await consumeProviderStream({
    port: ports.provider, request,
    signal: engine.abort.signal,
    onWarning: warning => emitRaw(engine, "observation", { component: "provider", degraded: true, code: warning.code, message: warning.message,
      ...(warning.diagnostic === undefined ? {} : { diagnostic: warning.diagnostic }) }),
    startSequence: nextTranscriptSequence(engine.transcript),
    nextEventId: () => nextId(engine),
    // One normalizer per turn, built from the catalog this turn will actually
    // call: the same object decides what the tool is handed and what the
    // transcript records.
    normalizeArguments: createToolArgumentNormalizer(ports.tools),
    onTranscriptItems: items => flushStreamItems(ports.progress, items),
    onPartial: partials => preserveOpenBlocks(ports.progress, partials),
    onInput: async input => {
      if (input.type !== "text_delta" && input.type !== "reasoning_delta") return;
      // Stream visible deltas through the canonical reducer immediately. Tool
      // requests remain one scheduling batch until the provider has finished.
      await applyStreamInputs(engine, ports, [input]);
      streamedInputs.add(input.eventId);
      if (currentPhase(engine) === "terminal") engine.abort.abort();
    },
    ...(teaching.channel === undefined ? {} : { channel: teaching.channel }),
    ...(teaching.feedbackChannel === undefined ? {} : { feedbackChannel: teaching.feedbackChannel }),
    ...(teaching.toolGapChannel === undefined ? {} : { toolGapChannel: teaching.toolGapChannel }),
    // A real send is committed at the first `stream_start`, while the stream is
    // still open (audit P1-1): the model has accepted the request the moment start
    // arrives, so a crash mid-stream must not lose an exposure that really happened.
    // This runs ahead of both the cancellation check and the feedback below — a
    // cancel landing *after* start still fielded the slot (F09), and any write
    // failure is a structured degradation on the board side, never a turn failure.
    onStreamStart: () =>
      recordFielding({
        port: ports.method,
        turnId: engine.state.turnId,
        attemptId: engine.state.currentAttemptId,
        beat: engine.iterations,
        slot: teaching.slot,
        sawStreamStart: true,
      }),
  });
  engine.promptTokens = observation.usage.inputTokens;
  engine.promptReport = {
    promptTokens: observation.usage.inputTokens,
    transcriptLength: requestTranscriptLength,
    windowId: engine.compaction.window === undefined ? undefined : engine.compaction.window.windowId,
  };
  engine.usage = accumulateUsage(engine.usage, observation.usage);
  engine.costUsd += streamCostUsd(observation.usage, engine.pricing);
  for (const item of observation.transcriptItems) {
    engine.transcript = [...engine.transcript, item];
  }
  // Feedback is recorded here, right after the fielding it attributes against and
  // ahead of the cancellation check: it is gated on `sawFinish`, so only a response
  // that actually completed carries a self-report. A cut/cancelled/errored response
  // has `sawFinish === false` and records nothing — feedback stays unknown, never
  // false (F03/F05). A cancel landing *after* finish cannot un-finish this answer.
  await recordFeedback({
    port: ports.method,
    turnId: engine.state.turnId,
    attemptId: engine.state.currentAttemptId,
    beat: engine.iterations,
    finished: observation.sawFinish,
    take: teaching.feedbackChannel?.take(),
    emit: (kind, payload) => emitRaw(engine, kind, payload),
  });
  // A cancellation raised while this stream was open lands here, ahead of the
  // stream's own inputs: an adapter that reports the cut as a transport error
  // rather than a `cancel_ack` must not turn a cancel into a failure. Whatever
  // text the stream produced before the cut is kept — it really was produced.
  if (cancellationStanding(cancelled, engine)) {
    await dispatch(engine, ports, { type: "cancel", eventId: nextId(engine) });
    return { finished: false, method: undefined, toolGap: undefined };
  }
  // The provider refused the request itself (WP09.3/L06). Before the failure
  // becomes the turn's, one honest recovery is tried — a forced compaction and
  // a single retry for a prompt the provider called too long. Media refusals
  // are classified and reported, never "recovered" by dropping the user's
  // attachment. Both bounded by `reactiveCompactions`: one attempt per turn.
  if (
    !observation.sawStreamStart &&
    observation.budgetRejection?.kind === "prompt_too_long" &&
    engine.reactiveCompactions < MAX_REACTIVE_RECOVERIES_PER_TURN &&
    ports.compaction !== undefined
  ) {
    engine.reactiveCompactions += 1;
    const outcome = await emitCompactionFor(engine, ports, { force: true });
    if (outcome.storedWindow) {
      if (engine.budget.finalRequest === "report_only" && await budgetCeiling(engine, ports)) {
        return { finished: false, method: undefined, toolGap: undefined };
      }
      const retry = budgetIteration(engine, ports);
      return runOneIteration(engine, retry.ports, cancelled, retry.purpose);
    }
  }
  if (!observation.sawStreamStart && observation.budgetRejection?.kind === "media_too_large") {
    emitRaw(engine, "observation", {
      degraded: true,
      component: "provider",
      reason: "media_too_large",
    });
  }
  const finish = await applyStreamInputs(engine, ports, observation.inputs.filter(input => !streamedInputs.has(input.eventId)));
  if (finish !== undefined && currentPhase(engine) !== "terminal") {
    await dispatch(engine, ports, finish);
  }
  return {
    finished: finish?.type === "finish" && isSuccessfulStreamFinish(finish.reason),
    method: teaching.channel?.take(),
    toolGap: teaching.toolGapChannel?.take(),
  };
}
