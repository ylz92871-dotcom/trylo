import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import type { RewardV2Fact } from "../../learning/reward/v2-facts.js";
import { pairedUtilityOutcome, type TopicPairedMeasurement, type EmpiricalTopicPolicy } from "../../learning/domains/shared/topics/empirical-model.js";
import type { GroundedLearningTopic, TopicExperimentDescriptor } from "../../learning/domains/shared/topics/contracts.js";
import type { TopicComparisonSummary } from "./comparison-evidence.js";
import { readTopicExperimentBindingRecord, freezeTopicExperimentBindingRecord, topicExperimentBindingHash, resolvedTopicExperiment,
  type TopicExperimentBindingRecord } from "../../learning/domains/shared/topics/experiment-binding.js";
import { fields, identity, sequence } from "../../validation/json-shape.js";
import { createRewardV2BoardPort } from "../reward/v2-board-port.js";
import type { TopicProbeExpectation, TopicProbePort, TopicCalibrationExpectation } from "./execution-contract.js";

export type TopicPairedOutcome = Pick<EmpiricalTopicPolicy, "scope" | "experimentRef" | "experimentVersion" | "conditionHash" | "utilityUnit">
  & { readonly measurementId: string; readonly sourceRef: string; readonly supersedes?: string;
      readonly provenanceJson?: string; readonly deploymentAction?: number; readonly decisionBasisHash?: string } & (
  | { readonly kind: "measured"; readonly baselineUtility: number; readonly candidateUtility: number; readonly fullStudyCost: number }
  | { readonly kind: "unknown"; readonly reason: string }
);

/** Host-owned ports read actual checks. Model-written numbers cannot implement this authority. */
export type TopicPairedProbe = {
  /** Pure projection of an already checked immutable pair; never invokes a source, trial or checker. */
  describeComparison?(measurement: TopicPairedMeasurement): TopicComparisonSummary | undefined;
  run(input: { readonly purpose: "question"; readonly expected: TopicProbeExpectation;
      readonly topic: GroundedLearningTopic; readonly experimentBinding?: TopicExperimentBindingRecord; readonly signal: AbortSignal }
    | { readonly purpose: "calibration"; readonly expected: TopicCalibrationExpectation; readonly signal: AbortSignal }): Promise<string>;
  read(ref: string, expected: TopicProbeExpectation | TopicCalibrationExpectation, signal: AbortSignal): Promise<TopicPairedOutcome | undefined>;
  readFeedback?(ref: string, signal: AbortSignal): Promise<TopicPairedOutcome | undefined>;
  readFeedbackBatch?(refs: readonly string[], signal: AbortSignal): Promise<readonly TopicPairedOutcome[]>;
};

const SOURCE_VERSION = "ws1-paired-measurement-v1";

type Stored = Omit<Extract<TopicPairedMeasurement, { kind: "measured" }>, "sequence">
  | Omit<Extract<TopicPairedMeasurement, { kind: "unknown" }>, "sequence">;

export type TopicDecisionBinding = {
  readonly outcomes: readonly { readonly utilityClass: number; readonly deploymentAction: number }[];
  readonly basisHash?: string;
};

type FrozenDecision = TopicDecisionBinding & { readonly hash: string };

const BASE = ["id", "scope", "experimentRef", "experimentVersion", "conditionHash", "utilityUnit", "sourceRef", "kind"];

/** The original v2 question keeps its owner and identity; only its durable relation names an execution owner. */
export function matchesPairedTopicExperiment(input: Extract<Parameters<TopicPairedProbe["run"]>[0], { purpose: "question" }>,
  descriptor: Pick<TopicExperimentDescriptor, "ref" | "version" | "domain">, conditionHash: string): boolean {
  const { topic, expected } = input;

  if (topic.scope !== expected.scope || topic.topicId !== expected.questionId || expected.domain !== descriptor.domain) return false;

  const record = input.experimentBinding === undefined ? undefined : readTopicExperimentBindingRecord(input.experimentBinding);
  if (input.experimentBinding !== undefined && record === undefined) return false;

  const experiment = resolvedTopicExperiment(topic, record);

  return experiment !== undefined && experiment.domain === descriptor.domain && experiment.ref === descriptor.ref && experiment.version === descriptor.version
    && (experiment.conditionHash === undefined || experiment.conditionHash === conditionHash)
    && expected.experimentBindingHash === (record === undefined ? undefined : topicExperimentBindingHash(record));
}

export function topicMeasurements(facts: readonly RewardV2Fact[], scope: string): TopicPairedMeasurement[] {
  const result: TopicPairedMeasurement[] = [];

  for (const fact of facts) {
    if (fact.scope !== scope || fact.kind !== "feedback" || fact.algorithmVersion !== SOURCE_VERSION) continue;
    const raw: unknown = JSON.parse(fact.payloadJson);
    if (!fields(raw, ["schemaVersion", "type", "measurement", "observationBinding"]) || raw.schemaVersion !== 1 || raw.type !== "ws1_paired_measurement"
      || (raw.observationBinding !== null && (typeof raw.observationBinding !== "string" || !/^[a-f0-9]{64}$/.test(raw.observationBinding)))
      || !isStored(raw.measurement) || raw.measurement.scope !== scope || raw.measurement.id !== fact.id) throw new Error("topic_measurement_corrupt");
    result.push({ ...raw.measurement, sequence: fact.sequence });
  }

  return result;
}

export function createTopicMeasurementSource(options: {
  readonly boardRoot: string; readonly enabled: () => boolean; readonly policy: EmpiricalTopicPolicy;
  readonly probe: TopicPairedProbe;
}) {
  const { policy, enabled } = options, board = createRewardV2BoardPort(options.boardRoot, enabled);
  const run = options.probe.run.bind(options.probe), read = options.probe.read.bind(options.probe);
  const feedback = options.probe.readFeedback?.bind(options.probe);
  const feedbackBatch = options.probe.readFeedbackBatch?.bind(options.probe);
  const live = new Map<string, { readonly original: string; readonly expected: string; readonly decisionHash?: string; receipt?: string }>();
  const measurementId = (id: string) => `topic-measure:${contentHashOf([policy.scope, policy.experimentRef, policy.experimentVersion, policy.conditionHash, id])}`;

  // Admit checked outcomes only when their experiment and condition match this frozen policy.
  async function save(outcome: TopicPairedOutcome, signal: AbortSignal, expected?: TopicProbeExpectation | TopicCalibrationExpectation): Promise<Stored> {
    if (!enabled() || signal.aborted || !validOutcome(outcome)
      || ["scope", "experimentRef", "experimentVersion", "conditionHash", "utilityUnit"].some(key => Reflect.get(outcome, key) !== Reflect.get(policy, key))) {
      throw new Error("topic_measurement_unavailable");
    }

    const measurement: Stored = { id: measurementId(outcome.measurementId), scope: policy.scope,
      experimentRef: policy.experimentRef, experimentVersion: policy.experimentVersion, conditionHash: policy.conditionHash,
      utilityUnit: policy.utilityUnit, sourceRef: outcome.sourceRef,
      ...(outcome.provenanceJson === undefined ? {} : { provenanceJson: canonicalJson(JSON.parse(outcome.provenanceJson)),
        provenanceHash: contentHashOf(JSON.parse(outcome.provenanceJson)) }),
      ...(outcome.supersedes === undefined ? {} : { supersedes: measurementId(outcome.supersedes) }),
      ...(outcome.deploymentAction === undefined ? {} : { deploymentAction: outcome.deploymentAction }),
      ...(outcome.decisionBasisHash === undefined ? {} : { decisionBasisHash: outcome.decisionBasisHash }),
      ...(outcome.kind === "measured" ? { kind: "measured" as const, baselineUtility: outcome.baselineUtility,
        candidateUtility: outcome.candidateUtility, fullStudyCost: outcome.fullStudyCost }
        : { kind: "unknown" as const, reason: outcome.reason }) };
    const view = await board.read();
    const observationBinding = expected === undefined ? null : contentHashOf(expected);
    const previous = view.facts.find(row => row.id === measurement.id);
    if (previous !== undefined) {
      const raw: unknown = JSON.parse(previous.payloadJson);
      if (!fields(raw, ["schemaVersion", "type", "measurement", "observationBinding"]) || raw.type !== "ws1_paired_measurement"
        || canonicalJson(raw.measurement) !== canonicalJson(measurement)
        || (expected !== undefined && raw.observationBinding !== observationBinding)) throw new Error("topic_measurement_reused");
      return measurement;
    }

    if (!enabled() || signal.aborted) throw new Error("topic_measurement_stopped");

    const written = await board.append(view.revision, { id: measurement.id, scope: policy.scope, algorithmVersion: SOURCE_VERSION,
      kind: "feedback", payloadJson: canonicalJson({ schemaVersion: 1, type: "ws1_paired_measurement", measurement, observationBinding }) });
    if (written.status === "stale") throw new Error("topic_measurement_stale");

    return measurement;
  }

  async function start(input: Parameters<TopicPairedProbe["run"]>[0], decision?: FrozenDecision) {
      if (!enabled() || input.signal.aborted || live.size >= 64) throw new Error("topic_measurement_stopped");

      const original = await run(input);
      if (!identity(original)) throw new Error("topic_measurement_reference");

      const expected = input.expected, ref = `topic-pair:${contentHashOf(decision === undefined
        ? [expected, original] : [expected, original, decision.hash])}`;
      if (live.has(ref)) throw new Error("topic_measurement_replayed");

      live.set(ref, { original, expected: canonicalJson(expected), ...(decision === undefined ? {} : { decisionHash: decision.hash }) });
      return ref;
  }

  async function observation(ref: string, expected: TopicProbeExpectation | TopicCalibrationExpectation, signal: AbortSignal, decision?: FrozenDecision) {
      const pending = live.get(ref);
      if (pending === undefined || pending.expected !== canonicalJson(expected) || pending.decisionHash !== decision?.hash
        || !enabled() || signal.aborted) throw new Error("topic_measurement_binding");

      if (pending.receipt !== undefined) return pending.receipt;

      const actual = await read(pending.original, expected, signal);
      if (actual === undefined) throw new Error("topic_measurement_unknown");

      const measurement = await save(actual, signal, expected);
      if (measurement.kind !== "measured") throw new Error("topic_measurement_unknown");

      const delta = measurement.candidateUtility - measurement.baselineUtility;
      if (delta < policy.deltaBounds.minimum || delta > policy.deltaBounds.maximum) throw new Error("topic_measurement_out_of_model");

      const utilityClass = pairedUtilityOutcome(policy, delta);
      const outcome = decision === undefined ? utilityClass : decision.outcomes.findIndex(cell =>
        cell.utilityClass === utilityClass && cell.deploymentAction === measurement.deploymentAction);
      if (outcome < 0 || (decision?.basisHash !== undefined && measurement.decisionBasisHash !== decision.basisHash)) {
        throw new Error("topic_measurement_out_of_model");
      }

      const receipt = { ...expected, schemaVersion: 1, receiptRef: ref, sourceRef: measurement.sourceRef,
        measurementHash: contentHashOf(measurement), outcome };

      pending.receipt = canonicalJson(receipt);
      return pending.receipt;
  }

  function forTopic(input: Parameters<TopicProbePort["run"]>[0], decision?: FrozenDecision) {
    const expected = expectationOf(input);
    if (expected.scope !== policy.scope || input.topic.scope !== policy.scope || input.topic.topicId !== expected.questionId) return Promise.reject(new Error("topic_measurement_experiment_binding"));

    const rawBinding = input.experimentBinding;
    const experimentBinding = rawBinding === undefined ? undefined : readTopicExperimentBindingRecord(rawBinding);
    if (rawBinding !== undefined && experimentBinding === undefined) return Promise.reject(new Error("topic_measurement_experiment_binding"));

    const question = { purpose: "question" as const, expected, topic: input.topic, signal: input.signal,
      ...(experimentBinding === undefined ? {} : { experimentBinding: freezeTopicExperimentBindingRecord(experimentBinding) }) };
    const legacySameOwner = input.topic.schemaVersion === 2 && rawBinding === undefined && expected.experimentBindingHash === undefined && input.topic.domain === expected.domain;
    if (!legacySameOwner && (input.topic.schemaVersion === 2 || input.topic.schemaVersion === 3) && !matchesPairedTopicExperiment(question,
      { domain: expected.domain, ref: policy.experimentRef, version: policy.experimentVersion }, policy.conditionHash)) {
      return Promise.reject(new Error("topic_measurement_experiment_binding"));
    }

    if (input.topic.schemaVersion === 1 && (rawBinding !== undefined || expected.experimentBindingHash !== undefined)) return Promise.reject(new Error("topic_measurement_experiment_binding"));

    return start(question, decision);
  }

  const port: TopicProbePort = {
    run: input => forTopic(input),
    readObservation: observation,
  };

  return { port, calibration: {
    run: (expected: TopicCalibrationExpectation, signal: AbortSignal) => start({ purpose: "calibration", expected, signal }),
    readObservation: observation,
  },

    bindDecision(binding: TopicDecisionBinding): TopicProbePort {
      const decision = freezeDecision(binding);
      return {
        run: input => input.decisionBasisHash !== decision.basisHash ? Promise.reject(new Error("topic_measurement_binding"))
          : forTopic(input, decision),
        readObservation: (ref, expected, signal) => observation(ref, expected, signal, decision),
      };
    },

    /** Re-read existing checks once per niche before a new valuation, without running another experiment. */
    async refreshFeedback(refs: readonly string[], signal: AbortSignal) {
      if (!enabled() || signal.aborted) return { status: "disabled" as const, recorded: 0 };

      if (feedbackBatch === undefined) return { status: "unbound" as const, recorded: 0 };

      if (refs.length > 512 || !refs.every(identity) || new Set(refs).size !== refs.length) throw new Error("topic_feedback_references");

      if (refs.length === 0) return { status: "recorded" as const, recorded: 0 };

      const outcomes = await feedbackBatch(Object.freeze([...refs]), signal);
      if (!Array.isArray(outcomes) || outcomes.length > refs.length
        || new Set(outcomes.map(row => row.measurementId)).size !== outcomes.length) throw new Error("topic_feedback_batch");

      let recorded = 0;

      for (const outcome of outcomes) {
        await save(outcome, signal);
        recorded += 1;
      }

      return { status: "recorded" as const, recorded };
    },

    async recordFeedback(ref: string, signal: AbortSignal) {
      if (!enabled() || signal.aborted) return { status: "disabled" as const };
      if (feedback === undefined || !identity(ref)) return { status: "unbound" as const };
      const actual = await feedback(ref, signal);
      if (actual === undefined) return { status: "unknown" as const };
      const measurement = await save(actual, signal);
      return { status: "recorded" as const, measurementId: measurement.id, kind: measurement.kind };
    } };
}

function expectationOf(input: TopicProbeExpectation): TopicProbeExpectation {
  return { scope: input.scope, domain: input.domain, allocationId: input.allocationId, valuationId: input.valuationId,
    questionId: input.questionId, modelHash: input.modelHash, units: input.units, spendId: input.spendId, claimId: input.claimId,
    checkerVersion: input.checkerVersion, executionVersion: input.executionVersion,
    ...(input.decisionBasisHash === undefined ? {} : { decisionBasisHash: input.decisionBasisHash }),
    ...(input.experimentBindingHash === undefined ? {} : { experimentBindingHash: input.experimentBindingHash }) };
}

function validOutcome(value: TopicPairedOutcome): boolean {
  return value !== null && typeof value === "object" && identity(value.measurementId) && identity(value.sourceRef)
    && [value.scope, value.experimentRef, value.experimentVersion, value.utilityUnit].every(identity)
    && typeof value.conditionHash === "string" && /^[a-f0-9]{64}$/.test(value.conditionHash)
    && validProvenance(value.provenanceJson)
    && validDecisionMetadata(value.deploymentAction, value.decisionBasisHash)
    && /^(checker|execution):/.test(value.sourceRef) && (value.supersedes === undefined || identity(value.supersedes))
    && (value.kind === "measured" ? [value.baselineUtility, value.candidateUtility, value.fullStudyCost].every(Number.isFinite) && value.fullStudyCost >= 0
      : value.kind === "unknown" && identity(value.reason));
}

function isStored(value: unknown): value is Stored {
  if (value === null || typeof value !== "object") return false;

  const provenanceKeys = "provenanceJson" in value ? [...BASE, "provenanceJson", "provenanceHash"] : BASE;
  const supersedesKeys = "supersedes" in value ? [...provenanceKeys, "supersedes"] : provenanceKeys;
  const actionKeys = "deploymentAction" in value ? [...supersedesKeys, "deploymentAction"] : supersedesKeys;
  const keys = "decisionBasisHash" in value ? [...actionKeys, "decisionBasisHash"] : actionKeys;
  if (!fields(value, [...keys, "baselineUtility", "candidateUtility", "fullStudyCost"])
    && !fields(value, [...keys, "reason"])) return false;

  if (![value.id, value.scope, value.experimentRef, value.experimentVersion, value.utilityUnit, value.sourceRef].every(identity)
    || typeof value.conditionHash !== "string" || !/^[a-f0-9]{64}$/.test(value.conditionHash)
    || !validProvenance(value.provenanceJson, value.provenanceHash)
    || !validDecisionMetadata(value.deploymentAction, value.decisionBasisHash)
    || ("supersedes" in value && !identity(value.supersedes)) || typeof value.sourceRef !== "string" || !/^(checker|execution):/.test(value.sourceRef)) return false;

  return value.kind === "measured" ? [value.baselineUtility, value.candidateUtility, value.fullStudyCost].every(x => typeof x === "number" && Number.isFinite(x))
    && typeof value.fullStudyCost === "number" && value.fullStudyCost >= 0 : value.kind === "unknown" && identity(value.reason);
}

function validDecisionMetadata(action: unknown, basisHash: unknown): boolean {
  return (action === undefined || (sequence(action) && action <= 1))
    && (basisHash === undefined || (typeof basisHash === "string" && /^[a-f0-9]{64}$/.test(basisHash)));
}

function freezeDecision(binding: TopicDecisionBinding): FrozenDecision {
  if (binding === null || typeof binding !== "object" || !Array.isArray(binding.outcomes)
    || binding.outcomes.length === 0 || binding.outcomes.length > 8 || !validDecisionMetadata(undefined, binding.basisHash)) {
    throw new Error("topic_measurement_decision");
  }

  if (!fields(binding, "basisHash" in binding ? ["outcomes", "basisHash"] : ["outcomes"])) throw new Error("topic_measurement_decision");

  const cells = new Set<string>();
  const outcomes = binding.outcomes.map(cell => {
    if (!fields(cell, ["utilityClass", "deploymentAction"]) || !sequence(cell.utilityClass) || cell.utilityClass > 3
      || !sequence(cell.deploymentAction) || cell.deploymentAction > 1) throw new Error("topic_measurement_decision");
    const key = `${cell.utilityClass}:${cell.deploymentAction}`;
    if (cells.has(key)) throw new Error("topic_measurement_decision");
    cells.add(key);
    return Object.freeze({ utilityClass: cell.utilityClass, deploymentAction: cell.deploymentAction });
  });
  const value = { outcomes: Object.freeze(outcomes), ...(binding.basisHash === undefined ? {} : { basisHash: binding.basisHash }) };

  return Object.freeze({ ...value, hash: contentHashOf(value) });
}

function validProvenance(json: unknown, hash?: unknown): boolean {
  if (json === undefined) return hash === undefined;
  if (typeof json !== "string" || json.length > 16384) return false;
  try {
    const value: unknown = JSON.parse(json);
    return hash === undefined || (typeof hash === "string" && hash === contentHashOf(value));
  }
  catch { return false; }
}
