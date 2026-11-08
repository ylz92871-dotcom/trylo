import type { WorkflowLearningResult, WorkflowTask } from "../domain/trace-contracts.js";
import { parseWorkflowTask, record, text, workflowFailure } from "../domain/trace-parse.js";
import type { WorkflowObservedMutation, WorkflowObservedTurn } from "./model-port.js";
import { contentHashOf } from "../../../../control/hash.js";

export type WorkflowJobAllowance = { readonly grantId: string; readonly maxCalls: number; readonly maxTokens: number };

type InputIdentity = {
  readonly jobId: string; readonly scope: string; readonly sessionId: string; readonly turnId: string;
  readonly allowance: WorkflowJobAllowance;
  readonly retryOf?: { readonly jobId: string; readonly attempt: number };
};

export type WorkflowAutomaticInput = InputIdentity & (
  | { readonly purpose: "classify"; readonly promptHash: string; readonly task?: never; readonly observed?: never;
      readonly sourceTurnId?: string; readonly journalWatermark?: number }
  | { readonly purpose: "segment" | "revise"; readonly task: WorkflowTask; readonly observed?: WorkflowObservedTurn; readonly promptHash?: never; readonly parentVersionId?: string }
);

export type WorkflowJobOutcome =
  | { readonly kind: "classified"; readonly task: WorkflowTask }
  | { readonly kind: "learned"; readonly versionId: string }
  | { readonly kind: "abstained" | "failed" | "cancelled" | "budget_exhausted"; readonly code: string };

export type WorkflowJobUsage = {
  readonly calls: number; readonly tokens: number;
  readonly observedTokens?: number; readonly uncertain?: boolean;
};

export type WorkflowJobClaim = {
  readonly jobId: string; readonly attempt: number; readonly inputVersionId: string;
  readonly inputHash: string; readonly input: WorkflowAutomaticInput;
};

export const WORKFLOW_JOB_MAX_ATTEMPTS = 8;
export const workflowTerminalRetryId = (jobId: string, attempt: number, grantId: string) => `wflj_${contentHashOf([jobId, attempt, grantId]).slice(0, 32)}`;

export function workflowJobPremises(input: WorkflowAutomaticInput): unknown {
  const { jobId: _job, allowance: _allowance, retryOf: _retry, ...premises } = input;
  return premises;
}

export const jobInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function keys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key));
}

export function parseWorkflowJobAllowance(value: unknown, mode: "funded" | "deferred" = "funded"): WorkflowLearningResult<WorkflowJobAllowance> {
  const deferred = mode === "deferred" && record(value) && value.maxCalls === 0 && value.maxTokens === 0;
  if (!record(value) || !keys(value, ["grantId", "maxCalls", "maxTokens"]) || !text(value.grantId)
    || !jobInteger(value.maxCalls) || (!deferred && value.maxCalls < 1) || value.maxCalls > 16
    || !jobInteger(value.maxTokens) || (!deferred && value.maxTokens < 1) || value.maxTokens > 262144) {
    return workflowFailure("invalid_allowance", "a grant needs an identity, 1..16 calls and 1..262144 tokens");
  }

  return { ok: true, value: { grantId: value.grantId, maxCalls: value.maxCalls, maxTokens: value.maxTokens } };
}

/** tokens is the charged/reserved quota; observedTokens is the measured lower bound. */
export function parseWorkflowJobUsage(value: unknown): WorkflowLearningResult<WorkflowJobUsage> {
  if (!record(value) || !keys(value, ["calls", "tokens", "observedTokens", "uncertain"]) || !jobInteger(value.calls) || !jobInteger(value.tokens)
    || (value.observedTokens !== undefined && (!jobInteger(value.observedTokens) || value.observedTokens > value.tokens))
    || (value.uncertain !== undefined && typeof value.uncertain !== "boolean")) {
    return workflowFailure("invalid_job_usage", "quota charge and measured token lower bound must be distinct nonnegative counts");
  }
  return { ok: true, value: { calls: value.calls, tokens: value.tokens,
    ...(value.observedTokens === undefined ? {} : { observedTokens: value.observedTokens }),
    ...(value.uncertain === undefined ? {} : { uncertain: value.uncertain }) } };
}

/** Accept only the already-redacted observation vocabulary, never arbitrary JSON. */
function parseArtifactFacts(value: unknown): WorkflowLearningResult<WorkflowObservedMutation[]> {
  if (!Array.isArray(value)) return workflowFailure("invalid_observation", "artifact facts must be an array");

  const result: WorkflowObservedMutation[] = [];

  for (const item of value) {
    if (!record(item) || !keys(item, ["toolCallId", "path", "evidenceRef", "sequence"])
      || !text(item.toolCallId) || !text(item.path) || !text(item.evidenceRef) || !jobInteger(item.sequence)) {
      return workflowFailure("invalid_observation", "malformed artifact receipt");
    }
    result.push({ toolCallId: item.toolCallId, path: item.path, evidenceRef: item.evidenceRef, sequence: item.sequence });
  }

  return { ok: true, value: result };
}

function parseObserved(value: unknown): WorkflowLearningResult<WorkflowObservedTurn> {
  if (!record(value) || !keys(value, ["sessionId", "turnId", "checks", "mutations", "artifacts", "terminal", "tokens", "wallMs", "usageUncertain"])
    || !text(value.sessionId) || !text(value.turnId) || !Array.isArray(value.checks) || !Array.isArray(value.mutations)
    || (value.artifacts !== undefined && !Array.isArray(value.artifacts))
    || value.checks.length + value.mutations.length + (Array.isArray(value.artifacts) ? value.artifacts.length : 0) > 128
    || !jobInteger(value.tokens) || !jobInteger(value.wallMs) || (value.usageUncertain !== undefined && typeof value.usageUncertain !== "boolean")
    || !["completed", "failed", "cancelled", "unknown"].includes(String(value.terminal))) {
    return workflowFailure("invalid_observation", "expected bounded redacted execution facts");
  }

  const checks: WorkflowObservedTurn["checks"][number][] = [];

  for (const item of value.checks) {
    if (!record(item) || !keys(item, ["toolCallId", "command", "status", "evidenceRef", "sequence"])
      || !text(item.toolCallId) || !text(item.command) || !text(item.evidenceRef) || !jobInteger(item.sequence)
      || (item.status !== "passed" && item.status !== "failed")) return workflowFailure("invalid_observation", "malformed checker receipt");
    checks.push({ toolCallId: item.toolCallId, command: item.command, status: item.status, evidenceRef: item.evidenceRef, sequence: item.sequence });
  }

  const mutations = parseArtifactFacts(value.mutations);
  if (!mutations.ok) return mutations;

  const artifacts = value.artifacts === undefined ? undefined : parseArtifactFacts(value.artifacts);
  if (artifacts !== undefined && !artifacts.ok) return artifacts;

  return { ok: true, value: { sessionId: value.sessionId, turnId: value.turnId, checks, mutations: mutations.value,
    ...(artifacts === undefined ? {} : { artifacts: artifacts.value }),
    terminal: value.terminal as WorkflowObservedTurn["terminal"], tokens: value.tokens, wallMs: value.wallMs,
    ...(value.usageUncertain === undefined ? {} : { usageUncertain: value.usageUncertain }) } };
}

export function parseWorkflowAutomaticInput(value: unknown): WorkflowLearningResult<WorkflowAutomaticInput> {
  if (!record(value) || !keys(value, ["jobId", "purpose", "scope", "sessionId", "turnId", "allowance", "task", "observed", "promptHash", "retryOf", "parentVersionId", "sourceTurnId", "journalWatermark"])
    || !text(value.jobId) || !text(value.scope) || !text(value.sessionId) || !text(value.turnId)) {
    return workflowFailure("invalid_job_input", "only fixed workflow job coordinates and redacted facts are accepted");
  }

  const allowance = parseWorkflowJobAllowance(value.allowance, value.purpose === "classify" ? "funded" : "deferred");
  if (!allowance.ok) return allowance;

  const retry = value.retryOf;
  if (retry !== undefined && (!record(retry) || !keys(retry, ["jobId", "attempt"]) || !text(retry.jobId)
    || retry.jobId === value.jobId || !jobInteger(retry.attempt) || retry.attempt < 1 || retry.attempt > WORKFLOW_JOB_MAX_ATTEMPTS)) {
    return workflowFailure("invalid_job_input", "retry provenance requires a different job and a bounded attempt");
  }

  const identity: InputIdentity = { jobId: value.jobId, scope: value.scope, sessionId: value.sessionId,
    turnId: value.turnId, allowance: allowance.value,
    ...(record(retry) && text(retry.jobId) && jobInteger(retry.attempt) ? { retryOf: { jobId: retry.jobId, attempt: retry.attempt } } : {}) };

  if (value.purpose === "classify") {
    if (typeof value.promptHash !== "string" || !/^[a-f0-9]{64}$/.test(value.promptHash)
      || value.turnId !== `input:${value.promptHash}` || value.task !== undefined || value.observed !== undefined || value.parentVersionId !== undefined) {
      return workflowFailure("invalid_job_input", "classification stores only a SHA256 prompt hash and matching input turn coordinate");
    }

    if ((value.sourceTurnId !== undefined && (!text(value.sourceTurnId) || value.journalWatermark === undefined))
      || (value.journalWatermark !== undefined && !jobInteger(value.journalWatermark))) {
      return workflowFailure("invalid_job_input", "classification source coordinates must name a bounded turn and journal watermark");
    }

    return { ok: true, value: { ...identity, purpose: "classify", promptHash: value.promptHash,
      ...(value.sourceTurnId === undefined ? {} : { sourceTurnId: value.sourceTurnId }),
      ...(value.journalWatermark === undefined ? {} : { journalWatermark: value.journalWatermark }) } };
  }

  if ((value.purpose !== "segment" && value.purpose !== "revise") || value.promptHash !== undefined || value.sourceTurnId !== undefined || value.journalWatermark !== undefined) {
    return workflowFailure("invalid_job_input", "unknown workflow job purpose");
  }

  if ((value.purpose === "revise" && !text(value.parentVersionId)) || (value.parentVersionId !== undefined && !text(value.parentVersionId))) {
    return workflowFailure("invalid_job_input", "revision requires its immutable parent workflow version");
  }

  const task = parseWorkflowTask(value.task);
  if (!task.ok) return task;

  if (task.value.scope !== identity.scope) return workflowFailure("invalid_job_input", "job and task scope must match exactly");

  const observed = value.observed === undefined ? undefined : parseObserved(value.observed);
  if (observed !== undefined && !observed.ok) return observed;

  if (observed !== undefined && (observed.value.sessionId !== identity.sessionId || observed.value.turnId !== identity.turnId)) {
    return workflowFailure("invalid_job_input", "observation cannot cross session or turn boundaries");
  }

  return { ok: true, value: { ...identity, purpose: value.purpose, task: task.value,
    ...(value.parentVersionId === undefined ? {} : { parentVersionId: value.parentVersionId }),
    ...(observed === undefined ? {} : { observed: observed.value }) } };
}

export function parseWorkflowJobOutcome(value: unknown, input: WorkflowAutomaticInput): WorkflowLearningResult<WorkflowJobOutcome> {
  if (!record(value)) return workflowFailure("invalid_job_outcome", "job outcome must be typed");

  if (value.kind === "classified" && input.purpose === "classify" && keys(value, ["kind", "task"])) {
    const task = parseWorkflowTask(value.task);
    return task.ok && task.value.scope === input.scope ? { ok: true, value: { kind: "classified", task: task.value } }
      : workflowFailure("invalid_job_outcome", "classification must retain the nominated scope");
  }

  if (value.kind === "learned" && input.purpose !== "classify" && keys(value, ["kind", "versionId"]) && text(value.versionId)) {
    return { ok: true, value: { kind: "learned", versionId: value.versionId } };
  }

  if (["abstained", "failed", "cancelled", "budget_exhausted"].includes(String(value.kind)) && keys(value, ["kind", "code"]) && text(value.code)) {
    return { ok: true, value: { kind: value.kind as "abstained" | "failed" | "cancelled" | "budget_exhausted", code: value.code } };
  }

  return workflowFailure("invalid_job_outcome", "outcome does not belong to this workflow purpose");
}
