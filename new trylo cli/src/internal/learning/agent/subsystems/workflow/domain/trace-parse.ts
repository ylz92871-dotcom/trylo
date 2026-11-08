import { isDeepStrictEqual } from "node:util";
import { parseTaskFamily } from "../../../../domains/shared/parse.js";
import { scanForbiddenBody } from "../../../../domains/shared/forbidden-scan.js";
import { learnWorkflow } from "./trace-learn.js";
import { learnWorkflowV1 } from "./trace-legacy.js";
import type {
  WorkflowCorrection, WorkflowEvidenceWindow, WorkflowLearningArtifact, WorkflowLearningRequest,
  WorkflowLearningResult, WorkflowStep, WorkflowTask, WorkflowTrace,
} from "./trace-contracts.js";

export function workflowFailure(code: string, message: string) {
  return { ok: false as const, code, message };
}

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 4096;
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 128 && value.every(text) && new Set(value).size === value.length;
}

function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function stringMap(value: unknown, maxEntries = 16): value is Record<string, string> {
  return record(value) && Object.keys(value).length <= maxEntries
    && Object.entries(value).every(([key, item]) => key.length > 0 && key.length <= 128
      && !["__proto__", "constructor", "prototype"].includes(key) && text(item));
}

export function parseWorkflowTask(value: unknown): WorkflowLearningResult<WorkflowTask> {
  if (!record(value) || !text(value.scope)
    || (value.conditions !== undefined && !stringMap(value.conditions))) return workflowFailure("invalid_task", "scope and bounded condition premises are required");

  const declared = value.taskFamily;
  if (!record(declared) || ["id", "intentClass", "checkKind"].some(key => !text(declared[key]))
    || ["language", "repoKind", "checkSchema"].some(key => declared[key] !== undefined && !text(declared[key]))) {
    return workflowFailure("invalid_task", "all declared family premises must be bounded non-empty strings");
  }

  const family = parseTaskFamily(value.taskFamily);

  return family.ok ? { ok: true, value: { scope: value.scope, taskFamily: family.value,
    ...(value.conditions === undefined ? {} : { conditions: { ...value.conditions } }) } }
    : workflowFailure("invalid_task", family.reason);
}

function parseStep(value: unknown): WorkflowLearningResult<WorkflowStep> {
  if (!record(value) || !text(value.nodeId) || !text(value.input) || !text(value.output) || !text(value.check)
    || !strings(value.dependsOn) || !strings(value.evidenceRefs) || value.evidenceRefs.length === 0
    || (value.status !== "passed" && value.status !== "failed")
    || (value.recoveryTo !== undefined && !text(value.recoveryTo))
    || (value.inputBindings !== undefined && !stringMap(value.inputBindings, 128))
    || (value.outputDigest !== undefined && (typeof value.outputDigest !== "string" || !/^[a-f0-9]{64}$/.test(value.outputDigest)))) {
    return workflowFailure("invalid_step", "each step needs bounded IO, dependencies, check, status and evidence references");
  }
  return { ok: true, value: { nodeId: value.nodeId, input: value.input, output: value.output,
    dependsOn: [...value.dependsOn], check: value.check, status: value.status, evidenceRefs: [...value.evidenceRefs],
    ...(value.recoveryTo === undefined ? {} : { recoveryTo: value.recoveryTo }),
    ...(value.inputBindings === undefined ? {} : { inputBindings: { ...value.inputBindings } }),
    ...(value.outputDigest === undefined ? {} : { outputDigest: value.outputDigest }) } };
}

function otherFailures(value: unknown): value is NonNullable<WorkflowTrace["otherFailures"]> {
  return Array.isArray(value) && value.length <= 128
    && value.every(item => record(item) && text(item.toolCallId) && text(item.command) && text(item.evidenceRef))
    && new Set(value.map(item => item.evidenceRef)).size === value.length;
}

function budgetReceipt(value: unknown): value is NonNullable<WorkflowTrace["budgetReceipt"]> {
  if (!record(value) || !positive(value.initialTokens) || typeof value.usageUncertain !== "boolean"
    || [value.grantedTokens, value.observedOutputTokens, value.reservedUnknownTokens, value.remainingTokens]
      .some(item => typeof item !== "number" || !Number.isSafeInteger(item) || item < 0)) return false;
  const total = value.initialTokens + Number(value.grantedTokens);
  return Number.isSafeInteger(total) && value.remainingTokens === Math.max(0, total - Number(value.observedOutputTokens) - Number(value.reservedUnknownTokens));
}

export function parseWorkflowTrace(value: unknown): WorkflowLearningResult<WorkflowTrace> {
  const task = parseWorkflowTask(value);
  if (!task.ok) return task;

  if (!record(value) || value.schemaVersion !== 1 || !text(value.traceId)
    || (value.source !== "imported" && value.source !== "runtime") || !Array.isArray(value.steps) || value.steps.length > 256
    || !["success", "failure", "unknown"].includes(String(value.outcome))
    || (value.workflowVersionId !== undefined && !text(value.workflowVersionId))
    || [value.adoptedBranchId, value.sessionId, value.executionId].some(item => item !== undefined && !text(item))
    || (value.conditionEvidenceRefs !== undefined && !strings(value.conditionEvidenceRefs))
    || (value.otherFailures !== undefined && !otherFailures(value.otherFailures))
    || (value.budgetReceipt !== undefined && !budgetReceipt(value.budgetReceipt))
    || (task.value.conditions !== undefined && Object.keys(task.value.conditions).length > 0
      && (!strings(value.conditionEvidenceRefs) || value.conditionEvidenceRefs.length === 0))
    || (value.runState !== undefined && !["running", "waiting", "cancelled", "budget_exhausted", "interrupted", "completed", "failed"].includes(String(value.runState)))
    || (value.cost !== undefined && (!record(value.cost) || !Number.isSafeInteger(value.cost.tokens) || Number(value.cost.tokens) < 0
      || !Number.isSafeInteger(value.cost.wallMs) || Number(value.cost.wallMs) < 0))) {
    return workflowFailure("invalid_trace", "unsupported trace format (v1 required)");
  }

  const steps: WorkflowStep[] = [];
  const passed = new Set<string>();
  const contracts = new Map<string, WorkflowStep>();
  let recovery: string | undefined;

  for (const item of value.steps) {
    const step = parseStep(item);
    if (!step.ok) return step;

    if (step.value.dependsOn.some(id => !passed.has(id)) || step.value.dependsOn.includes(step.value.nodeId)) {
      return workflowFailure("invalid_dependency", "dependencies must refer to earlier passed nodes");
    }

    if (step.value.inputBindings !== undefined && (Object.keys(step.value.inputBindings).length !== step.value.dependsOn.length
      || step.value.dependsOn.some(id => step.value.inputBindings?.[id] !== contracts.get(id)?.output))) {
      return workflowFailure("invalid_input_binding", "declared inputs must bind every dependency's latest passed output");
    }

    const previous = contracts.get(step.value.nodeId);
    if (previous !== undefined && (!isDeepStrictEqual(previous.dependsOn, step.value.dependsOn) || previous.check !== step.value.check)) {
      return workflowFailure("node_contract_drift", "a node's dependencies and check cannot change within one frozen trace");
    }

    if (recovery !== undefined && recovery !== step.value.nodeId) return workflowFailure("invalid_recovery", "the next step must follow the recorded recovery target");

    contracts.set(step.value.nodeId, step.value);
    const invalidated = new Set([step.value.nodeId]);

    for (let round = 0; round < contracts.size; round += 1) {
      for (const known of contracts.values()) if (known.dependsOn.some(id => invalidated.has(id))) invalidated.add(known.nodeId);
    }

    for (const id of invalidated) passed.delete(id);

    steps.push(step.value);

    if (step.value.status === "passed") passed.add(step.value.nodeId);
    else passed.delete(step.value.nodeId);

    recovery = step.value.status === "failed" ? step.value.recoveryTo : undefined;
  }

  if (value.outcome === "success" && (steps.length === 0 || steps.at(-1)?.status !== "passed"
    || passed.size !== contracts.size || recovery !== undefined || (value.runState !== undefined && value.runState !== "completed"))) {
    return workflowFailure("unverified_success", "success requires every failed node to be retried successfully");
  }

  if (scanForbiddenBody(steps.flatMap(step => [step.input, step.output, step.check, step.nodeId, step.recoveryTo ?? ""])).length > 0) {
    return workflowFailure("forbidden_payload", "workflow facts cannot carry authority or installation instructions");
  }

  return { ok: true, value: { ...task.value, schemaVersion: 1, traceId: value.traceId, source: value.source,
    steps, outcome: value.outcome as WorkflowTrace["outcome"],
    ...(value.workflowVersionId === undefined ? {} : { workflowVersionId: value.workflowVersionId }),
    ...(value.conditionEvidenceRefs === undefined ? {} : { conditionEvidenceRefs: [...value.conditionEvidenceRefs] }),
    ...(value.adoptedBranchId === undefined ? {} : { adoptedBranchId: String(value.adoptedBranchId) }),
    ...(value.sessionId === undefined ? {} : { sessionId: String(value.sessionId) }),
    ...(value.executionId === undefined ? {} : { executionId: String(value.executionId) }),
    ...(value.otherFailures === undefined ? {} : { otherFailures: value.otherFailures.map(failure => ({
      toolCallId: failure.toolCallId, command: failure.command, evidenceRef: failure.evidenceRef })) }),
    ...(value.budgetReceipt === undefined ? {} : { budgetReceipt: { ...value.budgetReceipt } }),
    ...(value.runState === undefined ? {} : { runState: value.runState as WorkflowTrace["runState"] & string }),
    ...(value.cost === undefined ? {} : { cost: { tokens: Number((value.cost as Record<string, unknown>).tokens), wallMs: Number((value.cost as Record<string, unknown>).wallMs) } }) } };
}

function parseCorrection(value: unknown): WorkflowLearningResult<WorkflowCorrection> {
  if (!record(value) || !text(value.reason) || !text(value.nodeId) || !text(value.check)
    || (value.recoveryTo !== undefined && !text(value.recoveryTo))
    || (value.when !== undefined && !stringMap(value.when))
    || scanForbiddenBody([JSON.stringify(value)]).length > 0) return workflowFailure("invalid_correction", "correction needs a bounded reason, node and check");
  return { ok: true, value: { reason: value.reason, nodeId: value.nodeId, check: value.check,
    ...(value.recoveryTo === undefined ? {} : { recoveryTo: value.recoveryTo }),
    ...(value.when === undefined ? {} : { when: { ...value.when } }) } };
}

export function parseWorkflowLearningRequest(value: unknown, origin: "external" | "archive" = "external"): WorkflowLearningResult<WorkflowLearningRequest> {
  const task = parseWorkflowTask(value);
  if (!task.ok) return task;

  if (!record(value) || value.subsystem !== "workflow" || !text(value.requestId) || typeof value.collect !== "boolean"
    || !record(value.budget) || !positive(value.budget.maxEpisodes) || value.budget.maxEpisodes > 128
    || !positive(value.budget.maxSteps) || value.budget.maxSteps > 8192 || !positive(value.budget.maxTokens) || value.budget.maxTokens > 262144
    || (value.budget.maxRounds !== undefined && (!positive(value.budget.maxRounds) || value.budget.maxRounds > 32))
    || !Array.isArray(value.traces) || value.traces.length > 128
    || (value.parentVersionId !== undefined && !text(value.parentVersionId))) {
    return workflowFailure("invalid_request", "workflow nomination, collection choice, bounded budget and traces are required");
  }

  const traces: WorkflowTrace[] = [];

  for (const raw of value.traces) {
    const trace = parseWorkflowTrace(raw);
    if (!trace.ok) return trace;
    if (origin === "external" && trace.value.source === "runtime") return workflowFailure("invalid_trace_source", "external traces must be labelled imported; runtime feedback is collected from Board");
    traces.push(trace.value);
  }

  const correction = value.correction === undefined ? undefined : parseCorrection(value.correction);
  if (correction !== undefined && !correction.ok) return correction;

  const evidenceWindow = parseEvidenceWindow(value, traces, origin);
  if (!evidenceWindow.ok) return evidenceWindow;

  return { ok: true, value: { ...task.value, subsystem: "workflow", requestId: value.requestId, collect: value.collect,
    budget: { maxEpisodes: value.budget.maxEpisodes, maxSteps: value.budget.maxSteps, maxTokens: value.budget.maxTokens,
      ...(value.budget.maxRounds === undefined ? {} : { maxRounds: value.budget.maxRounds }) }, traces,
    ...(value.parentVersionId === undefined ? {} : { parentVersionId: value.parentVersionId }),
    ...(evidenceWindow.value === undefined ? {} : { evidenceWindow: evidenceWindow.value }),
    ...(correction === undefined ? {} : { correction: correction.value }) } };
}

function parseEvidenceWindow(value: Record<string, unknown>, traces: readonly WorkflowTrace[], origin: "external" | "archive"): WorkflowLearningResult<WorkflowEvidenceWindow | undefined> {
  const window = value.evidenceWindow;
  if (window === undefined) return { ok: true, value: undefined };

  if (origin === "external" || !record(window) || !text(window.parentVersionId)
    || window.parentVersionId !== value.parentVersionId || window.statisticsScope !== "window"
    || !strings(window.retainedTraceIds) || !isDeepStrictEqual(window.retainedTraceIds, traces.map(trace => trace.traceId))
    || !Array.isArray(window.omittedRefs) || window.omittedRefs.length > 8192
    || window.omittedRefs.some(ref => typeof ref !== "string" || ref.length === 0 || ref.length > 8192)
    || new Set(window.omittedRefs).size !== window.omittedRefs.length) {
    return workflowFailure("invalid_evidence_window", "only internal lineage-bound windows with exact retained trace identities are accepted");
  }

  return { ok: true, value: { parentVersionId: window.parentVersionId, statisticsScope: "window",
    retainedTraceIds: [...window.retainedTraceIds], omittedRefs: [...window.omittedRefs] } };
}

/** Rebuild derived fields on read; a malformed or changed graph fails closed. */
export function parseWorkflowLearningArtifact(value: unknown): WorkflowLearningResult<WorkflowLearningArtifact> {
  if (!record(value) || value.type !== "workflow_learning" || (value.schemaVersion !== 1 && value.schemaVersion !== 2)
    || (value.mode !== "path" && value.mode !== "lessons_only") || !Array.isArray(value.nodes) || !Array.isArray(value.recovery)
    || !strings(value.positiveEvidenceRefs) || !strings(value.negativeEvidenceRefs)) {
    return workflowFailure("invalid_artifact", "unsupported workflow learning asset");
  }

  const request = parseWorkflowLearningRequest({ ...value, subsystem: "workflow", collect: true,
    budget: { maxEpisodes: 128, maxSteps: 8192, maxTokens: 262144,
      ...(value.schemaVersion === 2 && record(value.learning) ? { maxRounds: value.learning.maxRounds } : {}) } }, "archive");
  if (!request.ok) return request;

  if (value.schemaVersion === 2 && (!Array.isArray(value.branches) || !record(value.learning)
    || !positive(value.learning.maxRounds) || value.learning.maxRounds > 32)) return workflowFailure("invalid_artifact", "V2 requires conditional branches and its bounded learning ledger");

  // V2 correction assets written before check provenance retain their original
  // bytes/hash. The compiler derives the missing disclosure without upgrading
  // legacy baseline costs or old successes into new-check evidence.
  const compatibility = value.correction !== undefined && Array.isArray(value.branches)
    && !value.branches.some(branch => record(branch) && branch.checkProvenance !== undefined) ? "legacy_correction" : "current";
  const derived = value.schemaVersion === 1 ? learnWorkflowV1(request.value) : learnWorkflow(request.value, compatibility);
  if (!derived.ok) return derived;

  for (const key of ["nodes", "recovery", "positiveEvidenceRefs", "negativeEvidenceRefs", "mode"] as const) {
    if (!isDeepStrictEqual(value[key], derived.value[key])) return workflowFailure("invalid_artifact", `derived ${key} does not match its evidence`);
  }

  if (value.schemaVersion === 2 && (!isDeepStrictEqual(value.branches, derived.value.branches)
    || !isDeepStrictEqual(value.learning, derived.value.learning))) return workflowFailure("invalid_artifact", "conditional branches or statistics differ from their execution evidence");

  return derived;
}
