import type { TopicOpportunityInput } from "../../learning/domains/shared/topics/opportunity.js";
import { readTopicOpportunitySources } from "../../learning/domains/shared/topics/opportunity-input.js";
import type { GroundedTopic } from "../../learning/domains/shared/topics/contracts.js";
import { applyTopicObservation } from "../../learning/domains/shared/topics/information-observation.js";
import { readInformationModel } from "../../learning/domains/shared/topics/information-model.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import type { RewardV2Fact } from "../../learning/reward/v2-facts.js";
import { fields, identity } from "../../validation/json-shape.js";
import { allocateTopicBudget } from "../../learning/control/topic-allocation.js";
import { readTopicProbeReceipt, topicProbeExpectationKeys, type TopicProbeExpectation, type TopicProbeReceipt } from "./execution-contract.js";
import { readPoolClaim } from "./pool-ledger.js";
import { topicExperimentBindingHash } from "../../learning/domains/shared/topics/experiment-binding.js";
import { topicExperimentBindings } from "./experiment-binding.js";

export type TopicExecutionFrame = { readonly schemaVersion: 1; readonly type: "ws1_topic_execution_init"; readonly controllerId: string;
  readonly scope: string; readonly domain: GroundedTopic["domain"]; readonly allocationId: string; readonly valuationId: string;
  readonly bidHash: string; readonly quota: number; readonly checkerVersion: string; readonly executionVersion: string; readonly input: TopicOpportunityInput;
  readonly requestId?: string };

export const TOPIC_EXECUTION_VERSION = "ws1-topic-execution-v1";

export type ProbeStarted = { readonly schemaVersion: 1; readonly type: "ws1_topic_probe_started"; readonly expected: TopicProbeExpectation;
  readonly remainingBefore: number };

export type TopicExecutionState = { readonly opened: boolean; readonly modelJson: string; readonly remaining: number;
  readonly applied: number; readonly pending: ProbeStarted | null; readonly unknown: boolean };

export type ProbeResult = { readonly schemaVersion: 1; readonly type: "ws1_topic_probe_result"; readonly spendId: string;
  readonly receipt: TopicProbeReceipt; readonly modelAfterHash: string };

export type ProbeUnknown = { readonly schemaVersion: 1; readonly type: "ws1_topic_probe_unknown"; readonly spendId: string;
  readonly reason: string; readonly receipt: TopicProbeReceipt | null };

type PoolClaimSource = { readonly key: string; readonly algorithmVersion: string };

export function startProbe(frame: TopicExecutionFrame, state: TopicExecutionState, questionId: string, units: number, claimId: string): ProbeStarted {
  const modelHash = contentHashOf(JSON.parse(state.modelJson));
  const spendId = probeSpendId(frame, questionId);
  const sources = readTopicOpportunitySources(frame.input);
  if (sources.status !== "ready") throw new Error("topic_execution_corrupt");

  const experimentBinding = sources.bindings.get(questionId);

  return Object.freeze({ schemaVersion: 1, type: "ws1_topic_probe_started", remainingBefore: state.remaining,
    expected: Object.freeze({ scope: frame.scope, domain: frame.domain, allocationId: frame.allocationId, valuationId: frame.valuationId,
      questionId, units, modelHash, spendId, claimId, checkerVersion: frame.checkerVersion, executionVersion: frame.executionVersion,
      ...(frame.input.domainDecisionHash === undefined ? {} : { decisionBasisHash: frame.input.domainDecisionHash }),
      ...(experimentBinding === undefined ? {} : { experimentBindingHash: topicExperimentBindingHash(experimentBinding) }) }) });
}

function probeSpendId(frame: TopicExecutionFrame, questionId: string): string {
  return `ws1-probe:${contentHashOf([frame.controllerId, questionId])}`;
}

export function executionFactId(frame: TopicExecutionFrame, phase: "started" | "result", spendId: string): string {
  return `${frame.controllerId}:${phase}:${contentHashOf(spendId)}`;
}

/** Starts from the frozen initial model on every replay. Each durable observation is applied once in sequence. */
export function replayTopicExecution(frame: TopicExecutionFrame, facts: readonly RewardV2Fact[]): TopicExecutionState {
  if (frame.input.modelJson === null) throw new Error("topic_execution_model_required");

  const sources = readTopicOpportunitySources(frame.input), model = readInformationModel(frame.input.modelJson);
  if (sources.status !== "ready" || !model.ok || sources.topics.size !== model.model.questions.length
    || sources.domain !== frame.domain || [...sources.topics.values()].some(topic => topic.scope !== frame.scope)
    || model.model.questions.some(question => !sources.topics.has(question.id))) throw new Error("topic_execution_corrupt");

  if (sources.bindings.size > 0) {
    const recorded = topicExperimentBindings(facts, frame.scope);
    for (const binding of sources.bindings.values()) {
      if (!recorded.some(row => canonicalJson(row) === canonicalJson(binding))) throw new Error("topic_execution_binding_missing");
    }
  }

  const startedClaims = new Set<string>();
  let claimSource: PoolClaimSource | undefined;
  let state: TopicExecutionState = { opened: false, modelJson: frame.input.modelJson, remaining: frame.quota, applied: 0, pending: null, unknown: false };

  for (const fact of facts) {
    if (!fact.id.startsWith(frame.controllerId + ":")) continue;

    if (fact.scope !== frame.scope || fact.algorithmVersion !== TOPIC_EXECUTION_VERSION) throw new Error("topic_execution_corrupt");

    const raw: unknown = JSON.parse(fact.payloadJson);

    if (fact.id === frame.controllerId + ":init") {
      if (state.opened || fact.kind !== "learning_decision" || canonicalJson(raw) !== canonicalJson(frame)) throw new Error("topic_execution_corrupt");
      claimSource = verifyReservation(frame, facts, fact.sequence);
      state = { ...state, opened: true };
      continue;
    }

    if (!state.opened || state.unknown || typeof raw !== "object" || raw === null) throw new Error("topic_execution_corrupt");

    const row = raw as Record<string, unknown>;
    if (row.type === "ws1_topic_probe_started") {
      state = replayStart(frame, state, fact, row);
      verifyClaim(frame, state.pending!, facts, fact.sequence, claimSource!);
      startedClaims.add(state.pending!.expected.claimId);
    }
    else if (row.type === "ws1_topic_execution_halted") state = replayHalt(frame, state, fact, row, facts, claimSource!);
    else state = replayResult(frame, state, fact, row);
  }

  return reconcileUnstartedClaims(frame, state, facts, startedClaims, claimSource);
}

/** A process can die after the pool commit and before started. Missing execution facts never refund that charge. */
function reconcileUnstartedClaims(frame: TopicExecutionFrame, state: TopicExecutionState, facts: readonly RewardV2Fact[], startedClaims: ReadonlySet<string>, source: PoolClaimSource | undefined): TopicExecutionState {
  if (!state.opened) return state;

  if (source === undefined) throw new Error("topic_execution_reservation_missing");

  const initial = readInformationModel(frame.input.modelJson!);
  if (!initial.ok) throw new Error("topic_execution_corrupt");

  const ownedSpends = new Set(initial.model.questions.map(question => probeSpendId(frame, question.id)));
  let chargedThrough = 0, orphaned = false;

  for (const fact of facts) {
    if (fact.scope !== frame.scope || !fact.id.startsWith(source.key + ":claim:")) continue;

    const raw: unknown = JSON.parse(fact.payloadJson);
    if (typeof raw !== "object" || raw === null || !("allocationId" in raw) || raw.allocationId !== frame.allocationId
      || !("domain" in raw) || raw.domain !== frame.domain || !("valuationId" in raw) || raw.valuationId !== frame.valuationId) continue;

    const claim = boundClaim(frame, source, fact);

    chargedThrough = Math.max(chargedThrough, claim.offset + claim.units);

    if (ownedSpends.has(claim.spendId) && !startedClaims.has(fact.id)) orphaned = true;
  }

  // Unknown describes execution, not an invented measurement. The unchanged model retains all unanswered questions.
  return orphaned ? { ...state, remaining: Math.min(state.remaining, frame.quota - chargedThrough), unknown: true } : state;
}

function replayHalt(frame: TopicExecutionFrame, state: TopicExecutionState, fact: RewardV2Fact, row: Record<string, unknown>, facts: readonly RewardV2Fact[], source: PoolClaimSource): TopicExecutionState {
  if (state.pending !== null || fact.kind !== "feedback" || !fields(row, ["schemaVersion", "type", "reason", "claimId", "spendId", "modelHash"])
    || row.schemaVersion !== 1 || row.reason !== "topic_execution_claim_mismatch" || !identity(row.claimId) || !identity(row.spendId)
    || row.modelHash !== contentHashOf(JSON.parse(state.modelJson)) || fact.id !== `${frame.controllerId}:halted:${contentHashOf(row.spendId)}`) throw new Error("topic_execution_corrupt");

  const factClaim = facts.find(item => item.id === row.claimId && item.sequence < fact.sequence && item.scope === frame.scope);
  if (factClaim === undefined || factClaim.kind !== "learning_decision") throw new Error("topic_execution_corrupt");

  const claimed = boundClaim(frame, source, factClaim);
  if (claimed.spendId !== row.spendId) throw new Error("topic_execution_corrupt");

  // Remaining means usable by this frozen domain policy; the pool retains the exact charged accounting.
  return { ...state, remaining: 0, unknown: true };
}

function verifyReservation(frame: TopicExecutionFrame, facts: readonly RewardV2Fact[], before: number): PoolClaimSource {
  const matched = facts.find(fact => {
    if (fact.sequence >= before || fact.scope !== frame.scope || fact.kind !== "learning_decision") return false;

    const raw: unknown = JSON.parse(fact.payloadJson);
    if ((!fields(raw, ["schemaVersion", "type", "requestJson", "plan"])
      && !(fields(raw, ["schemaVersion", "type", "requestJson", "plan", "requestId"]) && identity(raw.requestId)))
      || raw.type !== "ws1_topic_reservation" || raw.schemaVersion !== 1 || typeof raw.requestJson !== "string") return false;

    if (frame.requestId !== undefined && (!("requestId" in raw) || raw.requestId !== frame.requestId)) return false;

    const parsed = allocateTopicBudget(raw.requestJson);
    if (parsed.status !== "allocated" || canonicalJson(parsed.plan) !== canonicalJson(raw.plan)) return false;

    const allocation = parsed.plan.allocations.find(row => row.domain === frame.domain);

    return parsed.plan.allocationId === frame.allocationId && allocation?.valuationId === frame.valuationId
      && allocation.bidHash === frame.bidHash && allocation.quota === frame.quota;
  });
  if (!matched) throw new Error("topic_execution_reservation_missing");

  const suffix = `:reserve:${contentHashOf(frame.allocationId)}`, key = matched.id.slice(0, -suffix.length);
  if (!matched.id.endsWith(suffix) || !/^ws1-pool:[a-f0-9]{64}$/.test(key) || !identity(matched.algorithmVersion)) throw new Error("topic_execution_corrupt");

  return { key, algorithmVersion: matched.algorithmVersion };
}

function boundClaim(frame: TopicExecutionFrame, source: PoolClaimSource, fact: RewardV2Fact) {
  const claim = readPoolClaim(JSON.parse(fact.payloadJson));
  if (fact.scope !== frame.scope || fact.kind !== "learning_decision" || fact.algorithmVersion !== source.algorithmVersion || claim === undefined
    || claim.allocationId !== frame.allocationId || claim.domain !== frame.domain || claim.valuationId !== frame.valuationId
    || claim.offset + claim.units > frame.quota
    || fact.id !== `${source.key}:claim:${contentHashOf([claim.allocationId, claim.domain, claim.spendId])}`) throw new Error("topic_execution_corrupt");
  return claim;
}

function replayStart(frame: TopicExecutionFrame, state: TopicExecutionState, fact: RewardV2Fact, row: Record<string, unknown>): TopicExecutionState {
  if (state.pending !== null || fact.kind !== "opportunity" || typeof row.expected !== "object" || row.expected === null) throw new Error("topic_execution_corrupt");

  const questionId: unknown = Reflect.get(row.expected, "questionId"), claimId: unknown = Reflect.get(row.expected, "claimId");
  if (!identity(questionId) || !identity(claimId)) throw new Error("topic_execution_corrupt");

  const model = readInformationModel(state.modelJson);
  if (!model.ok) throw new Error("topic_execution_corrupt");

  const question = model.model.questions.find(q => q.id === questionId);
  if (question === undefined || question.units > state.remaining) throw new Error("topic_execution_corrupt");

  const expected = startProbe(frame, state, question.id, question.units, claimId);
  if (!fields(row.expected, topicProbeExpectationKeys(expected.expected)) || canonicalJson(row) !== canonicalJson(expected)
    || fact.id !== executionFactId(frame, "started", expected.expected.spendId)) throw new Error("topic_execution_corrupt");

  return { ...state, remaining: state.remaining - question.units, pending: expected };
}

export function verifyStartedClaim(frame: TopicExecutionFrame, start: ProbeStarted, facts: readonly RewardV2Fact[], before: number): void {
  verifyClaim(frame, start, facts, before, verifyReservation(frame, facts, before));
}

function verifyClaim(frame: TopicExecutionFrame, start: ProbeStarted, facts: readonly RewardV2Fact[], before: number, source: PoolClaimSource): void {
  const e = start.expected, fact = facts.find(item => item.id === e.claimId && item.sequence < before);
  if (fact === undefined || fact.scope !== e.scope || fact.kind !== "learning_decision") throw new Error("topic_execution_claim_missing");
  const claim = boundClaim(frame, source, fact);
  if (claim.units !== e.units || claim.spendId !== e.spendId || claim.offset !== frame.quota - start.remainingBefore) throw new Error("topic_execution_claim_mismatch");
}

function replayResult(frame: TopicExecutionFrame, state: TopicExecutionState, fact: RewardV2Fact, row: Record<string, unknown>): TopicExecutionState {
  const pending = state.pending;
  if (pending === null || fact.kind !== "feedback" || row.spendId !== pending.expected.spendId
    || fact.id !== executionFactId(frame, "result", pending.expected.spendId) || row.schemaVersion !== 1) throw new Error("topic_execution_corrupt");

  if (row.type === "ws1_topic_probe_unknown") {
    if (!fields(row, ["schemaVersion", "type", "spendId", "reason", "receipt"]) || !identity(row.reason)) throw new Error("topic_execution_corrupt");
    if (row.receipt !== null) verifiedReceipt(row.receipt, pending.expected);
    return { ...state, unknown: true };
  }

  if (!fields(row, ["schemaVersion", "type", "spendId", "receipt", "modelAfterHash"]) || row.type !== "ws1_topic_probe_result") throw new Error("topic_execution_corrupt");

  const receipt = verifiedReceipt(row.receipt, pending.expected), update = applyTopicObservation(state.modelJson, pending.expected.questionId, receipt.outcome);
  if (update.status !== "updated" || row.modelAfterHash !== contentHashOf(update.model)) throw new Error("topic_execution_corrupt");

  return { ...state, modelJson: update.modelJson, applied: state.applied + 1, pending: null };
}

function verifiedReceipt(raw: unknown, expected: TopicProbeExpectation): TopicProbeReceipt {
  if (typeof raw !== "object" || raw === null || !("receiptRef" in raw) || typeof raw.receiptRef !== "string") throw new Error("topic_execution_corrupt");
  const receipt = readTopicProbeReceipt(canonicalJson(raw), raw.receiptRef, expected);
  if (receipt === undefined) throw new Error("topic_execution_corrupt");
  return receipt;
}
