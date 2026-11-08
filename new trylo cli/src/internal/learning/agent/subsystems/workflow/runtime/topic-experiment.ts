import type { WorkflowLearningResult, WorkflowTask } from "../domain/trace-contracts.js";
import { parseWorkflowTask, workflowFailure } from "../domain/trace-parse.js";
import { contentHashOf, canonicalJson } from "../../../../control/hash.js";
import { isEmpiricalTopicPolicy, type EmpiricalTopicPolicy } from "../../../../domains/shared/topics/empirical-model.js";
import type { TopicExperimentDescriptor } from "../../../../domains/shared/topics/contracts.js";
import type { TopicExperimentRegistration } from "../../../../../integration/learning-topics/system.js";
import type { TopicPairedOutcome, TopicPairedProbe } from "../../../../../integration/learning-topics/measurement-source.js";
import { readWorkflowVersion } from "./archive.js";
import { selectWorkflowPath } from "../domain/trace-select.js";
import { verifyWorkflowStudyArm, type VerifiedWorkflowStudyArm, type WorkflowStudyArm, type WorkflowStudyHost } from "./topic-experiment-evidence.js";
import { fields, identity, sequence, text } from "../../../../../validation/json-shape.js";
import { record } from "../domain/trace-parse.js";

/** Output authorization is separate from Topic quota and from learning-worker total-token grants. */
export type WorkflowStudyOutputAllowance = {
  readonly unit: "provider_output_tokens"; readonly grantId: string;
  readonly pairMaxOutputTokens: number; readonly baselineMaxOutputTokens: number; readonly candidateMaxOutputTokens: number;
};

export type WorkflowStudyObjective = {
  readonly version: string; readonly utilityUnit: string; readonly costBasis: string;
  /** Trusted, versioned host objective over verified facts. No model-written score is accepted. */
  utility(arm: VerifiedWorkflowStudyArm): number | undefined;
  studyCost(pair: { readonly baseline: VerifiedWorkflowStudyArm; readonly candidate: VerifiedWorkflowStudyArm }): number | undefined;
};

export type WorkflowTopicExperimentOptions = {
  readonly boardRoot: string; readonly baselineVersionId: string; readonly candidateVersionId: string; readonly task: WorkflowTask;
  readonly sourceCase: { readonly id: string; readonly inputText: string };
  readonly descriptor: TopicExperimentDescriptor;
  readonly policy: Omit<EmpiricalTopicPolicy, "scope" | "experimentRef" | "experimentVersion" | "utilityUnit">;
  readonly checkerVersion: string; readonly executionVersion: string; readonly outputAllowance: WorkflowStudyOutputAllowance;
  readonly objective: WorkflowStudyObjective; readonly host: WorkflowStudyHost;
  readonly collect: () => boolean; readonly signal: AbortSignal; readonly issuedAt: string;
  readonly available?: () => boolean; readonly probeTimeoutMs: number;
};

export function workflowTopicConditionHash(input: Pick<WorkflowTopicExperimentOptions,
  "task" | "baselineVersionId" | "candidateVersionId" | "objective" | "outputAllowance" | "checkerVersion" | "executionVersion">): string {
  return contentHashOf({ task: input.task, baselineVersionId: input.baselineVersionId, candidateVersionId: input.candidateVersionId,
    objective: { version: input.objective.version, utilityUnit: input.objective.utilityUnit, costBasis: input.objective.costBasis },
    outputLimits: { pair: input.outputAllowance.pairMaxOutputTokens, baseline: input.outputAllowance.baselineMaxOutputTokens, candidate: input.outputAllowance.candidateMaxOutputTokens },
    checkerVersion: input.checkerVersion, executionVersion: input.executionVersion });
}

function configuration(options: WorkflowTopicExperimentOptions): boolean {
  return record(options) && record(options.objective) && typeof options.objective.utility === "function" && typeof options.objective.studyCost === "function"
    && record(options.host) && typeof options.host.executeOnce === "function" && typeof options.host.readRecords === "function"
    && record(options.sourceCase) && record(options.descriptor) && record(options.outputAllowance) && record(options.policy)
    && text(options.boardRoot, 4096) && [options.baselineVersionId, options.candidateVersionId, options.objective.version, options.objective.utilityUnit,
      options.objective.costBasis, options.sourceCase.id, options.descriptor.ref, options.descriptor.version, options.descriptor.purpose,
      options.checkerVersion, options.executionVersion, options.issuedAt].every(identity)
    && options.descriptor.domain === "workflow" && options.descriptor.purpose.length <= 160
    && text(options.sourceCase.inputText, 16384)
    && validAllowance(options.outputAllowance) && options.baselineVersionId !== options.candidateVersionId
    && Number.isSafeInteger(options.probeTimeoutMs) && options.probeTimeoutMs > 0 && options.probeTimeoutMs <= 60000
    && (options.available === undefined || typeof options.available === "function");
}

function validAllowance(value: WorkflowStudyOutputAllowance): boolean {
  const counts = [value.pairMaxOutputTokens, value.baselineMaxOutputTokens, value.candidateMaxOutputTokens];
  const total = value.baselineMaxOutputTokens + value.candidateMaxOutputTokens;
  return value.unit === "provider_output_tokens" && identity(value.grantId)
    && counts.every(count => Number.isSafeInteger(count) && count > 0) && Number.isSafeInteger(total) && total <= value.pairMaxOutputTokens;
}

/** Extra frozen-version experiment only. Ordinary learning/adoption never consults this registration. */
export async function createWorkflowTopicExperiment(input: WorkflowTopicExperimentOptions): Promise<WorkflowLearningResult<TopicExperimentRegistration>> {
  if (!record(input) || typeof input.collect !== "function" || !record(input.signal) || typeof input.signal.aborted !== "boolean") return workflowFailure("workflow_topic_configuration", "explicit collection and cancellation capabilities are required");

  const collect = input.collect, signal = input.signal;
  if (!collect()) return workflowFailure("collection_disabled", "workflow experiment collection is disabled");

  if (signal.aborted) return workflowFailure("cancelled", "workflow experiment cancelled before reading evidence");

  if (!configuration(input)) return workflowFailure("workflow_topic_configuration", "explicit frozen versions, objective, policy and independent output allowance are required");

  const parsed = parseWorkflowTask(input.task);
  if (!parsed.ok) return parsed;

  const task = Object.freeze({ ...parsed.value, taskFamily: Object.freeze({ ...parsed.value.taskFamily }),
    ...(parsed.value.conditions === undefined ? {} : { conditions: Object.freeze({ ...parsed.value.conditions }) }) }), descriptor = Object.freeze({ ...input.descriptor });
  const objective = Object.freeze({ version: input.objective.version, utilityUnit: input.objective.utilityUnit,
    costBasis: input.objective.costBasis, utility: input.objective.utility.bind(input.objective), studyCost: input.objective.studyCost.bind(input.objective) });
  const rawPolicy = { conditionHash: input.policy.conditionHash, futureUses: input.policy.futureUses, utilityScale: input.policy.utilityScale,
    experimentUnits: input.policy.experimentUnits, deltaBounds: input.policy.deltaBounds, priorStrength: input.policy.priorStrength, priorWeights: input.policy.priorWeights,
    scope: task.scope, experimentRef: descriptor.ref, experimentVersion: descriptor.version, utilityUnit: objective.utilityUnit };
  if (!isEmpiricalTopicPolicy(rawPolicy)) return workflowFailure("workflow_topic_configuration", "a valid explicit empirical policy is required");

  const policy: EmpiricalTopicPolicy = Object.freeze({ ...rawPolicy, priorWeights: Object.freeze([...rawPolicy.priorWeights]), deltaBounds: Object.freeze({ ...rawPolicy.deltaBounds }) });
  const options: WorkflowTopicExperimentOptions = { boardRoot: input.boardRoot, baselineVersionId: input.baselineVersionId, candidateVersionId: input.candidateVersionId, task, descriptor,
    objective, policy, sourceCase: Object.freeze({ ...input.sourceCase }), outputAllowance: Object.freeze({ ...input.outputAllowance }),
    checkerVersion: input.checkerVersion, executionVersion: input.executionVersion, collect, signal, issuedAt: input.issuedAt, probeTimeoutMs: input.probeTimeoutMs,
    host: { executeOnce: input.host.executeOnce.bind(input.host), readRecords: input.host.readRecords.bind(input.host) },
    ...(input.available === undefined ? {} : { available: input.available.bind(input) }) };
  if (policy.conditionHash !== workflowTopicConditionHash(options)) return workflowFailure("workflow_topic_configuration", "condition identity must bind the frozen study protocol");

  const active = () => collect() && !signal.aborted;

  for (const versionId of [options.baselineVersionId, options.candidateVersionId]) {
    if (!active()) return workflowFailure("cancelled", "workflow experiment stopped before reading its version");
    const version = await readWorkflowVersion(options.boardRoot, versionId);
    if (!version.ok) return version;
    const selected = selectWorkflowPath(version.value, task);
    if (!selected.ok) return selected;
  }

  return { ok: true, value: registration(options, task, descriptor, policy, objective, active) };
}

function registration(options: WorkflowTopicExperimentOptions, task: WorkflowTask, descriptor: TopicExperimentDescriptor,
  policy: EmpiricalTopicPolicy, objective: WorkflowStudyObjective, active: () => boolean): TopicExperimentRegistration {
  const allowance = Object.freeze({ ...options.outputAllowance }), sourceCase = Object.freeze({ ...options.sourceCase });
  const host: WorkflowStudyHost = Object.freeze({ executeOnce: options.host.executeOnce.bind(options.host), readRecords: options.host.readRecords.bind(options.host) });
  const inputHash = contentHashOf(sourceCase.inputText), cache = new Map<string, { readonly binding: string; readonly outcome: TopicPairedOutcome }>();
  let admitted: { readonly binding: string; readonly promise: Promise<string> } | undefined;
  const arm = (name: "baseline" | "candidate"): WorkflowStudyArm => ({ arm: name,
    sessionId: `wfstudy-${contentHashOf([task.scope, allowance.grantId, name]).slice(0, 32)}`,
    versionId: name === "baseline" ? options.baselineVersionId : options.candidateVersionId, task, inputText: sourceCase.inputText, inputHash,
    hostDeclaredOutputGrantRef: allowance.grantId, maxOutputTokens: name === "baseline" ? allowance.baselineMaxOutputTokens : allowance.candidateMaxOutputTokens });

  async function pair(input: Parameters<TopicPairedProbe["run"]>[0], binding: string): Promise<string> {
    const evidence: VerifiedWorkflowStudyArm[] = [];
    const attempts = (["baseline", "candidate"] as const).map(name => ({ ...arm(name), status: "not_started", reason: undefined as string | undefined, feedbackVersionId: undefined as string | undefined }));
    let reason: string | undefined;

    try {
      for (const attempt of attempts) {
        attempt.status = "unknown";
        const result = await verifyWorkflowStudyArm({ boardRoot: options.boardRoot, arm: attempt, host, active, signal: input.signal, issuedAt: options.issuedAt });
        if (!result.ok) {
          reason = result.reason;
          attempt.reason = reason;
          break;
        }
        evidence.push(result.value);
        attempt.status = "verified";
        attempt.feedbackVersionId = result.value.feedbackVersionId;
      }
    } catch {
      reason = "workflow_topic_host_unknown";
      const pending = attempts.find(item => item.status === "unknown");
      if (pending !== undefined) pending.reason = reason;
    }

    if (!active() || input.signal.aborted) reason = "workflow_topic_stopped";

    let utilities: readonly (number | undefined)[] | undefined, fullStudyCost: number | undefined;

    if (reason === undefined && evidence.length === 2) {
      try { utilities = evidence.map(item => objective.utility(structuredClone(item)));
        fullStudyCost = objective.studyCost({ baseline: structuredClone(evidence[0]!), candidate: structuredClone(evidence[1]!) }); }
      catch { reason = "workflow_topic_objective_unknown"; }
      if (utilities?.some(value => !Number.isFinite(value)) || !Number.isFinite(fullStudyCost) || fullStudyCost! < 0
        || evidence[0]!.executionId === evidence[1]!.executionId) reason = "workflow_topic_measurement_unknown";
    }

    const provenanceJson = canonicalJson({ schemaVersion: 1, protocol: "workflow-frozen-pair-v1", binding: JSON.parse(binding) as unknown,
      sourceCaseId: sourceCase.id, inputHash, baselineVersionId: options.baselineVersionId, candidateVersionId: options.candidateVersionId,
      objective: { version: objective.version, unit: objective.utilityUnit, costBasis: objective.costBasis }, outputAllowance: allowance,
      attempts: attempts.map(item => ({ arm: item.arm, sessionId: item.sessionId, versionId: item.versionId, maxOutputTokens: item.maxOutputTokens,
        status: item.status, ...(item.reason === undefined ? {} : { reason: item.reason }), ...(item.feedbackVersionId === undefined ? {} : { feedbackVersionId: item.feedbackVersionId }) })),
      arms: evidence.map(item => ({ sessionId: item.sessionId, executionId: item.executionId, feedbackVersionId: item.feedbackVersionId,
        traceId: item.trace.traceId, traceHash: contentHashOf(item.trace), cost: item.trace.cost, budgetReceipt: item.trace.budgetReceipt })),
      ...(reason === undefined ? {} : { reason }) });
    if (provenanceJson.length > 16384) throw new Error("workflow_topic_provenance_capacity");

    const base = { scope: task.scope, experimentRef: descriptor.ref, experimentVersion: descriptor.version, conditionHash: policy.conditionHash,
      // A claim, a later bill or another trace snapshot cannot turn these same
      // physical executions into independent observations. The shared measurement
      // writer owns same-ID content/binding conflicts and explicit supersession.
      utilityUnit: objective.utilityUnit, measurementId: `workflow-pair:${contentHashOf([arm("baseline").sessionId, arm("candidate").sessionId])}`, provenanceJson,
      sourceRef: `${reason === undefined ? "checker" : "execution"}:${contentHashOf(JSON.parse(provenanceJson) as unknown)}` };
    const outcome: TopicPairedOutcome = reason === undefined && utilities !== undefined && fullStudyCost !== undefined
      ? { ...base, kind: "measured", baselineUtility: utilities[0]!, candidateUtility: utilities[1]!, fullStudyCost }
      : { ...base, kind: "unknown", reason: reason ?? "workflow_topic_measurement_unknown" };
    const ref = `workflow-pair:${contentHashOf([binding, base.sourceRef])}`;
    cache.set(ref, { binding, outcome });
    return ref;
  }

  const probe: TopicPairedProbe = {
    run(input) {
      if (!active() || input.signal.aborted) return Promise.reject(new Error("workflow_topic_stopped"));

      if (input.purpose !== "question" && input.purpose !== "calibration") return Promise.reject(new Error("workflow_topic_binding"));

      const expected = structuredClone(input.expected);
      const baseKeys = ["scope", "domain", "allocationId", "valuationId", "units", "spendId", "claimId", "checkerVersion", "executionVersion"];
      const decisionKeys = input.purpose === "question" && "decisionBasisHash" in expected ? ["decisionBasisHash"] : [];
      const decisionBasisHash = "decisionBasisHash" in expected ? expected.decisionBasisHash : undefined;
      const keys = [...baseKeys, ...(input.purpose === "question" ? ["questionId", "modelHash", ...decisionKeys] : ["purpose", "protocolHash"])];
      if (!fields(expected, keys) || expected.domain !== "workflow" || expected.scope !== task.scope || expected.units !== policy.experimentUnits || !sequence(expected.units)
        || expected.checkerVersion !== options.checkerVersion || expected.executionVersion !== options.executionVersion
        || ![expected.spendId, expected.claimId, expected.allocationId, expected.valuationId].every(identity)
        || (decisionKeys.length > 0 && (typeof decisionBasisHash !== "string" || !/^[a-f0-9]{64}$/.test(decisionBasisHash)))
        || (input.purpose === "question" && (input.topic.schemaVersion !== 3 || input.topic.experiment.ref !== descriptor.ref
          || input.topic.experiment.version !== descriptor.version || input.topic.topicId !== input.expected.questionId || input.topic.scope !== task.scope || input.topic.domain !== "workflow"
          || !("modelHash" in expected) || typeof expected.modelHash !== "string" || !/^[a-f0-9]{64}$/.test(expected.modelHash)))
        || (input.purpose === "calibration" && (!("protocolHash" in expected) || expected.purpose !== "calibration"
          || expected.protocolHash !== contentHashOf({ policy, checkerVersion: options.checkerVersion, executionVersion: options.executionVersion })
          || expected.valuationId !== `calibration:${expected.protocolHash}`))) {
        return Promise.reject(new Error("workflow_topic_binding"));
      }

      // This adapter checks an explicit pair; it has no workflow deployment-action
      // projection. Recognize the shared contract, then stop before host work.
      if (decisionKeys.length > 0) return Promise.reject(new Error("workflow_topic_deployment_projection_unbound"));

      const binding = canonicalJson(expected);

      if (admitted !== undefined) return admitted.binding === binding ? admitted.promise : Promise.reject(new Error("workflow_topic_output_grant_reused"));

      const accepted = { ...input, expected } as Parameters<TopicPairedProbe["run"]>[0];
      const promise = pair(accepted, binding);
      admitted = { binding, promise };
      return promise;
    },
    async read(ref, expected, signal) {
      if (!active() || signal.aborted) return undefined;
      const found = cache.get(ref);
      return found?.binding === canonicalJson(expected) ? found.outcome : undefined;
    },
  };
  const { scope: _scope, experimentRef: _ref, experimentVersion: _version, utilityUnit: _unit, ...registrationPolicy } = policy;

  return Object.freeze({ descriptor, policy: Object.freeze(registrationPolicy), checkerVersion: options.checkerVersion,
    executionVersion: options.executionVersion, probe, probeTimeoutMs: options.probeTimeoutMs,
    available: () => active() && admitted === undefined && (options.available?.() ?? true) });
}
