import type { ReadRoutingConditions } from "../../../../../../ports/read-routing.js";
import type { BoardState } from "../../../../../control/state.js";
import type { RewardRecords } from "../../../../../reward/contracts.js";
import type { EmpiricalTopicPolicy, TopicPairedMeasurement } from "../../../../../domains/shared/topics/empirical-model.js";
import { canonicalJson, contentHashOf } from "../../../../../control/hash.js";
import { rewardRecordsOf } from "../../../../../control/reward-records.js";
import { predictionsFor, rewardView } from "../../../../../reward/algorithm.js";
import { learnReadStrategy, readStrategyEnvironment, selectReadStrategy, type ReadStrategyPolicy, type ReadStrategyRule } from "../domain/index.js";
import { readStrategyInputs } from "../domain/observations.js";
import { latestReadStrategyAsset, readStrategyBoard, readStrategyPolicyOf } from "../runtime/archive.js";
import { readStrategyConditions, readStrategyCheck, readStrategyExecution } from "../runtime/sensor.js";
import { fields, identity, sequence } from "../../../../../../validation/json-shape.js";
import { READ_TOPIC_OBJECTIVE, readPairUtility, readPairStudyCost } from "./read-objective.js";
import type { TopicComparisonSummary } from "../../../../../../integration/learning-topics/experiment-port.js";

export type ReadTopicDecisionInput = {
  readonly questionId: string;
  readonly boardSequence: number;
  readonly measurements: readonly TopicPairedMeasurement[];
  readonly signal: AbortSignal;
};

export type ReadTopicDecisionResult =
  | { readonly status: "ready"; readonly currentAction: 0 | 1;
      readonly projections: readonly { readonly measurementId: string; readonly nextAction: 0 | 1 }[];
      readonly provenanceJson: string; readonly basisHash: string }
  | { readonly status: "unmodelled"; readonly reason: string };

type Measured = Extract<TopicPairedMeasurement, { kind: "measured" }>;

type ScenarioArm = { readonly path: "whole" | "stream"; readonly quality: "pass" | "fail";
  readonly bytesRead: number; readonly latencyMs: number; readonly totalBytesRead: number; readonly totalLatencyMs: number; readonly proofRef: string };

type Scenario = { readonly conditions: ReadRoutingConditions; readonly arms: readonly ScenarioArm[] };

type ScenarioProvenance = { readonly value: object; readonly opportunity: object;
  readonly conditions: ReadRoutingConditions; readonly arms: readonly unknown[] };

type PolicyBasis = { readonly present: boolean; readonly valid: boolean; readonly rule: ReadStrategyRule | null };

type ReadDecisionBasis = { readonly basisHash: string; readonly state: BoardState; readonly policy: PolicyBasis };

const actionOf = (path: "whole" | "stream"): 0 | 1 => path === "whole" ? 0 : 1;

function currentPolicy(state: BoardState, scope: string): ReadStrategyPolicy | undefined {
  const asset = latestReadStrategyAsset(state, scope), policy = readStrategyPolicyOf(asset);
  if (asset !== undefined && (policy === undefined || asset.schemaVersion !== 2 || asset.contentHash !== contentHashOf(asset.content))) return undefined;
  return policy;
}

function selectAction(policy: ReadStrategyPolicy | undefined, records: RewardRecords, scope: string, conditions: ReadRoutingConditions): 0 | 1 {
  const selected = selectReadStrategy(policy, { scope, conditions: readStrategyConditions(conditions) }, records);
  return actionOf(selected.path ?? (conditions.streaming ? "stream" : "whole"));
}

export function readSelectedAction(state: BoardState, scope: string, conditions: ReadRoutingConditions): 0 | 1 {
  return selectAction(currentPolicy(state, scope), rewardRecordsOf(state), scope, conditions);
}

function policyBasis(state: BoardState, scope: string, conditions: ReadRoutingConditions,
  replacement?: ReadStrategyPolicy): PolicyBasis {
  const asset = latestReadStrategyAsset(state, scope), policy = replacement ?? currentPolicy(state, scope);
  const niche = readStrategyEnvironment(readStrategyConditions(conditions));
  return { present: replacement !== undefined || asset !== undefined, valid: policy !== undefined,
    rule: policy?.rules.find(rule => readStrategyEnvironment(rule.conditions) === niche) ?? null };
}

function nicheRecords(state: BoardState, scope: string, conditions: ReadRoutingConditions,
  ignoredExecutions: ReadonlySet<string> = new Set()): RewardRecords {
  const records = rewardRecordsOf(state), niche = readStrategyEnvironment(readStrategyConditions(conditions));
  const ids = new Set(readStrategyInputs(records, scope).filter(item => readStrategyEnvironment(item.conditions) === niche
    && !ignoredExecutions.has(item.exposure.source.eventId)).map(item => item.exposure.id));
  return { exposures: records.exposures.filter(row => ids.has(row.id)).sort((a, b) => a.id.localeCompare(b.id)),
    feedbacks: records.feedbacks.filter(row => ids.has(row.exposureId)).sort((a, b) => a.id.localeCompare(b.id)) };
}

function basisHash(state: BoardState, scope: string, conditions: ReadRoutingConditions,
  policy = policyBasis(state, scope, conditions), ignoredExecutions?: ReadonlySet<string>): string {
  return contentHashOf({ schemaVersion: 1, kind: "read-routing-domain-basis-v1", scope,
    conditions: readStrategyConditions(conditions), policy, records: nicheRecords(state, scope, conditions, ignoredExecutions) });
}

function readScenarioProvenance(row: Measured): ScenarioProvenance | undefined {
  if (row.utilityUnit !== READ_TOPIC_OBJECTIVE.utilityUnit || row.provenanceJson === undefined
    || row.provenanceJson.length > 65536 || !row.sourceRef.startsWith("checker:")) return undefined;

  const raw: unknown = JSON.parse(row.provenanceJson);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw) || contentHashOf(raw) !== row.sourceRef.slice("checker:".length)
    || (row.provenanceHash !== undefined && row.provenanceHash !== contentHashOf(raw))
    || Reflect.get(raw, "checkerVersion") !== READ_TOPIC_OBJECTIVE.checkerVersion
    || Reflect.get(raw, "executionVersion") !== READ_TOPIC_OBJECTIVE.executionVersion) return undefined;

  const opportunity: unknown = Reflect.get(raw, "opportunity"), arms: unknown = Reflect.get(raw, "arms");
  if (typeof opportunity !== "object" || opportunity === null || Array.isArray(opportunity) || !Array.isArray(arms) || arms.length !== 2) return undefined;

  const original: unknown = Reflect.get(opportunity, "conditions");
  if (typeof original !== "object" || original === null) return undefined;

  return { value: raw, opportunity, conditions: original as ReadRoutingConditions, arms };
}

function scenarioOf(row: Measured, provenance: ScenarioProvenance, conditions: ReadRoutingConditions): Scenario | undefined {
  const { conditions: originalConditions, arms } = provenance;

  if (readStrategyEnvironment(readStrategyConditions(originalConditions)) !== readStrategyEnvironment(readStrategyConditions(conditions))) return undefined;

  const parsed: ScenarioArm[] = [];
  let utilityDifference = 0, cost = 0, totalBytes = 0;

  for (const [index, path] of (["whole", "stream"] as const).entries()) {
    const arm: unknown = arms[index];
    if (typeof arm !== "object" || arm === null || Reflect.get(arm, "path") !== path || Reflect.get(arm, "error") !== undefined) return undefined;

    const result: unknown = Reflect.get(arm, "result"), routing: unknown = Reflect.get(arm, "routing");
    if (typeof result !== "object" || result === null || typeof routing !== "object" || routing === null
      || Reflect.get(routing, "state") !== "confirmed" || Reflect.get(result, "path") !== path || Reflect.get(result, "executed") !== true) return undefined;

    const quality: unknown = Reflect.get(result, "quality"), bytesRead: unknown = Reflect.get(result, "bytesRead"),
      latencyMs: unknown = Reflect.get(result, "latencyMs"), totalBytesRead: unknown = Reflect.get(result, "totalBytesRead"),
      totalLatencyMs: unknown = Reflect.get(result, "totalLatencyMs"), proofRef: unknown = Reflect.get(result, "proofRef");
    if ((quality !== "pass" && quality !== "fail") || !sequence(bytesRead) || bytesRead > READ_TOPIC_OBJECTIVE.maximumCandidateBytes || !sequence(totalBytesRead)
      || totalBytesRead < bytesRead || typeof latencyMs !== "number" || !Number.isFinite(latencyMs) || latencyMs < 0
      || typeof totalLatencyMs !== "number" || !Number.isFinite(totalLatencyMs) || totalLatencyMs < latencyMs
      || typeof proofRef !== "string" || !/^routing-read-check:[a-f0-9]{64}$/.test(proofRef)) return undefined;

    const utility = readPairUtility(quality, bytesRead, latencyMs);
    if (utility !== (path === "whole" ? row.baselineUtility : row.candidateUtility)) return undefined;

    utilityDifference += (path === "whole" ? -1 : 1) * utility;
    cost += readPairStudyCost(totalBytesRead, totalLatencyMs);
    totalBytes += totalBytesRead;
    parsed.push(Object.freeze({ path, quality, bytesRead, latencyMs, totalBytesRead, totalLatencyMs, proofRef }));
  }

  if (!Number.isFinite(cost) || cost !== row.fullStudyCost || totalBytes > READ_TOPIC_OBJECTIVE.maximumPairBytes
    || utilityDifference !== row.candidateUtility - row.baselineUtility) return undefined;

  return Object.freeze({ conditions: Object.freeze({ ...originalConditions }), arms: Object.freeze(parsed) });
}

export function readScenarioOf(row: Measured, conditions: ReadRoutingConditions): Scenario | undefined {
  const provenance = readScenarioProvenance(row);
  return provenance === undefined ? undefined : scenarioOf(row, provenance, conditions);
}

/** Pure counterfactual prefix only. These derived exposure/check objects are never written. */
function project(state: BoardState, scope: string, questionId: string, measurement: Measured,
  scenario: Scenario, conditions: ReadRoutingConditions): 0 | 1 | undefined {
  const base = rewardRecordsOf(state), exposures = [...base.exposures], feedbacks = [...base.feedbacks];
  let timestamp = Math.max(0, ...exposures.map(row => row.occurredAt), ...feedbacks.map(row => row.observedAt)) + 1;
  if (!Number.isSafeInteger(timestamp) || timestamp > 8640000000000000 - 8 || state.sequence > Number.MAX_SAFE_INTEGER - 8) return undefined;

  const virtual = `read-topic-projection:${contentHashOf([scope, state.sequence, questionId, measurement.id])}`;

  for (const arm of scenario.arms) {
    const executionId = `${virtual}:${arm.path}`;
    const facts = readStrategyExecution({ scope, sessionId: virtual, turnId: virtual, nowMs: timestamp++,
      record: { executionId, conditions: scenario.conditions, decision: { path: arm.path, reason: "bounded_read_comparison" },
        actualPath: arm.path, outcome: arm.quality === "pass" ? "completed" : "failed", bytesRead: arm.bytesRead, latencyMs: arm.latencyMs } });
    const predictions = predictionsFor(rewardView({ exposures, feedbacks }), facts.exposure.context, facts.exposure.targets);

    exposures.push({ ...facts.exposure, predictions });
    feedbacks.push(facts.feedback);
    feedbacks.push(readStrategyCheck({ exposures, feedbacks }, { executionId, feedbackId: `${executionId}:checked`,
      passed: arm.quality === "pass", proofRef: arm.proofRef }, facts.exposure.id, timestamp++));
  }

  const records = { exposures, feedbacks };
  const learned = learnReadStrategy({ ...state, sequence: state.sequence + 6, rewardExposures: exposures, rewardFeedbacks: feedbacks },
    { domain: "tool", scope, requestId: virtual, issuedAt: new Date(timestamp).toISOString(), budget: { maxObservations: 4096 } });
  if (learned.status !== "learned" && learned.status !== "waiting_evidence") return undefined;

  return selectAction(learned.policy ?? currentPolicy(state, scope), records, scope, conditions);
}

/** Actual adopted routing policy and exact replay of each supported observed pair. No new sampling. */
export function createReadTopicDecisionPolicy(options: { readonly boardRoot: string; readonly scope: string;
  readonly policy: EmpiricalTopicPolicy; readonly enabled: () => boolean;
  readonly conditionHash?: (conditions: ReadRoutingConditions) => string;
  readonly conditions: () => ReadRoutingConditions | undefined }) {
  /** Describes this persisted comparison only; the opportunity hash makes no content-identity claim. */
  function describeComparison(row: TopicPairedMeasurement): TopicComparisonSummary | undefined {
    if (!options.enabled() || row.kind !== "measured" || !identity(row.id) || row.scope !== options.scope || row.scope !== options.policy.scope
      || row.experimentRef !== options.policy.experimentRef || row.experimentVersion !== options.policy.experimentVersion
      || row.utilityUnit !== options.policy.utilityUnit || row.utilityUnit !== READ_TOPIC_OBJECTIVE.utilityUnit) return undefined;
    try {
      const provenance = readScenarioProvenance(row);
      if (provenance === undefined) return undefined;

      const { value, opportunity, conditions } = provenance;

      if (!fields(conditions, ["fileBytes", "range", "streaming"]) || !sequence(conditions.fileBytes)
        || conditions.range !== "bounded" || conditions.streaming !== true) return undefined;

      const executionId: unknown = Reflect.get(opportunity, "executionId"), requiredBytes: unknown = Reflect.get(opportunity, "requiredBytesPerTrial");
      const conditionHash = options.conditionHash?.(conditions) ?? options.policy.conditionHash;
      const order: unknown = Reflect.get(value, "order"), definition: unknown = Reflect.get(value, "costDefinition");
      if (!identity(executionId) || !sequence(requiredBytes) || requiredBytes === 0 || requiredBytes * 2 > READ_TOPIC_OBJECTIVE.maximumPairBytes
        || conditions.range !== "bounded" || !conditions.streaming || conditions.fileBytes > READ_TOPIC_OBJECTIVE.maximumCandidateBytes
        || row.conditionHash !== conditionHash || Reflect.get(value, "conditionHash") !== conditionHash || Reflect.get(value, "schemaVersion") !== 1
        || Reflect.get(value, "checkerVersion") !== READ_TOPIC_OBJECTIVE.checkerVersion || Reflect.get(value, "executionVersion") !== READ_TOPIC_OBJECTIVE.executionVersion
        || Reflect.get(value, "reason") !== undefined || !Array.isArray(order) || order.length !== 2 || order[0] !== "whole" || order[1] !== "stream"
        || typeof definition !== "object" || definition === null || Reflect.get(definition, "utilityUnit") !== row.utilityUnit
        || Reflect.get(definition, "maximumPairBytes") !== READ_TOPIC_OBJECTIVE.maximumPairBytes
        || Reflect.get(definition, "maximumCandidateBytes") !== READ_TOPIC_OBJECTIVE.maximumCandidateBytes) return undefined;

      const scenario = scenarioOf(row, provenance, conditions);
      if (scenario === undefined || scenario.arms.some(arm => arm.totalBytesRead > requiredBytes)) return undefined;

      const executionIds = provenance.arms.map(arm => {
        const routing: unknown = typeof arm === "object" && arm !== null ? Reflect.get(arm, "routing") : undefined;
        return typeof routing === "object" && routing !== null ? Reflect.get(routing, "executionId") : undefined;
      });
      if (executionIds.some(id => typeof id !== "string" || !/^read-topic-trial:[a-f0-9]{64}$/.test(id))
        || new Set(executionIds).size !== 2) return undefined;

      const armSummary = (arm: ScenarioArm) => Object.freeze({ id: arm.path, checked: arm.quality,
        candidateCost: -readPairUtility(arm.quality, arm.bytesRead, arm.latencyMs),
        studyCost: readPairStudyCost(arm.totalBytesRead, arm.totalLatencyMs) });

      return Object.freeze({ schemaVersion: 2 as const, comparisonRef: row.id, case: Object.freeze({ kind: "read_opportunity" as const, ref: contentHashOf(executionId) }),
        costUnit: "io_cost" as const, arms: Object.freeze([armSummary(scenario.arms[0]!), armSummary(scenario.arms[1]!)] as const) });
    } catch { return undefined; }
  }

  async function readBasis(conditions: ReadRoutingConditions, signal: AbortSignal): Promise<ReadDecisionBasis | undefined> {
    if (!options.enabled() || signal.aborted) return undefined;
    const state = await readStrategyBoard(options.boardRoot);
    if (!options.enabled() || signal.aborted) return undefined;
    const policy = policyBasis(state, options.scope, conditions);
    return { state, policy, basisHash: basisHash(state, options.scope, conditions, policy) };
  }

  async function finishPair(initial: ReadDecisionBasis, conditions: ReadRoutingConditions, requestId: string,
    executionIds: readonly string[], signal: AbortSignal): Promise<{ readonly action: 0 | 1; readonly decisionBasisHash: string } | undefined> {
    if (!options.enabled() || signal.aborted || executionIds.length !== 2 || new Set(executionIds).size !== 2) return undefined;

    const state = await readStrategyBoard(options.boardRoot);

    if (!options.enabled() || signal.aborted) return undefined;

    const ignored = new Set(executionIds), before = rewardRecordsOf(initial.state), after = rewardRecordsOf(state);
    if (before.exposures.some(row => ignored.has(row.source.eventId))) return undefined;

    // Only the automatic result and this pair's confirmation may be removed from the comparison.
    const own = after.exposures.filter(row => row.context.scope === options.scope && ignored.has(row.source.eventId));
    if (own.length !== 2 || own.some(row => after.feedbacks.filter(feedback => feedback.exposureId === row.id)
      .some(feedback => feedback.id !== `${row.id}:result` && feedback.id !== `${row.source.eventId}:checked`))) return undefined;

    if (basisHash(state, options.scope, conditions, initial.policy, ignored) !== initial.basisHash) return undefined;

    const ids = new Set(own.map(row => row.id));
    const projectedState = { ...initial.state,
      rewardExposures: [...before.exposures, ...own],
      rewardFeedbacks: [...before.feedbacks, ...after.feedbacks.filter(row => ids.has(row.exposureId))] };
    const learned = learnReadStrategy(projectedState, { domain: "tool", scope: options.scope, requestId,
      issuedAt: "1970-01-01T00:00:00.000Z", budget: { maxObservations: 4096 } });
    if (learned.status !== "learned" && learned.status !== "waiting_evidence") return undefined;

    const expectedPolicy = learned.policy === undefined ? initial.policy : policyBasis(initial.state, options.scope, conditions, learned.policy);
    if (canonicalJson(policyBasis(state, options.scope, conditions)) !== canonicalJson(expectedPolicy)) return undefined;

    return { action: selectAction(currentPolicy(state, options.scope), after, options.scope, conditions), decisionBasisHash: initial.basisHash };
  }

  async function decisionPolicy(input: ReadTopicDecisionInput): Promise<ReadTopicDecisionResult> {
    const unavailable = (reason: string): ReadTopicDecisionResult => ({ status: "unmodelled", reason });

    if (!options.enabled() || input.signal.aborted || !identity(input.questionId) || !sequence(input.boardSequence)
      || !Array.isArray(input.measurements) || input.measurements.length > 512) return unavailable("read_topic_decision_unavailable");

    const conditions = options.conditions();
    if (conditions === undefined) return unavailable("read_topic_opportunity_unavailable");

    try {
      const state = await readStrategyBoard(options.boardRoot);

      if (!options.enabled() || input.signal.aborted) return unavailable("read_topic_decision_stopped");

      if (state.sequence !== input.boardSequence) return unavailable("read_topic_decision_stale");

      const currentCondition = options.conditionHash?.(conditions) ?? options.policy.conditionHash;
      const policy = { ...options.policy, conditionHash: currentCondition }, relevant = input.measurements.filter(row => row.sequence <= input.boardSequence
        && row.scope === policy.scope && row.experimentRef === policy.experimentRef && row.experimentVersion === policy.experimentVersion
        && row.conditionHash === policy.conditionHash && row.utilityUnit === policy.utilityUnit);
      const superseded = new Set(relevant.flatMap(row => row.supersedes === undefined ? [] : [row.supersedes]));
      const support = relevant.filter(row => !superseded.has(row.id));
      if (support.length === 0 || support.some(row => row.kind !== "measured")) return unavailable("read_topic_decision_support");

      const projections: { readonly measurementId: string; readonly nextAction: 0 | 1 }[] = [];

      for (const row of support) {
        if (row.kind !== "measured") return unavailable("read_topic_decision_support");
        const scenario = readScenarioOf(row, conditions);
        if (scenario === undefined) return unavailable("read_topic_decision_scenario");
        const nextAction = project(state, options.scope, input.questionId, row, scenario, conditions);
        if (nextAction === undefined) return unavailable("read_topic_decision_projection");
        projections.push(Object.freeze({ measurementId: row.id, nextAction }));
      }

      const records = rewardRecordsOf(state), currentAction = selectAction(currentPolicy(state, options.scope), records, options.scope, conditions);

      if (!options.enabled() || input.signal.aborted) return unavailable("read_topic_decision_stopped");

      const domainBasisHash = basisHash(state, options.scope, conditions);

      return Object.freeze({ status: "ready", currentAction, projections: Object.freeze(projections), basisHash: domainBasisHash,
        provenanceJson: canonicalJson({ schemaVersion: 1, kind: "read-routing-actual-learner-replay-v1", boardSequence: state.sequence,
          conditions: readStrategyConditions(conditions), basisHash: domainBasisHash,
          recordsHash: contentHashOf(nicheRecords(state, options.scope, conditions)), assetVersion: latestReadStrategyAsset(state, options.scope)?.versionId ?? null,
          supportHash: contentHashOf(support), currentAction, projections,
          assumptions: ["Observed exact pairs are counterfactual representatives only within the declared coarse condition",
            "Only empirically supported utility/next-action classes are represented; unseen outcomes remain outside this model",
            "Original routing cost includes bytes and milliseconds; decision replay does not replace that learner objective"] }) });
    } catch { return unavailable("read_topic_decision_unavailable"); }
  }

  return Object.freeze({ decisionPolicy, readBasis, finishPair, describeComparison });
}
