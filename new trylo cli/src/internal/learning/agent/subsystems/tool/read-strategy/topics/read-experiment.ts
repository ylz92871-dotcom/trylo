import type { ReadRoutingOpportunity, ReadRoutingPath, ReadRoutingTrial } from "../../../../../../ports/read-routing.js";
import type { TopicExperimentContext, TopicExperimentDescriptor } from "../../../../../domains/shared/topics/contracts.js";
import type { EmpiricalTopicPolicy } from "../../../../../domains/shared/topics/empirical-model.js";
import { canonicalJson, contentHashOf } from "../../../../../control/hash.js";
import { READ_TOPIC_OBJECTIVE, readPairUtility, readPairStudyCost } from "./read-objective.js";
import { READ_STRATEGY_COST_METRIC } from "../domain/index.js";
import { createReadTopicDemandPolicy } from "./read-demand.js";
import { fields, identity, sequence } from "../../../../../../validation/json-shape.js";
import { boundedOperation } from "../../../../../../integration/shared/bounded-operation.js";
import type { createReadStrategyRuntime } from "../runtime/runtime.js";
import { readStrategyConditions } from "../runtime/sensor.js";
import { topicProbeExpectationKeys, matchesPairedTopicExperiment, type TopicProbeExpectation, type TopicCalibrationExpectation,
  type TopicPairedOutcome, type TopicPairedProbe, type TopicExperimentRegistration, type TopicLearningConfiguration }
  from "../../../../../../integration/learning-topics/experiment-port.js";
import { createReadTopicDecisionPolicy } from "./read-decision.js";
import { resolvedTopicExperiment, freezeTopicExperimentBindingRecord, topicExperimentBindingHash,
  type TopicExperimentBindingRecord } from "../../../../../domains/shared/topics/experiment-binding.js";
import { readReadTopicFeedback, readReadTopicFeedbackBatch } from "./read-feedback.js";

type Expected = TopicProbeExpectation | TopicCalibrationExpectation;

type ReadFeedbackRuntime = Pick<ReturnType<typeof createReadStrategyRuntime>, "record" | "confirm" | "learn">;

/** A central host's explicit pool configuration, never an automatic budget renewal. */
export type ReadTopicPoolConfiguration = Pick<TopicLearningConfiguration["policy"], "poolId" | "totalQuota">;

type Options = { readonly boardRoot: string; readonly scope: string; readonly collect: () => boolean; readonly nowMs?: () => number;
  readonly pool?: ReadTopicPoolConfiguration };

type Captured = Pick<ReadRoutingOpportunity, "executionId" | "conditions" | "requiredBytes" | "trial">;

type Arm = { readonly path: ReadRoutingPath; readonly result?: Pick<ReadRoutingTrial,
  "path" | "quality" | "executed" | "bytesRead" | "latencyMs" | "totalBytesRead" | "totalLatencyMs" | "proofRef">;
  readonly routing?: { readonly executionId: string; readonly state: "pending" | "confirmed" | "unconfirmed" };
  readonly reason?: string; readonly error?: string };

const { maximumCandidateBytes: MAX_FILE_BYTES, maximumPairBytes: MAX_PAIR_BYTES, utilityScale: UTILITY_SCALE } = READ_TOPIC_OBJECTIVE;
const MAX_OPPORTUNITIES = 16, MAX_PAIRS = 256, PAIR_TIMEOUT_MS = 2000;
const DEMAND_HORIZON = 16, DEMAND_WINDOW = 64;
const { utilityUnit: UTILITY_UNIT, checkerVersion: CHECKER_VERSION, executionVersion: EXECUTION_VERSION } = READ_TOPIC_OBJECTIVE;
const CONDITION = Object.freeze({ label: "bounded streaming <=262144",
  assumption: "Host-declared coarse grouping; exact exchangeability across files, ranges and cache states is not established." });
const conditionHashOf = (conditions: ReadRoutingOpportunity["conditions"]) => contentHashOf({
  schemaVersion: 1, conditions: readStrategyConditions(conditions), objective: UTILITY_UNIT,
  checkerVersion: CHECKER_VERSION, executionVersion: EXECUTION_VERSION, declaration: CONDITION });

function eligible(opportunity: ReadRoutingOpportunity): boolean {
  return identity(opportunity.executionId) && opportunity.conditions.range === "bounded" && opportunity.conditions.streaming === true
    && sequence(opportunity.conditions.fileBytes) && opportunity.conditions.fileBytes <= MAX_FILE_BYTES
    && sequence(opportunity.requiredBytes) && opportunity.requiredBytes > 0
    && opportunity.requiredBytes * 2 <= MAX_PAIR_BYTES && typeof opportunity.trial === "function";
}

function armOf(path: ReadRoutingPath, value: ReadRoutingTrial, reservedBytes: number): Arm {
  if (value.path !== path || !["pass", "fail", "unknown"].includes(value.quality) || typeof value.executed !== "boolean"
    || !sequence(value.bytesRead) || !sequence(value.totalBytesRead) || value.totalBytesRead < value.bytesRead
    || typeof value.latencyMs !== "number" || !Number.isFinite(value.latencyMs) || value.latencyMs < 0
    || typeof value.totalLatencyMs !== "number" || !Number.isFinite(value.totalLatencyMs) || value.totalLatencyMs < value.latencyMs
    || !/^routing-read-check:[a-f0-9]{64}$/.test(value.proofRef)) return { path, error: "read_topic_trial_invalid" };
  return Object.freeze({ path, result: Object.freeze({ path: value.path, quality: value.quality, executed: value.executed,
    bytesRead: value.bytesRead, latencyMs: value.latencyMs, totalBytesRead: value.totalBytesRead, totalLatencyMs: value.totalLatencyMs, proofRef: value.proofRef }),
    ...(value.bytesRead > MAX_FILE_BYTES || value.totalBytesRead > reservedBytes ? { error: "read_topic_cost_bound" } : {}),
    ...(value.reason === undefined ? {} : { reason: /^[a-z][a-z0-9_]{0,127}$/.test(value.reason) ? value.reason : "read_topic_reason_unavailable" }) });
}

function known(arm: Arm): boolean {
  return arm.error === undefined && arm.result !== undefined && arm.result.executed && arm.result.quality !== "unknown";
}

const armExecutionId = (spendId: string, path: ReadRoutingPath) => `read-topic-trial:${contentHashOf([spendId, path])}`;

/** Captures only existing permitted read capabilities. It neither reads a file nor runs a trial on offer. */
export function createDefaultReadTopicConfiguration(options: Options): {
  readonly configuration: TopicLearningConfiguration; offer(opportunity: ReadRoutingOpportunity): void;
  bindRuntime(runtime: ReadFeedbackRuntime): void;
} {
  if (!identity(options.scope)) throw new Error("read_topic_scope_invalid");

  const { scope, collect } = options, nowMs = options.nowMs ?? Date.now;
  const pool = options.pool === undefined ? { poolId: "ws1-read-pair-v1", totalQuota: 256 }
    : { poolId: options.pool.poolId, totalQuota: options.pool.totalQuota };
  let runtime: ReadFeedbackRuntime | undefined, runtimeOwner: ReadFeedbackRuntime | undefined;
  const descriptor: TopicExperimentDescriptor = Object.freeze({ ref: "tool.read.whole-stream.v2", version: "2", domain: "tool",
    purpose: "比较已捕获有界读取机会的whole/stream核验与io_cost（bytes+1024×耗时ms）" });
  const policy: EmpiricalTopicPolicy = Object.freeze({ scope, experimentRef: descriptor.ref, experimentVersion: descriptor.version,
    utilityUnit: UTILITY_UNIT, conditionHash: contentHashOf(CONDITION), futureUses: 1, utilityScale: UTILITY_SCALE * DEMAND_HORIZON, experimentUnits: 1,
    priorStrength: 2, priorWeights: Object.freeze([0.25, 0.25, 0.25, 0.25]),
    deltaBounds: Object.freeze({ minimum: -UTILITY_SCALE, maximum: UTILITY_SCALE }) });
  const queue = new Map<string, Captured>(), consumed = new Set<string>();
  const calls = new Map<string, { readonly expected: string; readonly promise: Promise<string> }>();
  const cache = new Map<string, { readonly expected: string; readonly outcome: TopicPairedOutcome }>();
  const conditions = () => queue.values().next().value?.conditions;
  const decision = createReadTopicDecisionPolicy({ boardRoot: options.boardRoot, scope, policy, enabled: collect,
    conditionHash: conditionHashOf,
    conditions });
  const demandPolicy = createReadTopicDemandPolicy({ boardRoot: options.boardRoot, scope, enabled: collect, conditions,
    horizon: DEMAND_HORIZON, windowSize: DEMAND_WINDOW, prior: { alpha: 1, beta: 1 } });
  const stopped = (signal: AbortSignal) => signal.aborted || !collect();

  function currentConditionHash(): string | undefined {
    if (!collect()) return undefined;
    const opportunity = queue.values().next().value;
    return opportunity === undefined ? undefined : conditionHashOf(opportunity.conditions);
  }

  function available(): boolean {
    if (!collect()) {
      queue.clear();
      return false;
    }
    return runtime !== undefined && queue.size > 0 && calls.size < MAX_PAIRS;
  }

  function describeContext(): TopicExperimentContext | undefined {
    if (!available()) return undefined;

    const current = conditions();
    if (current === undefined) return undefined;

    const classified = readStrategyConditions(current);
    const fileSize = classified.fileSize === "small" ? "小文件" : "大文件";
    const range = classified.range === "bounded" ? "有界" : "全量";
    const streaming = classified.streaming ? "可流式" : "不可流式";

    return Object.freeze({
      decision: `${fileSize}/${range}/${streaming}选whole/stream；候选成功min(1e9,bytes+1024×ms)，失败1e9。`,
      observation: "candidateCost为候选代价；studyCost含前后核验。",
    });
  }

  async function publish(arm: Arm, opportunity: Captured, expected: Expected, feedback: ReadFeedbackRuntime, signal: AbortSignal): Promise<Arm> {
    const executionId = armExecutionId(expected.spendId, arm.path);
    const receipt = (state: "confirmed" | "unconfirmed", error?: string): Arm => Object.freeze({ ...arm,
      routing: Object.freeze({ executionId, state }), ...(error === undefined ? {} : { error }) });

    if (!known(arm) || stopped(signal)) return receipt("unconfirmed", "read_topic_feedback_stopped");

    const actual = arm.result!;

    try {
      await feedback.record({ executionId, conditions: opportunity.conditions,
        decision: { path: arm.path, reason: "bounded_read_comparison" }, actualPath: arm.path,
        outcome: actual.quality === "pass" ? "completed" : "failed", bytesRead: actual.bytesRead, latencyMs: actual.latencyMs }, signal);

      if (stopped(signal)) return receipt("unconfirmed", "read_topic_feedback_stopped");

      const confirmed = await feedback.confirm({ executionId, feedbackId: `${executionId}:checked`,
        passed: actual.quality === "pass", proofRef: actual.proofRef }, signal);

      return confirmed.ok && !stopped(signal) ? receipt("confirmed") : receipt("unconfirmed", "read_topic_feedback_unconfirmed");
    } catch { return receipt("unconfirmed", "read_topic_feedback_unconfirmed"); }
  }

  function expectation(input: Parameters<TopicPairedProbe["run"]>[0]): Expected {
    const expected = Object.freeze({ ...input.expected });
    const base = ["scope", "domain", "allocationId", "valuationId", "units", "spendId", "claimId", "checkerVersion", "executionVersion"];
    const keys = input.purpose === "calibration" ? [...base, "purpose", "protocolHash"] : topicProbeExpectationKeys(input.expected);
    if (!fields(expected, keys) || expected.scope !== scope || expected.domain !== "tool" || expected.units !== 1
      || expected.checkerVersion !== CHECKER_VERSION || expected.executionVersion !== EXECUTION_VERSION
      || ![expected.allocationId, expected.valuationId, expected.spendId, expected.claimId].every(identity)) throw new Error("read_topic_expected_binding");

    if (input.purpose === "calibration") {
      const conditionHash = currentConditionHash();
      const protocolHash = conditionHash === undefined ? undefined : contentHashOf({ policy: { ...policy, conditionHash },
        checkerVersion: CHECKER_VERSION, executionVersion: EXECUTION_VERSION });
      if (protocolHash === undefined || Reflect.get(expected, "purpose") !== "calibration"
        || Reflect.get(expected, "protocolHash") !== protocolHash) throw new Error("read_topic_protocol_binding");
    } else {
      const questionId: unknown = Reflect.get(expected, "questionId"), modelHash: unknown = Reflect.get(expected, "modelHash");
      const decisionBasisHash: unknown = Reflect.get(expected, "decisionBasisHash");
      if (!identity(questionId) || typeof modelHash !== "string" || !/^[a-f0-9]{64}$/.test(modelHash)
        || typeof decisionBasisHash !== "string" || !/^[a-f0-9]{64}$/.test(decisionBasisHash)
        || !matchesPairedTopicExperiment(input, descriptor, currentConditionHash() ?? "")
        || resolvedTopicExperiment(input.topic, input.experimentBinding)?.conditionHash !== currentConditionHash()) {
        throw new Error("read_topic_question_binding");
      }
    }

    return expected;
  }

  async function pair(expected: Expected, expectedJson: string, expectedHash: string, signal: AbortSignal, experimentBinding?: TopicExperimentBindingRecord): Promise<string> {
    if (stopped(signal)) throw new Error("read_topic_stopped");

    const feedback = runtime;
    if (feedback === undefined) throw new Error("read_topic_feedback_unbound");

    const first = queue.entries().next().value;
    if (first === undefined) throw new Error("read_topic_opportunity_unavailable");

    const [key, opportunity] = first;
    const conditionHash = conditionHashOf(opportunity.conditions);

    queue.delete(key);
    consumed.add(key);
    const arms: Arm[] = [];
    let reason: string | undefined;
    let deploymentAction: 0 | 1 | undefined;
    let decisionBasisHash: string | undefined;
    let learning: { readonly status: string; readonly versionId?: string; readonly reason?: string } | undefined;

    try {
      await boundedOperation(signal, PAIR_TIMEOUT_MS, async bounded => {
        const initialBasis = await decision.readBasis(opportunity.conditions, bounded);

        if (stopped(bounded) || signal.aborted) throw new Error("read_topic_stopped");

        if (initialBasis === undefined) {
          reason = "read_topic_decision_unknown";
          return;
        }

        decisionBasisHash = initialBasis.basisHash;

        if ("questionId" in expected && Reflect.get(expected, "decisionBasisHash") !== decisionBasisHash) {
          reason = "read_topic_decision_stale";
          return;
        }

        for (const path of ["whole", "stream"] as const) {
          if (stopped(bounded) || signal.aborted) throw new Error("read_topic_stopped");

          if (arms.some(arm => !known(arm))) {
            reason = "read_topic_quality_or_cost_unknown";
            break;
          }

          const spent = arms.reduce((sum, arm) => sum + arm.result!.totalBytesRead, 0);
          if (spent + opportunity.requiredBytes > MAX_PAIR_BYTES) {
            reason = "read_topic_byte_allowance";
            break;
          }

          const actual = await opportunity.trial(path, bounded);

          if (stopped(bounded) || signal.aborted) throw new Error("read_topic_stopped");

          let arm = armOf(path, actual, opportunity.requiredBytes);
          if (known(arm)) arm = Object.freeze({ ...arm,
            routing: Object.freeze({ executionId: armExecutionId(expected.spendId, path), state: "pending" as const }) });

          const index = arms.length;
          arms.push(arm);

          if (known(arm)) arm = await publish(arm, opportunity, expected, feedback, bounded);

          if (stopped(bounded) || signal.aborted) throw new Error("read_topic_stopped");

          arms[index] = arm;

          if (!known(arm)) {
            reason = arm.error ?? arm.reason ?? "read_topic_quality_or_cost_unknown";
            break;
          }
        }

        if (arms.some(arm => arm.routing?.state === "confirmed")) {
          if (stopped(bounded) || signal.aborted) throw new Error("read_topic_stopped");

          const learned = await feedback.learn({ domain: "tool", scope, requestId: expected.spendId,
            issuedAt: new Date(nowMs()).toISOString(), budget: { maxObservations: 4096 } }, bounded);

          if (stopped(bounded) || signal.aborted) throw new Error("read_topic_stopped");

          if (learned.status === "learned") {
            const versionId: unknown = Reflect.get(learned, "versionId");
            if (!identity(versionId) || Reflect.get(learned, "policy") === undefined) {
              reason = "read_topic_policy_unconfirmed";
              learning = { status: "unconfirmed" };
            } else learning = { status: "learned", versionId };
          } else if (learned.status === "waiting_evidence") {
            learning = { status: "waiting", reason: "read_topic_more_checked_samples_required" };
          } else {
            reason = "read_topic_policy_unconfirmed";
            learning = { status: learned.status };
          }
        }

        if (reason === undefined && arms.length === 2 && arms.every(known)) {
          const final = await decision.finishPair(initialBasis, opportunity.conditions, expected.spendId,
            arms.map(arm => armExecutionId(expected.spendId, arm.path)), bounded);
          if (stopped(bounded) || signal.aborted) throw new Error("read_topic_stopped");
          if (final === undefined) reason = "read_topic_decision_changed";
          else {
            deploymentAction = final.action;
            decisionBasisHash = final.decisionBasisHash;
          }
        }
      }, "read_topic_stopped");
    } catch { reason = "read_topic_execution_unknown"; }

    if (stopped(signal)) reason = "read_topic_stopped";

    const measured = reason === undefined && arms.length === 2 && arms.every(known);
    const totalBytes = measured ? arms[0]!.result!.totalBytesRead + arms[1]!.result!.totalBytesRead : undefined;
    if (totalBytes !== undefined && totalBytes > MAX_PAIR_BYTES) reason = "read_topic_byte_overrun";

    const studyCost = measured ? arms.reduce((sum, arm) => sum + readPairStudyCost(arm.result!.totalBytesRead, arm.result!.totalLatencyMs), 0) : undefined;
    if (studyCost !== undefined && !Number.isFinite(studyCost)) reason = "read_topic_cost_invalid";

    const provenance = { schemaVersion: 1, expectedHash, opportunity: { executionId: opportunity.executionId,
      conditions: opportunity.conditions, requiredBytesPerTrial: opportunity.requiredBytes },
      checkerVersion: CHECKER_VERSION, executionVersion: EXECUTION_VERSION, conditionHash,
      conditionAssumption: CONDITION, order: ["whole", "stream"], arms,
      strategyUpdate: learning ?? { status: "not_confirmed" },
      ...(deploymentAction === undefined ? {} : { deploymentAction }),
      ...(decisionBasisHash === undefined ? {} : { decisionBasisHash }),
      costDefinition: { utilityUnit: UTILITY_UNIT, metric: READ_STRATEGY_COST_METRIC,
        knownQualityUtility: "pass:-min(metric.maximum,bytesRead+1024*latencyMs); fail:-metric.maximum",
        fullStudyCost: "sum of each arm's actual totalBytesRead+1024*totalLatencyMs, including before/after checks; not clipped",
        maximumPairBytes: MAX_PAIR_BYTES, maximumCandidateBytes: MAX_FILE_BYTES, ignoredMetrics: ["provider_tokens"] },
      ...(experimentBinding === undefined ? {} : { experimentBinding, experimentBindingHash: topicExperimentBindingHash(experimentBinding) }),
      ...(reason === undefined ? {} : { reason }) };
    const sourceRef = `checker:${contentHashOf(provenance)}`, ref = `read-topic-pair:${contentHashOf([expectedHash, opportunity.executionId])}`;
    const base = { scope, experimentRef: descriptor.ref, experimentVersion: descriptor.version, conditionHash,
      utilityUnit: UTILITY_UNIT, measurementId: `read-pair:${expectedHash}`, sourceRef, provenanceJson: canonicalJson(provenance) };
    const utility = (arm: Arm) => readPairUtility(arm.result!.quality === "pass" ? "pass" : "fail", arm.result!.bytesRead, arm.result!.latencyMs);
    const outcome: TopicPairedOutcome = reason === undefined && measured && studyCost !== undefined && deploymentAction !== undefined && decisionBasisHash !== undefined
      ? Object.freeze({ ...base, kind: "measured", baselineUtility: utility(arms[0]!), candidateUtility: utility(arms[1]!), fullStudyCost: studyCost, deploymentAction, decisionBasisHash })
      : Object.freeze({ ...base, kind: "unknown", reason: reason ?? "read_topic_quality_or_cost_unknown" });

    cache.set(ref, { expected: expectedJson, outcome });
    return ref;
  }

  const probe: TopicPairedProbe = Object.freeze({
    describeComparison: decision.describeComparison,
    run(input: Parameters<TopicPairedProbe["run"]>[0]) {
      if (stopped(input.signal)) return Promise.reject(new Error("read_topic_stopped"));

      const accepted = input.purpose === "question" && input.experimentBinding !== undefined
        ? { ...input, experimentBinding: freezeTopicExperimentBindingRecord(input.experimentBinding) } : input;
      const expected = expectation(accepted), expectedJson = canonicalJson(expected), expectedHash = contentHashOf(expected);
      const previous = calls.get(expectedHash);
      if (previous !== undefined) return previous.expected === expectedJson ? previous.promise : Promise.reject(new Error("read_topic_expected_conflict"));

      if (calls.size >= MAX_PAIRS) return Promise.reject(new Error("read_topic_capacity"));

      const signal = input.signal;
      const experimentBinding = accepted.purpose === "question" ? accepted.experimentBinding : undefined;
      const promise = Promise.resolve().then(() => pair(expected, expectedJson, expectedHash, signal, experimentBinding));

      calls.set(expectedHash, { expected: expectedJson, promise });
      return promise;
    },
    async read(ref: string, expected: Expected, signal: AbortSignal) {
      if (stopped(signal)) return undefined;
      const saved = cache.get(ref);
      return saved?.expected === canonicalJson(expected) ? saved.outcome : undefined;
    },
    readFeedback(ref: string, signal: AbortSignal) {
      return readReadTopicFeedback({ boardRoot: options.boardRoot, scope, experimentRef: descriptor.ref,
        experimentVersion: descriptor.version, utilityUnit: UTILITY_UNIT, enabled: collect }, ref, signal);
    },
    readFeedbackBatch(refs: readonly string[], signal: AbortSignal) {
      return readReadTopicFeedbackBatch({ boardRoot: options.boardRoot, scope, experimentRef: descriptor.ref,
        experimentVersion: descriptor.version, utilityUnit: UTILITY_UNIT, enabled: collect }, refs, signal);
    },
  });
  const registration: TopicExperimentRegistration = Object.freeze({ descriptor,
    policy: Object.freeze({ conditionHash: policy.conditionHash, futureUses: policy.futureUses, utilityScale: policy.utilityScale,
      experimentUnits: policy.experimentUnits, priorStrength: policy.priorStrength, priorWeights: policy.priorWeights, deltaBounds: policy.deltaBounds }),
    checkerVersion: CHECKER_VERSION, executionVersion: EXECUTION_VERSION, probe, probeTimeoutMs: 5000, available, currentConditionHash, describeContext,
    // Two distinct checked pairs can reach the existing learner's two-executions-per-path floor.
    // This is an initial evidence allowance, not a guarantee of passing samples or positive value.
    calibrationTarget: 2, decisionPolicy: decision.decisionPolicy, demandPolicy, demandHorizon: DEMAND_HORIZON });
  const configuration: TopicLearningConfiguration = Object.freeze({ policy: Object.freeze({ ...pool,
    algorithmVersion: "ws1-read-pair-v1", utilityUnit: UTILITY_UNIT, quotaUnit: "checked_read_pair_v1" }),
    perTurnQuota: 1, domainRelation: "separable", experiments: Object.freeze([registration]),
    calibration: Object.freeze({ quota: 1, domains: Object.freeze(["tool"] as const) }) });

  return Object.freeze({ configuration,
    bindRuntime(value: ReadFeedbackRuntime): void {
      if (runtimeOwner === value) return;
      if (runtime !== undefined || typeof value.record !== "function" || typeof value.confirm !== "function" || typeof value.learn !== "function") {
        throw new Error("read_topic_feedback_binding");
      }
      runtimeOwner = value;
      runtime = Object.freeze({ record: value.record.bind(value), confirm: value.confirm.bind(value), learn: value.learn.bind(value) });
    },
    offer(opportunity: ReadRoutingOpportunity): void {
      if (!collect()) {
        queue.clear();
        return;
      }

      if (!eligible(opportunity) || calls.size >= MAX_PAIRS) return;

      const key = contentHashOf(opportunity.executionId);
      if (queue.has(key) || consumed.has(key)) return;

      if (queue.size === MAX_OPPORTUNITIES) queue.delete(queue.keys().next().value!);

      queue.set(key, Object.freeze({ executionId: opportunity.executionId, conditions: Object.freeze({ ...opportunity.conditions }),
        requiredBytes: opportunity.requiredBytes, trial: opportunity.trial.bind(opportunity) }));
    },
  });
}
