import { LEARNING_DOMAINS, type LearningDomain } from "../../learning/control/contracts.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { identity } from "../../validation/json-shape.js";
import type { RewardV2Fact } from "../../learning/reward/v2-facts.js";
import { isTopicExperimentDescriptor, isTopicExperimentContext, freezeTopicExperimentDescriptor } from "../../learning/domains/shared/topics/parse.js";
import type { TopicExperimentDescriptor, TopicExperimentContext, TopicEvidenceWindow } from "../../learning/domains/shared/topics/contracts.js";
import { prepareTopicOpportunity } from "../../learning/domains/shared/topics/opportunity.js";
import { activeEmpiricalTopicSupport, buildEmpiricalTopicModel, isEmpiricalTopicPolicy, type EmpiricalDecisionProjection, type EmpiricalTopicPolicy,
  type TopicPairedMeasurement } from "../../learning/domains/shared/topics/empirical-model.js";
import { createRewardV2BoardPort } from "../reward/v2-board-port.js";
import { createTopicBudgetPool } from "./pool.js";
import type { TopicPoolPolicy } from "./pool-ledger.js";
import { createTopicCoordinator, type TopicCoordinatorRequest, type TopicCoordinatorResult } from "./coordinator.js";
import { createTopicDomainRuntime, type PreparedTopicDomain } from "./domain-runtime.js";
import { createTopicMeasurementSource, topicMeasurements, type TopicPairedProbe } from "./measurement-source.js";
import { createTopicCalibrationRuntime, type TopicCalibrationResult } from "./calibration.js";
import { readTopicCalibrationProgress } from "./calibration-progress.js";
import { validatePreparedDomainModel, type TopicDomainModelSource } from "./domain-model.js";
import { topicDomainCandidates } from "./domain-candidates.js";
import { compactTopicProvenance } from "./provenance.js";
import { comparisonEvidenceRecord } from "./comparison-evidence.js";
import { createTopicExperimentBindingStore, type TopicExperimentBindingSource } from "./experiment-binding.js";
import { resolvedTopicExperiment, topicExperimentBindingHash } from "../../learning/domains/shared/topics/experiment-binding.js";
import { isActiveTopicDomain } from "./active-domain.js";

export type TopicDecisionPolicyResult =
  | (EmpiricalDecisionProjection & { readonly status: "ready"; readonly provenanceJson: string })
  | { readonly status: "unmodelled"; readonly reason: string };

/** Pure/local domain projection of its real deployment policy; this callback does not execute an experiment. */
export type TopicDecisionPolicy = (input: { readonly questionId: string; readonly boardSequence: number;
  readonly measurements: readonly TopicPairedMeasurement[]; readonly signal: AbortSignal }) => TopicDecisionPolicyResult | Promise<TopicDecisionPolicyResult>;

export type TopicDemandPolicyResult =
  | { readonly status: "ready"; readonly futureUses: number; readonly basisHash: string; readonly provenanceJson: string }
  | { readonly status: "unmodelled"; readonly reason: string };

/** Expected relevant uses within a declared horizon, estimated only by the owning domain. */
export type TopicDemandPolicy = (input: { readonly boardSequence: number; readonly signal: AbortSignal }) =>
  TopicDemandPolicyResult | Promise<TopicDemandPolicyResult>;

export type TopicExperimentRegistration = {
  readonly descriptor: TopicExperimentDescriptor;
  readonly policy: Omit<EmpiricalTopicPolicy, "scope" | "experimentRef" | "experimentVersion" | "utilityUnit">;
  readonly checkerVersion: string; readonly executionVersion: string;
  readonly probe: TopicPairedProbe; readonly probeTimeoutMs?: number;
  readonly decisionPolicy?: TopicDecisionPolicy;
  readonly demandPolicy?: TopicDemandPolicy;
  /** Maximum forecast uses; the common utility scale must cover this entire horizon. */
  readonly demandHorizon?: number;
  /** Explicit initial evidence target, not a positive-value claim or a retry allowance. Defaults to one pair. */
  readonly calibrationTarget?: number;
  /** Only the host-classified condition may vary; objective, scope, versions and units stay fixed. */
  readonly currentConditionHash?: () => string | undefined;
  /** Local availability of an already captured, permitted domain opportunity. */
  readonly available?: () => boolean;
  /** Bounded metadata for the currently captured choice; pure, local, and never an experiment. */
  readonly describeContext?: () => TopicExperimentContext | undefined;
};

export type TopicLearningConfiguration = {
  readonly policy: Omit<TopicPoolPolicy, "scope">;
  readonly perTurnQuota: number;
  readonly experiments: readonly TopicExperimentRegistration[];
  /** Domain-owned joint models over actual recorded questions; numbers never come from the semantic proposal. */
  readonly domainModels?: readonly TopicDomainModelSource[];
  /** Trusted readback of late experiment relations; it grants neither study units nor Permission. */
  readonly bindings?: TopicExperimentBindingSource;
  readonly domainRelation: "separable";
  /** An explicit host allowance, used only when a relevant domain lacks initial support. */
  readonly calibration?: { readonly quota: number; readonly domains: readonly LearningDomain[] };
};

export type TopicLearningCycleResult = TopicCoordinatorResult & {
  readonly purpose: "valuation" | "calibration";
  readonly calibration?: TopicCalibrationResult;
};

/** Production composition: domain semantics/models stay below the central nomination boundary. */
export function createTopicLearningSystem(options: { readonly boardRoot: string; readonly scope: string;
  readonly enabled: () => boolean; readonly configuration: TopicLearningConfiguration }) {
  const { configuration, enabled } = options;

  if (configuration.domainRelation !== "separable" || !Array.isArray(configuration.experiments) || configuration.experiments.length > 8
    || !Number.isSafeInteger(configuration.perTurnQuota) || configuration.perTurnQuota < 0 || configuration.perTurnQuota > 6) {
    throw new Error("topic_system_configuration");
  }

  const perTurnQuota = configuration.perTurnQuota;
  const exploration = configuration.calibration === undefined ? undefined : Object.freeze({ quota: configuration.calibration.quota,
    domains: Object.freeze([...configuration.calibration.domains]) });
  if (exploration !== undefined && (!Number.isSafeInteger(exploration.quota) || exploration.quota < 1 || exploration.quota > 6
    || exploration.domains.length === 0 || exploration.domains.length > LEARNING_DOMAINS.length
    || exploration.domains.some(domain => !isActiveTopicDomain(domain)))) throw new Error("topic_system_calibration_policy");

  const pool = createTopicBudgetPool({ ...configuration.policy, boardRoot: options.boardRoot, scope: options.scope, enabled });

  if (configuration.domainModels !== undefined && (!Array.isArray(configuration.domainModels)
    || configuration.domainModels.length > LEARNING_DOMAINS.length)) throw new Error("topic_system_domain_models");

  const domainModels = (configuration.domainModels ?? []).map(source => {
    if (!isActiveTopicDomain(source.domain) || typeof source.available !== "function" || typeof source.prepare !== "function"
      || (source.descriptors !== undefined && typeof source.descriptors !== "function")
      || (source.utilityScale !== undefined && (!Number.isFinite(source.utilityScale) || source.utilityScale <= 0))) {
      throw new Error("topic_system_domain_models");
    }
    return Object.freeze({ domain: source.domain, available: source.available.bind(source), prepare: source.prepare.bind(source),
      descriptors: source.descriptors?.bind(source), utilityScale: source.utilityScale });
  });
  if (new Set(domainModels.map(source => source.domain)).size !== domainModels.length) throw new Error("topic_system_domain_models");

  // Freeze each experiment's policy and retain measurements per condition hash.
  const entries = configuration.experiments.map((entry: TopicExperimentRegistration) => {
    if (!isTopicExperimentDescriptor(entry.descriptor) || !isActiveTopicDomain(entry.descriptor.domain)
      || !identity(entry.checkerVersion) || !identity(entry.executionVersion)
      || (entry.decisionPolicy !== undefined && typeof entry.decisionPolicy !== "function")
      || (entry.demandPolicy !== undefined && typeof entry.demandPolicy !== "function")
      || (entry.calibrationTarget !== undefined && (!Number.isSafeInteger(entry.calibrationTarget)
        || entry.calibrationTarget < 1 || entry.calibrationTarget > 6))
      || (entry.currentConditionHash !== undefined && typeof entry.currentConditionHash !== "function")) {
      throw new Error("topic_system_experiment");
    }

    if (entry.describeContext !== undefined && typeof entry.describeContext !== "function") throw new Error("topic_system_experiment");

    const descriptor = freezeTopicExperimentDescriptor(entry.descriptor);
    const policy: EmpiricalTopicPolicy = Object.freeze({ ...entry.policy, scope: options.scope,
      experimentRef: descriptor.ref, experimentVersion: descriptor.version, utilityUnit: pool.policy.utilityUnit,
      deltaBounds: Object.freeze({ ...entry.policy.deltaBounds }),
      priorWeights: Object.freeze([...entry.policy.priorWeights]) });
    if (!isEmpiricalTopicPolicy(policy)) throw new Error("topic_system_model_policy");

    if (entry.demandPolicy === undefined ? entry.demandHorizon !== undefined
      : entry.demandHorizon === undefined || !Number.isSafeInteger(entry.demandHorizon) || entry.demandHorizon < 1
        || entry.demandHorizon > 1000000
        || entry.demandHorizon * Math.max(-policy.deltaBounds.minimum, policy.deltaBounds.maximum) > policy.utilityScale) {
      throw new Error("topic_system_demand_scale");
    }

    const sources = new Map<string, { readonly policy: EmpiricalTopicPolicy; readonly source: ReturnType<typeof createTopicMeasurementSource> }>();

    function sourceFor(conditionHash: string) {
      if (!/^[a-f0-9]{64}$/.test(conditionHash)) throw new Error("topic_system_condition");

      const previous = sources.get(conditionHash);
      if (previous !== undefined) return previous;

      if (sources.size >= 64) throw new Error("topic_system_condition_capacity");

      const conditionPolicy = Object.freeze({ ...policy, conditionHash });
      const value = { policy: conditionPolicy, source: createTopicMeasurementSource({
        boardRoot: options.boardRoot, enabled, policy: conditionPolicy, probe: entry.probe }) };

      sources.set(conditionHash, value);
      return value;
    }

    const currentConditionHash = entry.currentConditionHash?.bind(entry);

    return { descriptor, policy, checkerVersion: entry.checkerVersion, executionVersion: entry.executionVersion,
      calibrationTarget: entry.calibrationTarget ?? 1,
      timeoutMs: entry.probeTimeoutMs ?? 60000,
      decisionPolicy: entry.decisionPolicy?.bind(entry),
      demandPolicy: entry.demandPolicy?.bind(entry),
      demandHorizon: entry.demandHorizon,
      available: entry.available?.bind(entry) ?? (() => true),
      feedback: entry.probe.readFeedback?.bind(entry.probe), describeComparison: entry.probe.describeComparison?.bind(entry.probe),
      describeContext: entry.describeContext?.bind(entry),
      sourceFor, currentConditionHash,

      current() {
        const conditionHash = currentConditionHash === undefined ? policy.conditionHash : currentConditionHash();
        return conditionHash === undefined ? undefined : sourceFor(conditionHash);
      } };
  });
  if (new Set(entries.map(entry => entry.descriptor.ref)).size !== entries.length) throw new Error("topic_system_duplicate_experiment");

  const scales = [...entries.map(entry => entry.policy.utilityScale), ...domainModels.flatMap(source => source.utilityScale === undefined ? [] : [source.utilityScale])];
  if (new Set(scales).size > 1) throw new Error("topic_system_utility_scale");

  const protocolHashOf = (entry: (typeof entries)[number], policy: EmpiricalTopicPolicy) => contentHashOf({ policy,
    checkerVersion: entry.checkerVersion, executionVersion: entry.executionVersion });
  const board = createRewardV2BoardPort(options.boardRoot, enabled);

  if (configuration.bindings !== undefined && (configuration.bindings === null || typeof configuration.bindings.pending !== "function"
    || typeof configuration.bindings.read !== "function")) throw new Error("topic_system_bindings");

  const bindingSource = configuration.bindings === undefined ? undefined : Object.freeze({
    pending: configuration.bindings.pending.bind(configuration.bindings), read: configuration.bindings.read.bind(configuration.bindings) });
  const bindingStore = createTopicExperimentBindingStore({ boardRoot: options.boardRoot, scope: options.scope, enabled,
    ...(bindingSource === undefined ? {} : { source: bindingSource }), catalog: descriptors });
  const calibrationEligible = new Map<LearningDomain, Set<string>>();
  const domains = [...new Set([...entries.map(entry => entry.descriptor.domain), ...domainModels.map(source => source.domain)])].map(domain => {
    const runtime = createTopicDomainRuntime({ boardRoot: options.boardRoot, scope: options.scope, domain, pool, enabled,
      prepareInput: input => prepare(domain, input.boardSequence, input.maxQuota, input.signal) });
    if (runtime.status !== "ready") throw new Error(runtime.reason);
    return runtime.port;
  });
  const coordinator = createTopicCoordinator({ pool, domains, domainRelation: "separable", enabled });
  const calibration = createTopicCalibrationRuntime({ boardRoot: options.boardRoot, pool, enabled,

    async prepare(input) {
      if (!enabled() || input.signal.aborted) return undefined;

      const view = await board.read(), measurements = topicMeasurements(view.facts, options.scope);
      const selectedRefs = calibrationEligible.get(input.domain);
      const eligible = entries.flatMap(entry => {
        if (!entry.available() || entry.descriptor.domain !== input.domain
          || (selectedRefs !== undefined && !selectedRefs.has(entry.descriptor.ref))) return [];
        const current = entry.current();
        return current === undefined ? [] : [{ entry, ...current }];
      });

      eligible.sort((a, b) => measurements.filter(row => measurementMatches(a.policy, row)).length
        - measurements.filter(row => measurementMatches(b.policy, row)).length
        || a.entry.descriptor.ref.localeCompare(b.entry.descriptor.ref));
      const selected = eligible[0];

      return selected === undefined ? undefined : { protocolHash: protocolHashOf(selected.entry, selected.policy), units: selected.policy.experimentUnits,
        checkerVersion: selected.entry.checkerVersion, executionVersion: selected.entry.executionVersion, timeoutMs: selected.entry.timeoutMs,
        run: selected.source.calibration.run, readObservation: selected.source.calibration.readObservation };
    } });

  async function prepare(domain: LearningDomain, boardSequence: number, maxQuota: number, signal: AbortSignal): Promise<PreparedTopicDomain | undefined> {
    if (!enabled() || signal.aborted) return undefined;

    const view = await board.read();
    if (view.revision !== boardSequence) return undefined;

    const measurements = Object.freeze(topicMeasurements(view.facts, options.scope).map(row => Object.freeze(row)));
    const candidates = topicDomainCandidates(view.facts, options.scope, domain, boardSequence);
    const jointSource = domainModels.find(source => source.domain === domain && source.available());
    if (jointSource !== undefined && candidates.length > 0) {
      const prepared = await jointSource.prepare({ scope: options.scope, boardSequence, maxQuota, candidates, signal });

      if (!enabled() || signal.aborted) return undefined;

      if (prepared !== undefined) {
        const checked = validatePreparedDomainModel(prepared, { domain, scope: options.scope, boardSequence, maxQuota,
          utilityUnit: pool.policy.utilityUnit, quotaUnit: pool.policy.quotaUnit, signal }, candidates);
        if (!checked.ok) throw new Error(checked.reason);
        return checked.prepared;
      }
    }

    const demands = new Map<string, Promise<TopicDemandPolicyResult>>();
    let best: { readonly prepared: PreparedTopicDomain; readonly value: number; readonly id: string } | undefined;

    for (const candidate of candidates) {
      const { topic, proposalJson: proposal, windowJson } = candidate;
      const experiment = resolvedTopicExperiment(topic, candidate.experimentBinding);
      if (experiment === undefined) continue;

      const entry = entries.find(item => item.descriptor.ref === experiment.ref
        && item.descriptor.version === experiment.version && item.descriptor.domain === domain);
      if (entry === undefined || !entry.available() || entry.decisionPolicy === undefined) continue;

      const current = entry.current();
      if (current === undefined) continue;

      if ((entry.currentConditionHash !== undefined && experiment.conditionHash === undefined)
        || (experiment.conditionHash !== undefined && experiment.conditionHash !== current.policy.conditionHash)) continue;

      const demandKey = `${entry.descriptor.ref}:${current.policy.conditionHash}`;
      let demand: TopicDemandPolicyResult | undefined;

      if (entry.demandPolicy !== undefined) {
        let pendingDemand = demands.get(demandKey);
        if (pendingDemand === undefined) {
          pendingDemand = Promise.resolve(entry.demandPolicy({ boardSequence, signal }));
          demands.set(demandKey, pendingDemand);
        }
        demand = await pendingDemand;
      }

      if (!enabled() || signal.aborted) return undefined;

      if (demand !== undefined && (demand.status !== "ready" || !/^[a-f0-9]{64}$/.test(demand.basisHash)
        || !Number.isFinite(demand.futureUses) || demand.futureUses <= 0 || demand.futureUses > entry.demandHorizon!)) continue;

      const valuationPolicy = demand === undefined ? current.policy : Object.freeze({ ...current.policy, futureUses: demand.futureUses });
      const support = Object.freeze(measurements.filter(row => measurementMatches(current.policy, row)));
      const projected = await entry.decisionPolicy({ questionId: topic.topicId, boardSequence, measurements: support, signal });

      if (!enabled() || signal.aborted) return undefined;

      if (projected.status !== "ready") continue;

      const decision: EmpiricalDecisionProjection = { currentAction: projected.currentAction,
        projections: projected.projections.map(row => ({ ...row })),
        ...(projected.basisHash === undefined ? {} : { basisHash: projected.basisHash }) };
      const model = buildEmpiricalTopicModel({ policy: valuationPolicy, questionId: topic.topicId, boardSequence, measurements: support, decision });
      if (model.status !== "ready") continue;

      const provenance = compactTopicProvenance({ boardSequence, policy: valuationPolicy, modelJson: model.modelJson,
        evidence: model.provenance, decision, decisionSourceJson: projected.provenanceJson,
        ...(demand === undefined ? {} : { demand: { futureUses: demand.futureUses, basisHash: demand.basisHash, sourceJson: demand.provenanceJson } }) });
      if (provenance === undefined) continue;

      let modelProvenanceJson = provenance.json, modelProvenanceHash = provenance.hash;

      if (candidate.experimentBinding !== undefined) {
        const bound = { ...JSON.parse(provenance.json), experimentBinding: candidate.experimentBinding,
          experimentBindingHash: topicExperimentBindingHash(candidate.experimentBinding) };
        modelProvenanceJson = canonicalJson(bound);
        modelProvenanceHash = contentHashOf(bound);
      }

      const commonInput = { modelJson: model.modelJson,
        utilityUnit: pool.policy.utilityUnit, quotaUnit: pool.policy.quotaUnit, maxQuota, valuationBoardSequence: boardSequence,
        modelProvenanceHash, modelProvenanceJson,
        ...(decision.basisHash === undefined ? {} : { domainDecisionHash: decision.basisHash }),
        probeBindingHash: contentHashOf({ checkerVersion: entry.checkerVersion, executionVersion: entry.executionVersion }) };
      const prepared: PreparedTopicDomain = { input: candidate.experimentBinding === undefined ? { ...commonInput, proposals: [proposal], windowJson }
        : { ...commonInput, candidates: [{ proposalJson: proposal, windowJson, experimentBinding: candidate.experimentBinding }] },
        probe: current.source.bindDecision({ outcomes: model.outcomes,
          ...(decision.basisHash === undefined ? {} : { basisHash: decision.basisHash }) }),
        checkerVersion: entry.checkerVersion, executionVersion: entry.executionVersion, timeoutMs: entry.timeoutMs };
      const offer = prepareTopicOpportunity(prepared.input);
      if (offer.status !== "offered") continue;

      const value = offer.bid.curve.at(-1)!.netValue;
      if (best === undefined || value > best.value || (value === best.value && topic.topicId < best.id)) best = { prepared, value, id: topic.topicId };
    }

    return best?.prepared;
  }

  let active = false;
  const cycles = new Map<string, Promise<TopicLearningCycleResult>>();

  async function capturePendingBindings(requestId: string, signal: AbortSignal): Promise<TopicLearningCycleResult | undefined> {
    if (bindingSource === undefined) return undefined;

    const stop = (status: TopicCoordinatorResult["status"], reason: string): TopicLearningCycleResult => ({
      status, requestId, purpose: "valuation", reason, preparations: [], results: [] });

    if (!enabled() || signal.aborted) return stop(signal.aborted ? "cancelled" : "disabled", "topic_system_binding_stopped");

    try {
      const pending = bindingSource.pending();
      if (!Array.isArray(pending) || pending.length > 512 || !pending.every(identity)) return stop("rejected", "topic_system_binding_pending");

      const refs = new Set<string>();

      for (const ref of pending) {
        if (refs.has(ref)) continue;
        refs.add(ref);
        const captured = await bindingStore.capture(ref, signal);
        if (captured.status !== "recorded" && captured.status !== "idempotent") return stop(signal.aborted ? "cancelled" : captured.status,
          ("reason" in captured ? captured.reason : undefined) ?? `topic_system_binding_${captured.status}`);
        if (refs.size === 8) break;
      }

      return undefined;
    } catch { return stop("unknown", "topic_system_binding_unconfirmed"); }
  }

  async function refreshCurrentFeedback(signal: AbortSignal): Promise<void> {
    if (!enabled() || signal.aborted) return;

    const view = await board.read(), measurements = topicMeasurements(view.facts, options.scope);

    for (const entry of entries) {
      if (!entry.available()) continue;
      const current = entry.current();
      if (current === undefined) continue;
      const support = activeEmpiricalTopicSupport(current.policy, measurements, view.revision);
      if (support === undefined) throw new Error("topic_system_feedback_conflict");
      await current.source.refreshFeedback(support.map(row => row.id), signal);
      if (!enabled() || signal.aborted) return;
    }
  }

  async function cycle(request: TopicCoordinatorRequest, signal: AbortSignal): Promise<TopicLearningCycleResult> {
    if (active) return { status: "rejected", requestId: request.requestId, purpose: "valuation",
      reason: "topic_system_busy", preparations: [], results: [] };

    active = true;
    calibrationEligible.clear();

    try {
      const bindingStop = await capturePendingBindings(request.requestId, signal);
      if (bindingStop !== undefined) return bindingStop;

      try { await refreshCurrentFeedback(signal); }
      catch { return { status: "unknown", requestId: request.requestId, purpose: "valuation",
        reason: "topic_system_feedback_unconfirmed", preparations: [], results: [] }; }

      const nominated = { requestId: request.requestId, totalQuota: Math.min(request.totalQuota, perTurnQuota) };
      const result = await coordinator.invoke(nominated, signal);
      if (exploration === undefined || signal.aborted || !enabled()
        || !((result.status === "waiting" && result.reason === "topic_coordinator_no_valued_domain")
          || (result.status === "idle" && result.reason !== "topic_coordinator_zero_quota"))) return { ...result, purpose: "valuation" };

      const view = await board.read(), measurements = topicMeasurements(view.facts, options.scope);
      const calibrationQuotas = new Map<LearningDomain, number>();

      // Host-approved calibration may start from a real domain opportunity before a verbal
      // question exists. Each new request needs all prior pairs confirmed, and stops at
      // the explicit initial target. Unknown work cannot be replaced with another trial.
      for (const entry of entries) {
        if (!entry.available() || !exploration.domains.includes(entry.descriptor.domain)) continue;

        const current = entry.current();
        if (current === undefined) continue;

        const support = activeEmpiricalTopicSupport(current.policy, measurements, view.revision);
        if (support === undefined || support.some(row => row.kind !== "measured") || support.length >= entry.calibrationTarget) continue;

        const progress = readTopicCalibrationProgress({ facts: view.facts, policy: pool.policy,
          protocolHash: protocolHashOf(entry, current.policy), units: current.policy.experimentUnits });
        if (progress.status !== "clear" || progress.completed >= entry.calibrationTarget) continue;

        const refs = calibrationEligible.get(entry.descriptor.domain) ?? new Set<string>();
        refs.add(entry.descriptor.ref);
        calibrationEligible.set(entry.descriptor.domain, refs);
        const missing = Math.min(entry.calibrationTarget - support.length, entry.calibrationTarget - progress.completed);

        calibrationQuotas.set(entry.descriptor.domain, Math.min(calibrationQuotas.get(entry.descriptor.domain) ?? 6,
          missing * current.policy.experimentUnits));
      }

      const candidates = [...calibrationEligible.keys()];
      if (candidates.length === 0) return { ...result, purpose: "valuation" };

      const counts = new Map<LearningDomain, number>();

      for (const fact of view.facts) {
        if (fact.scope !== options.scope || fact.kind !== "learning_decision" || fact.algorithmVersion !== pool.policy.algorithmVersion) continue;
        const raw: unknown = JSON.parse(fact.payloadJson);
        if (raw !== null && typeof raw === "object" && "type" in raw && raw.type === "ws1_topic_calibration" && "domain" in raw
          && LEARNING_DOMAINS.includes(raw.domain as LearningDomain)) {
          const domain = raw.domain as LearningDomain;
          counts.set(domain, (counts.get(domain) ?? 0) + 1);
        }
      }

      candidates.sort((a, b) => (counts.get(a) ?? 0) - (counts.get(b) ?? 0) || a.localeCompare(b));
      const calibrated = await calibration.invoke({ requestId: request.requestId, domain: candidates[0]!,
        quota: Math.min(nominated.totalQuota, exploration.quota, calibrationQuotas.get(candidates[0]!)!) }, signal);

      return { ...result, purpose: "calibration", status: calibrated.status, calibration: calibrated,
        ...(calibrated.reason === undefined ? {} : { reason: calibrated.reason }) };
    } finally { active = false; }
  }

  return {
    invoke(request: TopicCoordinatorRequest, signal: AbortSignal): Promise<TopicLearningCycleResult> {
      const previous = cycles.get(request.requestId);
      if (previous !== undefined) return previous;
      if (cycles.size >= 32 || !identity(request.requestId) || !Number.isSafeInteger(request.totalQuota) || request.totalQuota < 0 || request.totalQuota > 6) {
        return Promise.resolve({ status: "rejected", requestId: request.requestId, purpose: "valuation",
          reason: "topic_system_request", preparations: [], results: [] });
      }
      const promise = cycle({ ...request }, signal);
      cycles.set(request.requestId, promise);
      return promise;
    },

    calibrate: calibration.invoke,
    bindQuestion: (ref: string, signal: AbortSignal) => bindingStore.capture(ref, signal),
    hasOpportunity: () => enabled() && ((bindingSource?.pending().length ?? 0) > 0
      || entries.some(entry => entry.available() && entry.current() !== undefined) || domainModels.some(source => source.available())),
    descriptors,
    semanticEvidence,

    async recordFeedback(experimentRef: string, feedbackRef: string, signal: AbortSignal) {
      const entry = entries.find(item => item.descriptor.ref === experimentRef);
      if (entry === undefined || entry.feedback === undefined || !identity(feedbackRef)) return { status: "unbound" as const };
      if (!enabled() || signal.aborted) return { status: "disabled" as const };
      const actual = await entry.feedback(feedbackRef, signal);
      if (actual === undefined || typeof actual.conditionHash !== "string" || !/^[a-f0-9]{64}$/.test(actual.conditionHash)) return { status: "unknown" as const };
      return entry.sourceFor(actual.conditionHash).source.recordFeedback(feedbackRef, signal);
    } };

  /** One relevant checked comparison, not a full-history summary or a claim about an unexecuted task. */
  function semanticEvidence(facts: readonly RewardV2Fact[], boardSequence: number): TopicEvidenceWindow["records"][number] | undefined {
    if (!enabled()) return undefined;

    if (!Number.isSafeInteger(boardSequence) || boardSequence < 0) throw new Error("topic_semantic_basis_invalid");

    const measurements = topicMeasurements(facts, options.scope);
    let selected: TopicEvidenceWindow["records"][number] | undefined;

    for (const entry of entries) {
      if (entry.describeComparison === undefined || !entry.available()) continue;

      const current = entry.current();
      if (current === undefined) continue;

      const active = activeEmpiricalTopicSupport(current.policy, measurements, boardSequence);
      if (active === undefined) throw new Error("topic_semantic_measurement_conflict");

      for (const row of active) {
        if (row.kind !== "measured" || (selected !== undefined && row.sequence <= selected.sequence)) continue;
        const summary = entry.describeComparison(row);
        if (summary === undefined) continue;
        const record = comparisonEvidenceRecord(summary, row, options.scope, boardSequence);
        if (record !== undefined) selected = record;
      }
    }

    return selected;
  }

  function descriptors(facts: readonly RewardV2Fact[] = []): readonly TopicExperimentDescriptor[] {
    if (!enabled()) return [];

    const catalog: TopicExperimentDescriptor[] = entries.flatMap(entry => {
      if (!entry.available()) return [];

      const current = entry.current();
      if (current === undefined) return [];

      const context = entry.describeContext === undefined ? entry.descriptor.context : entry.describeContext();
      if (context !== undefined && !isTopicExperimentContext(context)) throw new Error("topic_system_experiment_context");

      const { context: _previousContext, ...descriptor } = entry.descriptor;

      return [freezeTopicExperimentDescriptor({ ...descriptor, conditionHash: current.policy.conditionHash,
        ...(context === undefined ? {} : { context }) })];
    });

    for (const source of domainModels) {
      if (!source.available() || source.descriptors === undefined) continue;

      const candidates = topicDomainCandidates(facts, options.scope, source.domain, Number.MAX_SAFE_INTEGER);
      const described = source.descriptors({ candidates });
      if (!Array.isArray(described) || described.length > 8 || described.some(entry => !isTopicExperimentDescriptor(entry) || entry.domain !== source.domain)) {
        throw new Error("topic_system_experiment");
      }

      for (const descriptor of described) {
        if (catalog.some(entry => entry.ref === descriptor.ref)) throw new Error("topic_system_duplicate_experiment");
        catalog.push(freezeTopicExperimentDescriptor(descriptor));
      }
    }

    return catalog;
  }
}

export type TopicLearningSystem = ReturnType<typeof createTopicLearningSystem>;

function measurementMatches(policy: EmpiricalTopicPolicy, row: TopicPairedMeasurement): boolean {
  return row.scope === policy.scope && row.experimentRef === policy.experimentRef && row.experimentVersion === policy.experimentVersion
    && row.conditionHash === policy.conditionHash && row.utilityUnit === policy.utilityUnit;
}

