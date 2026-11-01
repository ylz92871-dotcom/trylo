import { contentHashOf } from "../../../control/hash.js";
import { isJsonValue, jsonBytes, keysAre, recordOf, textOf, parseToolEvolutionRequest } from "./parse.js";
import type { ToolEvolutionRequest } from "./contracts.js";
import type { BoardState } from "../../../control/state.js";
import { JOB_STATES } from "../../../control/contracts.js";
import { decodeToolEvolutionVerification } from "./artifact.js";
import type { ToolEvolutionVerification } from "./verification.js";

export const TOOL_JOB_PREFIX = "tool-learning_v1_";
const TOOL_JOB_ID = new RegExp(`^${TOOL_JOB_PREFIX}[a-f0-9]{64}$`);
export const MAX_TOOL_PIPELINE_JOBS = 1_024;
export type ToolLearningPlan = {
  readonly type: "tool_learning_plan";
  readonly schemaVersion: 1;
  readonly scope: string;
  readonly capability: string;
  readonly trigger: { readonly runId: string; readonly proposalKey: string; readonly evidenceRefs: readonly string[]; readonly action: string; readonly tool?: string };
  readonly createdAt: string;
};
export type ToolLearningRecipe = {
  readonly type: "tool_learning_recipe";
  readonly schemaVersion: 1;
  readonly automation: "manual" | "after_turn";
  readonly request: ToolEvolutionRequest;
};
export type ToolDiscoverySummary = {
  readonly status: "complete" | "partial" | "failed";
  readonly candidates: readonly { readonly platform: string; readonly id: string; readonly sourceUrl: string; readonly licenseSpdx: string; readonly version?: string }[];
  readonly failures: readonly { readonly platform: string; readonly stage: string; readonly code: string }[];
};
export type ToolLearningResult = {
  readonly type: "tool_learning_result";
  readonly schemaVersion: 1;
  readonly jobId: string;
  readonly attempt: number;
  readonly outcome: "waiting_evidence" | "waiting_approval" | "failed" | "cancelled";
  readonly code: string;
  readonly search: ToolDiscoverySummary;
  readonly recipeVersionId?: string;
  readonly candidateVersionId?: string;
  readonly occurredAt: string;
  readonly generation?: ToolGenerationTrace;
};
export type ToolGenerationTrace = { readonly attempts: number; readonly rejectionCode?: string; readonly verification?: ToolEvolutionVerification };

export function toolLearningJobId(plan: ToolLearningPlan): string {
  return `${TOOL_JOB_PREFIX}${contentHashOf(plan)}`;
}
export function planVersionId(jobId: string): string { return `plan:${jobId}`; }
export function resultVersionId(jobId: string, attempt: number): string { return `result:${jobId}:${attempt}`; }
export function isToolLearningJobId(value: unknown): value is string { return typeof value === "string" && TOOL_JOB_ID.test(value); }

/** Old Board snapshots predate job payload guards; protect this executable namespace at reads. */
export function validToolPipelineJobs(state: BoardState): boolean {
  return Array.isArray(state.jobs) && state.jobs.every(job => recordOf(job) && textOf(job.jobId)
    && (!job.jobId.startsWith(TOOL_JOB_PREFIX) || (isToolLearningJobId(job.jobId)
      && job.domain === "tool" && textOf(job.scope, 512) && textOf(job.observationId, 512) && textOf(job.dedupeKey, 1_400)
      && JOB_STATES.some(value => value === job.state) && typeof job.attempt === "number" && Number.isSafeInteger(job.attempt) && job.attempt >= 0 && job.attempt <= 3
      && job.maxAttempts === 3 && typeof job.breakerOpen === "boolean")));
}

export function decodeToolLearningPlan(raw: unknown): ToolLearningPlan | undefined {
  if (!isJsonValue(raw) || jsonBytes(raw) > 16_384 || !recordOf(raw) || !recordOf(raw.trigger)) return undefined;
  const value = raw, trigger = raw.trigger;
  if (!keysAre(value, ["type", "schemaVersion", "scope", "capability", "trigger", "createdAt"])
    || value.type !== "tool_learning_plan" || value.schemaVersion !== 1 || !bounded(value.scope, 512) || !bounded(value.capability, 512)
    || !bounded(value.createdAt, 64) || !keysAre(trigger, ["runId", "proposalKey", "evidenceRefs", "action"], ["tool"])
    || !bounded(trigger.runId, 160) || !bounded(trigger.proposalKey, 512) || !bounded(trigger.action, 120)
    || (trigger.tool !== undefined && !bounded(trigger.tool, 512))
    || !Array.isArray(trigger.evidenceRefs) || trigger.evidenceRefs.length > 64 || !trigger.evidenceRefs.every(ref => bounded(ref, 512))) return undefined;
  return { type: "tool_learning_plan", schemaVersion: 1, scope: value.scope, capability: value.capability,
    createdAt: value.createdAt, trigger: { runId: trigger.runId, proposalKey: trigger.proposalKey, action: trigger.action, evidenceRefs: [...trigger.evidenceRefs],
      ...(trigger.tool === undefined ? {} : { tool: trigger.tool }) } };
}

export function decodeToolLearningRecipe(raw: unknown): ToolLearningRecipe | undefined {
  if (!isJsonValue(raw) || jsonBytes(raw) > 262_144 || !recordOf(raw)) return undefined;
  const value = raw;
  if (!keysAre(value, ["type", "schemaVersion", "automation", "request"]) || value.type !== "tool_learning_recipe"
    || value.schemaVersion !== 1 || (value.automation !== "manual" && value.automation !== "after_turn")) return undefined;
  const request = parseToolEvolutionRequest(value.request);
  if (!request.ok || request.value.operation !== "create" || request.value.prior !== undefined) return undefined;
  return { type: "tool_learning_recipe", schemaVersion: 1, automation: value.automation, request: request.value };
}

export function decodeToolLearningResult(raw: unknown): ToolLearningResult | undefined {
  if (!isJsonValue(raw) || jsonBytes(raw) > 131_072 || !recordOf(raw)) return undefined;
  const value = raw;
  if (!keysAre(value, ["type", "schemaVersion", "jobId", "attempt", "outcome", "code", "search", "occurredAt"], ["recipeVersionId", "candidateVersionId", "generation"])
    || value.type !== "tool_learning_result" || value.schemaVersion !== 1 || !bounded(value.jobId, 160) || !Number.isSafeInteger(value.attempt)
    || typeof value.attempt !== "number" || value.attempt < 1 || value.attempt > 3 || !bounded(value.code, 160) || !bounded(value.occurredAt, 64)
    || !["waiting_evidence", "waiting_approval", "failed", "cancelled"].includes(String(value.outcome))
    || (value.recipeVersionId !== undefined && !bounded(value.recipeVersionId, 160))
    || (value.candidateVersionId !== undefined && !bounded(value.candidateVersionId, 160))) return undefined;
  const search = decodeDiscoverySummary(value.search);
  if (search === undefined || (value.generation !== undefined && decodeToolGenerationTrace(value.generation) === undefined)
    || (value.outcome === "waiting_approval" && (value.candidateVersionId === undefined || value.recipeVersionId === undefined))) return undefined;
  // Shape and size are checked above; rebuild through JSON to detach persistence input.
  return JSON.parse(JSON.stringify({ ...value, search })) as ToolLearningResult;
}

export function decodeToolGenerationTrace(raw: unknown): ToolGenerationTrace | undefined {
  if (!recordOf(raw) || !isJsonValue(raw) || jsonBytes(raw) > 49_152 || !keysAre(raw, ["attempts"], ["rejectionCode", "verification"])
    || typeof raw.attempts !== "number" || !Number.isSafeInteger(raw.attempts) || raw.attempts < 0 || raw.attempts > 3
    || (raw.rejectionCode !== undefined && (typeof raw.rejectionCode !== "string" || !/^[a-z][a-z0-9_]{0,159}$/.test(raw.rejectionCode)))) return undefined;
  const verification = raw.verification === undefined ? undefined : decodeToolEvolutionVerification(raw.verification);
  if (raw.verification !== undefined && verification === undefined) return undefined;
  return { attempts: raw.attempts, ...(raw.rejectionCode === undefined ? {} : { rejectionCode: raw.rejectionCode }),
    ...(verification === undefined ? {} : { verification }) };
}

export function decodeDiscoverySummary(raw: unknown): ToolDiscoverySummary | undefined {
  if (!recordOf(raw)) return undefined;
  const value = raw;
  if (!isJsonValue(raw) || jsonBytes(raw) > 65_536 || !keysAre(value, ["status", "candidates", "failures"])
    || !["complete", "partial", "failed"].includes(String(value.status)) || !Array.isArray(value.candidates) || value.candidates.length > 20
    || !Array.isArray(value.failures) || value.failures.length > 84) return undefined;
  for (const rawCandidate of value.candidates) {
    if (!recordOf(rawCandidate)) return undefined;
    const candidate = rawCandidate;
    if (!keysAre(candidate, ["platform", "id", "sourceUrl", "licenseSpdx"], ["version"])
      || !bounded(candidate.platform, 32) || !bounded(candidate.id, 512) || !bounded(candidate.sourceUrl, 2_048)
      || !bounded(candidate.licenseSpdx, 128) || (candidate.version !== undefined && !bounded(candidate.version, 256))) return undefined;
  }
  for (const rawFailure of value.failures) {
    if (!recordOf(rawFailure)) return undefined;
    const failure = rawFailure;
    if (!keysAre(failure, ["platform", "stage", "code"]) || !bounded(failure.platform, 32)
      || !bounded(failure.stage, 32) || !bounded(failure.code, 160)) return undefined;
  }
  return JSON.parse(JSON.stringify(value)) as ToolDiscoverySummary;
}

function bounded(value: unknown, length: number): value is string { return textOf(value, length); }
