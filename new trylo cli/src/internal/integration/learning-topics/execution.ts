import { prepareTopicOpportunity, type TopicOpportunityInput } from "../../learning/domains/shared/topics/opportunity.js";
import { freezeTopicOpportunityInput, readTopicOpportunitySources } from "../../learning/domains/shared/topics/opportunity-input.js";
import { readInformationModel } from "../../learning/domains/shared/topics/information-model.js";
import { planTopicInformation } from "../../learning/domains/shared/topics/information-plan.js";
import { applyTopicObservation } from "../../learning/domains/shared/topics/information-observation.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { identity } from "../../validation/json-shape.js";
import { createRewardV2BoardPort } from "../reward/v2-board-port.js";
import { boundedOperation } from "../shared/bounded-operation.js";
import { readTopicProbeReceipt, type TopicProbePort, type TopicProbeReceipt } from "./execution-contract.js";
import { replayTopicExecution, startProbe, executionFactId, verifyStartedClaim, TOPIC_EXECUTION_VERSION, type TopicExecutionFrame,
  type TopicExecutionState, type ProbeStarted, type ProbeResult, type ProbeUnknown } from "./execution-state.js";
import type { createTopicBudgetPool, IssuedTopicAllocation } from "./pool.js";

type Options = { readonly boardRoot: string; readonly input: TopicOpportunityInput; readonly grant: IssuedTopicAllocation;
  readonly pool: ReturnType<typeof createTopicBudgetPool>; readonly checkerVersion: string; readonly executionVersion: string;
  readonly enabled?: () => boolean; readonly timeoutMs?: number; readonly requestId?: string };

/** Explicit domain composition. It never interprets model discriminator text as executable code or grants permission. */
export function createTopicDomainExecution(options: Options) {
  const enabled = options.enabled ?? (() => false), timeoutMs = options.timeoutMs ?? 5000;
  const pool = options.pool, grant = options.grant;

  if (!enabled()) return { status: "disabled" as const };

  if (!identity(options.checkerVersion) || !identity(options.executionVersion)
    || (options.requestId !== undefined && !identity(options.requestId)) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000
    || options.input.probeBindingHash !== contentHashOf({ checkerVersion: options.checkerVersion, executionVersion: options.executionVersion })) {
    return { status: "rejected" as const, reason: "topic_probe_versions_unbound" };
  }

  const offer = prepareTopicOpportunity(options.input);
  if (offer.status !== "offered") return { status: "rejected" as const, reason: "topic_execution_unvalued" };

  const allocation = grant.allocations.find(row => row.domain === offer.bid.domain), bidHash = contentHashOf(offer.bid);
  if (allocation === undefined || allocation.valuationId !== offer.bid.valuationId || allocation.bidHash !== bidHash) {
    return { status: "rejected" as const, reason: "topic_execution_grant_binding" };
  }

  // Capture accepted input before any await, so subsequent caller mutations cannot replace the frozen policy.
  const captured = freezeTopicOpportunityInput(options.input);
  if (captured === undefined) return { status: "rejected" as const, reason: "topic_execution_unvalued" };

  // Old persisted frames keep their canonical strings. New candidate sources retain their exact original bytes.
  const modelJson = canonicalJson(JSON.parse(captured.modelJson!));
  const input: TopicOpportunityInput = captured.candidates !== undefined ? Object.freeze({ ...captured, modelJson })
    : Object.freeze({ ...captured, modelJson, windowJson: canonicalJson(JSON.parse(captured.windowJson)),
      proposals: Object.freeze(captured.proposals.map(text => canonicalJson(JSON.parse(text)))) });
  const sources = readTopicOpportunitySources(input);
  if (sources.status !== "ready") return { status: "rejected" as const, reason: "topic_execution_unvalued" };

  const topics = sources.topics, experimentBindings = sources.bindings;
  const controllerId = `ws1-domain:${contentHashOf([TOPIC_EXECUTION_VERSION, grant.allocationId, bidHash])}`;
  const frame: TopicExecutionFrame = { schemaVersion: 1, type: "ws1_topic_execution_init", controllerId, scope: offer.bid.scope, domain: offer.bid.domain,
    allocationId: grant.allocationId, valuationId: offer.bid.valuationId, bidHash, quota: allocation.quota,
    checkerVersion: options.checkerVersion, executionVersion: options.executionVersion, input,
    ...(options.requestId === undefined ? {} : { requestId: options.requestId }) };
  if (canonicalJson(frame).length > 131072) return { status: "rejected" as const, reason: "topic_execution_capacity" };

  const board = createRewardV2BoardPort(options.boardRoot, enabled);
  let busy = false, suspended = false;

  async function run<T>(operation: () => Promise<T>) {
    if (!enabled()) return { status: "disabled" as const };

    if (busy) return { status: "rejected" as const, reason: "topic_execution_busy" };

    if (suspended) return { status: "unknown" as const, reason: "topic_execution_suspended" };

    busy = true;

    try { return await operation(); }
    catch {
      suspended = true;
      return { status: "unknown" as const, reason: "topic_execution_unconfirmed" };
    }
    finally { busy = false; }
  }

  const read = async () => {
    const view = await board.read();
    return { view, state: replayTopicExecution(frame, view.facts) };
  };

  async function append(id: string, kind: "learning_decision" | "opportunity" | "feedback", body: unknown) {
    const current = await board.read();
    const result = await board.append(current.revision, { id, scope: frame.scope, algorithmVersion: TOPIC_EXECUTION_VERSION, kind, payloadJson: canonicalJson(body) });
    if (result.status === "stale") throw new Error("topic_execution_stale");
    return result;
  }

  async function recordUnknown(start: ProbeStarted, reason: string, receipt: TopicProbeReceipt | null = null) {
    const record: ProbeUnknown = { schemaVersion: 1, type: "ws1_topic_probe_unknown", spendId: start.expected.spendId, reason, receipt };
    await append(executionFactId(frame, "result", record.spendId), "feedback", record);
    return { status: "unknown" as const, reason };
  }

  async function observe(start: ProbeStarted, state: TopicExecutionState, port: TopicProbePort, signal: AbortSignal) {
    const topic = topics.get(start.expected.questionId);
    if (topic === undefined) throw new Error("topic_execution_topic_missing");

    let receipt: TopicProbeReceipt | undefined;

    try {
      receipt = await boundedOperation(signal, timeoutMs, async bounded => {
        const experimentBinding = experimentBindings.get(topic.topicId);
        const ref = await port.run({ ...start.expected, topic,
          ...(experimentBinding === undefined ? {} : { experimentBinding }), signal: bounded });
        if (bounded.aborted || !enabled() || !identity(ref)) throw new Error("topic_probe_stopped");

        const json = await port.readObservation(ref, start.expected, bounded);

        if (bounded.aborted || !enabled()) throw new Error("topic_probe_stopped");

        return readTopicProbeReceipt(json, ref, start.expected);
      }, "topic_probe_stopped");
    } catch { return recordUnknown(start, "topic_probe_unknown"); }

    if (signal.aborted || !enabled()) return recordUnknown(start, "topic_probe_cancelled");

    if (receipt === undefined) return recordUnknown(start, "topic_probe_binding");

    const update = applyTopicObservation(state.modelJson, start.expected.questionId, receipt.outcome);
    if (update.status !== "updated") return recordUnknown(start, "topic_probe_out_of_model", receipt);

    const record: ProbeResult = { schemaVersion: 1, type: "ws1_topic_probe_result", spendId: start.expected.spendId,
      receipt, modelAfterHash: contentHashOf(update.model) };

    await append(executionFactId(frame, "result", record.spendId), "feedback", record);

    return { status: "observed" as const, questionId: start.expected.questionId, remaining: state.remaining - update.spentUnits };
  }

  return { status: "ready" as const, controller: Object.freeze({
    inspect: () => ({ busy, suspended }),
    view: () => run(async () => ({ status: "state" as const, ...(await read()).state })),
    open: () => run(async () => {
      const { state } = await read();
      if (!state.opened) await append(controllerId + ":init", "learning_decision", frame);
      return { status: "open" as const, ...(await read()).state };
    }),
    step: (port: TopicProbePort, signal: AbortSignal) => run(async () => {
      if (signal.aborted) return { status: "cancelled" as const };

      const { state } = await read();

      if (!state.opened) return { status: "rejected" as const, reason: "topic_execution_not_open" };

      if (state.pending !== null || state.unknown) return { status: "unknown" as const, reason: "topic_probe_pending" };

      const choice = planTopicInformation(state.modelJson, state.remaining);
      if (choice.status !== "planned") return { status: "rejected" as const, reason: "topic_execution_planning_unavailable" };

      if (choice.questionId === null) return { status: "stopped" as const };

      const model = readInformationModel(state.modelJson);
      if (!model.ok) throw new Error("topic_execution_model_invalid");

      const question = model.model.questions.find(q => q.id === choice.questionId)!;
      const candidate = startProbe(frame, state, question.id, question.units, "not-claimed");
      const claim = await pool.claim(grant, frame.domain, frame.valuationId, question.units, candidate.expected.spendId);
      if (claim.status !== "claimed") return { status: "unknown" as const, reason: "topic_execution_claim_unconfirmed" };

      const start = startProbe(frame, state, question.id, question.units, claim.claimId);
      const claimedPrefix = await board.read();

      try { verifyStartedClaim(frame, start, claimedPrefix.facts, claimedPrefix.revision + 1); }
      catch {
        // A valid pool claim may still violate this frozen domain policy (for example external preconsumption).
        // Persist an explicit halt, never append a started record that our own replay would reject.
        await append(`${controllerId}:halted:${contentHashOf(start.expected.spendId)}`, "feedback", {
          schemaVersion: 1, type: "ws1_topic_execution_halted", reason: "topic_execution_claim_mismatch",
          claimId: claim.claimId, spendId: start.expected.spendId, modelHash: start.expected.modelHash });
        return { status: "unknown" as const, reason: "topic_execution_claim_mismatch" };
      }

      const written = await append(executionFactId(frame, "started", start.expected.spendId), "opportunity", start);
      if (written.idempotent) return { status: "unknown" as const, reason: "topic_probe_pending" };

      // Check the actual prior claim's units/offset before any side effect, including concurrent-owner interference.
      const checked = await read();
      if (checked.state.pending === null || checked.state.unknown || canonicalJson(checked.state.pending) !== canonicalJson(start)) {
        return { status: "unknown" as const, reason: "topic_probe_pending" };
      }

      if (signal.aborted || !enabled()) return recordUnknown(start, "topic_probe_cancelled");

      return observe(start, state, port, signal);
    }),
  }) };
}
