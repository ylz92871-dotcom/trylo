import type { SessionPort, SessionRecord } from "../../../../../ports/session.js";
import { isExecutionExtensionMetadata } from "../../../../../ports/execution-extension.js";
import type { WorkflowTask, WorkflowLearningResult } from "../domain/trace-contracts.js";
import { parseWorkflowTask, record, workflowFailure, text } from "../domain/trace-parse.js";
import { contentHashOf } from "../../../../control/hash.js";
import type { JsonObject } from "../../../../../protocol/envelope.js";
import type { WorkflowTrace } from "../domain/trace-contracts.js";
import { readWorkflowVersion, saveWorkflowTrace } from "./archive.js";
import { selectWorkflowPath } from "../domain/trace-learn.js";
import { createWorkflowExecution } from "./execution.js";

export type WorkflowRunNomination = {
  readonly versionId: string;
  readonly task: WorkflowTask;
  readonly conditionEvidenceRefs?: readonly string[];
};

export type WorkflowRunBudget = {
  readonly maxOutputTokens?: number; readonly maxIterations?: number; readonly maxCostUsd?: number;
  readonly inputPricePerMTok?: number; readonly outputPricePerMTok?: number;
};

export type WorkflowRunAdoption = WorkflowRunNomination & {
  readonly instanceId: string;
  readonly artifactHash: string;
  readonly adoptedBranchId?: string;
  readonly budget: WorkflowRunBudget;
};

const BUDGET_KEYS = ["maxOutputTokens", "maxIterations", "maxCostUsd", "inputPricePerMTok", "outputPricePerMTok"] as const;

export type WorkflowBudgetGrant = { readonly grantId: string; readonly tokens: number; readonly unknownReservation: number; readonly unknownRequests: readonly string[] };

export type WorkflowRunInstance = { readonly adoption: WorkflowRunAdoption; readonly startSequence: number; readonly grants: readonly WorkflowBudgetGrant[];
  readonly completion?: { readonly stepDigest: string; readonly terminalTurnId: string; readonly atSequence: number } };

export type WorkflowCheckpointInvalidation = { readonly nodeIds: readonly string[]; readonly stepDigest: string };

export type ResolvedWorkflowInstance = { readonly instance: WorkflowRunInstance; readonly trace: WorkflowTrace;
  readonly terminalTurnId: string | undefined; readonly completed: boolean };

/** The session journal is the only runtime writer. Board retains assets and
 * feedback; this immutable record binds one session to one adopted version. */
export function readWorkflowRunInstances(records: readonly SessionRecord[]): WorkflowLearningResult<readonly WorkflowRunInstance[]> {
  const instances: WorkflowRunInstance[] = [];

  for (const item of records) {
    if (item.type !== "execution_extension") continue;

    if (!isExecutionExtensionMetadata(item.payload)) return workflowFailure("invalid_extension", "execution extension metadata is corrupt");

    if (item.payload.owner !== "workflow") continue;

    const config = item.payload.configuration;
    if (config.kind === "checkpoint_invalidated") {
      const last = instances.at(-1);
      if (last === undefined || last.completion !== undefined || last.adoption.instanceId !== item.payload.instanceId || config.schemaVersion !== 1
        || typeof config.stepDigest !== "string" || !/^[a-f0-9]{64}$/.test(config.stepDigest) || !Array.isArray(config.nodeIds)
        || config.nodeIds.length === 0 || config.nodeIds.length > 128 || !config.nodeIds.every(text)
        || new Set(config.nodeIds).size !== config.nodeIds.length) return workflowFailure("invalid_checkpoint_invalidation", "checkpoint invalidations require an active instance and exact committed step digest");
      continue;
    }

    if (config.kind === "budget_grant") {
      const last = instances.at(-1);
      if (last === undefined || last.completion !== undefined || last.adoption.instanceId !== item.payload.instanceId
        || config.schemaVersion !== 1 || !text(config.grantId) || typeof config.tokens !== "number" || !Number.isSafeInteger(config.tokens) || config.tokens <= 0
        || typeof config.unknownReservation !== "number" || !Number.isSafeInteger(config.unknownReservation) || config.unknownReservation < 0
        || !Array.isArray(config.unknownRequests) || !config.unknownRequests.every(text)) return workflowFailure("invalid_budget_grant", "budget grants must address the active instance and retain explicit positive allowance and unknown reservation");

      const grant: WorkflowBudgetGrant = { grantId: config.grantId, tokens: config.tokens, unknownReservation: config.unknownReservation, unknownRequests: config.unknownRequests as string[] };
      const prior = last.grants.find(item => item.grantId === grant.grantId);
      if (prior !== undefined && contentHashOf(prior) !== contentHashOf(grant)) return workflowFailure("budget_grant_conflict", "a host grant id cannot be rewritten");

      if (prior === undefined) instances[instances.length - 1] = { ...last, grants: [...last.grants, grant] };

      continue;
    }

    if (config.kind === "completed") {
      const last = instances.at(-1);
      if (last === undefined || last.adoption.instanceId !== item.payload.instanceId || last.adoption.versionId !== config.versionId
        || config.schemaVersion !== 1 || typeof config.stepDigest !== "string" || !/^[a-f0-9]{64}$/.test(config.stepDigest) || !text(config.terminalTurnId)) {
        return workflowFailure("invalid_completion", "workflow completion must address the current adopted instance and its execution evidence");
      }

      const completion = { stepDigest: config.stepDigest, terminalTurnId: config.terminalTurnId, atSequence: item.sequence };
      if (last.completion !== undefined && (last.completion.stepDigest !== completion.stepDigest || last.completion.terminalTurnId !== completion.terminalTurnId)) return workflowFailure("completion_conflict", "completed instance evidence cannot change");

      instances[instances.length - 1] = { ...last, completion };
      continue;
    }

    const task = parseWorkflowTask(config.task);
    if (!task.ok || config.schemaVersion !== 1 || (config.kind !== undefined && config.kind !== "adoption") || !text(config.versionId)
      || typeof config.artifactHash !== "string" || !/^[a-f0-9]{64}$/.test(config.artifactHash) || !record(config.budget)
      || BUDGET_KEYS.some(key => config.budget !== undefined && record(config.budget) && config.budget[key] !== undefined
        && (typeof config.budget[key] !== "number" || !Number.isFinite(config.budget[key]) || config.budget[key] < 0))
      || (["maxOutputTokens", "maxIterations"] as const).some(key => record(config.budget) && config.budget[key] !== undefined
        && (typeof config.budget[key] !== "number" || !Number.isSafeInteger(config.budget[key]) || config.budget[key] <= 0))
      || (config.adoptedBranchId !== undefined && !text(config.adoptedBranchId))
      || (config.conditionEvidenceRefs !== undefined && (!Array.isArray(config.conditionEvidenceRefs) || !config.conditionEvidenceRefs.every(text)))) {
      return workflowFailure("invalid_adoption", "workflow adoption configuration is corrupt or unsupported");
    }

    const budget: Record<string, number> = {};

    for (const key of BUDGET_KEYS) if (typeof config.budget[key] === "number") budget[key] = config.budget[key];

    const parsed: WorkflowRunAdoption = { versionId: config.versionId, task: task.value, instanceId: item.payload.instanceId,
      artifactHash: config.artifactHash, budget,
      ...(typeof config.adoptedBranchId === "string" ? { adoptedBranchId: config.adoptedBranchId } : {}),
      ...(Array.isArray(config.conditionEvidenceRefs) ? { conditionEvidenceRefs: config.conditionEvidenceRefs as string[] } : {}) };
    const existing = instances.find(instance => instance.adoption.instanceId === parsed.instanceId);
    if (existing !== undefined) {
      if (contentHashOf(existing.adoption) !== contentHashOf(parsed)) return workflowFailure("adoption_conflict", "an adopted instance cannot change workflow versions, contexts or allowances");
      continue;
    }

    if (instances.at(-1) !== undefined && instances.at(-1)?.completion === undefined) return workflowFailure("adoption_conflict", "an unfinished workflow instance must be resumed before another is adopted");

    instances.push({ adoption: parsed, startSequence: item.sequence, grants: [] });
  }

  return { ok: true, value: instances };
}

export function readActiveWorkflowAdoption(records: readonly SessionRecord[]): WorkflowLearningResult<WorkflowRunAdoption | undefined> {
  const instances = readWorkflowRunInstances(records);
  if (!instances.ok) return instances;
  const last = instances.value.at(-1);
  return { ok: true, value: last?.completion === undefined ? last?.adoption : undefined };
}

export const workflowAdoptionFrom = readActiveWorkflowAdoption;

/** Completion is reconstructed from committed checks plus the real terminal;
 * the optional completion seal alone is never an authority to start new work.
 * This also closes the crash window between terminal commit and finish hook. */
export async function resolveLatestWorkflowInstance(boardRoot: string, records: readonly SessionRecord[]): Promise<WorkflowLearningResult<ResolvedWorkflowInstance | undefined>> {
  const loaded = readWorkflowRunInstances(records);
  if (!loaded.ok) return loaded;

  const instance = loaded.value.at(-1);
  if (instance === undefined) return { ok: true as const, value: undefined };

  const asset = await readWorkflowVersion(boardRoot, instance.adoption.versionId);
  if (!asset.ok) return asset;

  if (contentHashOf(asset.value) !== instance.adoption.artifactHash) return workflowFailure("adoption_conflict", "the frozen workflow content changed");

  const selected = selectWorkflowPath(asset.value, instance.adoption.task);
  if (!selected.ok) return selected;

  if (selected.value.adoptedBranchId !== instance.adoption.adoptedBranchId) return workflowFailure("adoption_conflict", "the frozen branch changed");

  const history = records.filter(record => record.sequence > instance.startSequence && (instance.completion === undefined || record.sequence < instance.completion.atSequence));
  const sessionId = records[0]?.sessionId;
  if (sessionId === undefined) return workflowFailure("adoption_session_missing", "adopted execution has no session identity");

  const execution = createWorkflowExecution({ artifact: selected.value.artifact, versionId: instance.adoption.versionId,
    traceId: instance.adoption.instanceId, executionId: instance.adoption.instanceId, sessionId, resumeRecords: history,
    ...(instance.adoption.adoptedBranchId === undefined ? {} : { adoptedBranchId: instance.adoption.adoptedBranchId }),
    ...(instance.adoption.task.conditions === undefined ? {} : { conditions: instance.adoption.task.conditions,
      conditionEvidenceRefs: instance.adoption.conditionEvidenceRefs ?? [`session:${sessionId}/workflow:${instance.adoption.instanceId}/task`] }) });
  const projected = execution.trace();
  const terminalTurnId = [...history].reverse().find(item => item.type === "terminal"
    || (item.type === "envelope" && record(item.payload.envelope) && item.payload.envelope.kind === "terminal" && item.payload.envelope.producerId === "loop"))?.turnId;
  const latestFact = [...history].reverse().find(item => item.type === "turn_start" || item.type === "turn_input"
    || item.type === "terminal" || (item.type === "envelope" && record(item.payload.envelope) && item.payload.envelope.producerId === "loop"));
  const budgetTrace = workflowBudgetTrace(projected, instance.adoption.budget, instance.grants, execution.accounting());
  // A later interrupted turn or committed invalidation is a new immutable
  // snapshot, while another collection of exactly the same facts is idempotent.
  const trace = { ...budgetTrace, traceId: `workflow-feedback:${contentHashOf([instance.adoption.instanceId,
    latestFact?.turnId ?? "interrupted", terminalTurnId ?? null, contentHashOf(projected.steps), budgetTrace,
    latestFact?.turnId === terminalTurnId ? null : latestFact?.sequence ?? 0])}` };
  if (instance.completion !== undefined && (trace.outcome !== "success" || contentHashOf(trace.steps) !== instance.completion.stepDigest
    || terminalTurnId !== instance.completion.terminalTurnId)) return workflowFailure("invalid_completion", "completion does not match committed checkpoints and terminal evidence");

  return { ok: true as const, value: { instance, trace, terminalTurnId, completed: trace.outcome === "success" } };
}

/** Both ordinary finish and explicit crash recovery archive the same journal fact. */
export async function persistWorkflowInstanceFeedback(boardRoot: string, resolved: ResolvedWorkflowInstance, issuedAt: string) {
  const saved = await saveWorkflowTrace(boardRoot, resolved.trace, issuedAt);
  return saved.ok ? { ok: true as const, value: { ...saved.value, trace: resolved.trace } } : saved;
}

export function workflowBudgetTrace(trace: WorkflowTrace, budget: WorkflowRunBudget, grants: readonly WorkflowBudgetGrant[],
  usage: { readonly outputTokens: number; readonly usageUncertain: boolean }): WorkflowTrace {
  if (budget.maxOutputTokens === undefined) return trace;
  const grantedTokens = grants.reduce((sum, grant) => sum + grant.tokens, 0);
  const reservedUnknownTokens = grants.reduce((sum, grant) => sum + grant.unknownReservation, 0);
  return { ...trace, budgetReceipt: { initialTokens: budget.maxOutputTokens, grantedTokens, observedOutputTokens: usage.outputTokens,
    reservedUnknownTokens, remainingTokens: Math.max(0, budget.maxOutputTokens + grantedTokens - reservedUnknownTokens - usage.outputTokens), usageUncertain: usage.usageUncertain } };
}

export async function commitWorkflowCheckpointInvalidation(session: SessionPort, sessionId: string, adoption: WorkflowRunAdoption,
  invalidation: WorkflowCheckpointInvalidation, at: string) {
  return session.append({ type: "execution_extension", sessionId, at, payload: { schemaVersion: 1, owner: "workflow", instanceId: adoption.instanceId,
    configuration: { schemaVersion: 1, kind: "checkpoint_invalidated", nodeIds: [...invalidation.nodeIds], stepDigest: invalidation.stepDigest } } });
}

export async function resolveActiveWorkflowAdoption(boardRoot: string, records: readonly SessionRecord[]): Promise<WorkflowLearningResult<WorkflowRunAdoption | undefined>> {
  const latest = await resolveLatestWorkflowInstance(boardRoot, records);
  return latest.ok ? { ok: true, value: latest.value === undefined || latest.value.completed ? undefined : latest.value.instance.adoption } : latest;
}

export async function commitWorkflowAdoption(session: SessionPort, sessionId: string, adoption: WorkflowRunAdoption, at: string) {
  const configuration: JsonObject = JSON.parse(JSON.stringify({ schemaVersion: 1, kind: "adoption", versionId: adoption.versionId,
    artifactHash: adoption.artifactHash, task: adoption.task, budget: adoption.budget,
    ...(adoption.adoptedBranchId === undefined ? {} : { adoptedBranchId: adoption.adoptedBranchId }),
    ...(adoption.conditionEvidenceRefs === undefined ? {} : { conditionEvidenceRefs: adoption.conditionEvidenceRefs }) }));
  return session.append({ type: "execution_extension", sessionId, at,
    payload: { schemaVersion: 1, owner: "workflow", instanceId: adoption.instanceId, configuration } });
}

export async function completeWorkflowAdoption(session: SessionPort, sessionId: string, adoption: WorkflowRunAdoption,
  trace: WorkflowTrace, terminalTurnId: string, at: string) {
  if (trace.outcome !== "success" || trace.workflowVersionId !== adoption.versionId
    || (trace.executionId !== undefined && trace.executionId !== adoption.instanceId)) return { ok: false as const, code: "workflow_not_verified" };
  return session.append({ type: "execution_extension", sessionId, at, payload: { schemaVersion: 1, owner: "workflow",
    instanceId: adoption.instanceId, configuration: { schemaVersion: 1, kind: "completed", versionId: adoption.versionId,
      stepDigest: contentHashOf(trace.steps), terminalTurnId } } });
}

/** Only the host composition root calls this; no model-facing tool owns grants. */
export async function commitWorkflowBudgetGrant(session: SessionPort, sessionId: string, adoption: WorkflowRunAdoption,
  grant: WorkflowBudgetGrant, at: string) {
  return session.append({ type: "execution_extension", sessionId, at, payload: { schemaVersion: 1, owner: "workflow",
    instanceId: adoption.instanceId, configuration: { schemaVersion: 1, kind: "budget_grant", ...grant } } });
}
