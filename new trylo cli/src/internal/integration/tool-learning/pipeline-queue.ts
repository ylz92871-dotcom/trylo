import { createBoardReader, withBoardWriter } from "../../adapters/learning-store/file-event-store.js";
import type { FileBoardStoreOptions } from "../../adapters/learning-store/file-event-store.js";
import type { BoardState } from "../../learning/control/state.js";
import type { LearningJob } from "../../learning/control/contracts.js";
import { contentHashOf } from "../../learning/control/hash.js";
import { decodeToolLearningPlan, decodeToolLearningRecipe, decodeToolLearningResult, MAX_TOOL_PIPELINE_JOBS,
  planVersionId, resultVersionId, toolLearningJobId, TOOL_JOB_PREFIX, validToolPipelineJobs } from "../../learning/domains/tool/evolution/pipeline.js";
import type { ToolLearningPlan, ToolLearningRecipe } from "../../learning/domains/tool/evolution/pipeline.js";
import { assetAvailable, pipelineFailure, savePipelineAsset } from "./pipeline-assets.js";
import { admitProposal, type ProposalRecord } from "../../learning/domains/tool/awareness/index.js";

export async function registerToolLearningRecipe(boardRoot: string, raw: unknown, issuedAt: string) {
  const recipe = decodeToolLearningRecipe(raw);
  if (recipe === undefined) return pipelineFailure("invalid_recipe", "recipe needs caller-owned create samples and an explicit automation mode");
  const versionId = `tool-recipe_v1_${contentHashOf(recipe)}`;
  const result = await withBoardWriter(boardRoot, store => savePipelineAsset(store, { versionId, content: recipe,
    kind: "verification_recipe", scope: recipe.request.scope, source: "user_explicit", issuedAt }));
  return "reason" in result ? pipelineFailure(result.reason, result.detail) : result;
}

export async function enqueueToolLearningPlan(boardRoot: string, raw: unknown, options: FileBoardStoreOptions = {}) {
  const plan = decodeToolLearningPlan(raw);
  if (plan === undefined) return pipelineFailure("invalid_plan", "tool learning plan is malformed or exceeds bounds");
  const jobId = toolLearningJobId(plan);
  const result = await withBoardWriter(boardRoot, async store => {
    const loaded = await store.load();
    if (!loaded.ok) return pipelineFailure(loaded.reason, loaded.detail);
    if (!validToolPipelineJobs(loaded.state)) return pipelineFailure("invalid_pipeline_job", "tool job namespace contains malformed persisted facts");
    const existing = loaded.state.jobs.find(job => job.jobId === jobId);
    if (existing !== undefined) {
      const decoded = planForJob(loaded.state, jobId);
      return decoded !== undefined && contentHashOf(decoded) === contentHashOf(plan)
        ? { ok: true as const, jobId, state: existing.state } : pipelineFailure("pipeline_asset_conflict", jobId);
    }
    const admission = automaticPlanAdmission(loaded.state, plan);
    if (admission !== undefined) return admission;
    if (loaded.state.jobs.filter(job => job.jobId.startsWith(TOOL_JOB_PREFIX)).length >= MAX_TOOL_PIPELINE_JOBS) {
      return pipelineFailure("pipeline_budget_exceeded", "tool job history is full; no silent eviction or unbounded queue");
    }
    const saved = await savePipelineAsset(store, { versionId: planVersionId(jobId), content: plan, kind: "workflow",
      scope: plan.scope, source: "inferred", issuedAt: plan.createdAt, observations: plan.trigger.evidenceRefs });
    if (!saved.ok) return saved;
    const applied = await store.apply({ type: "enqueue_job", commandId: `${jobId}:enqueue`, issuedAt: plan.createdAt,
      job: { jobId, observationId: plan.trigger.evidenceRefs[0] ?? plan.trigger.proposalKey, domain: "tool", scope: plan.scope,
        maxAttempts: 3, dedupeKey: `${plan.scope}:${plan.trigger.runId}:${plan.trigger.proposalKey}` } });
    return applied.ok ? { ok: true as const, jobId, state: "queued" as const } : pipelineFailure(applied.reason, applied.detail);
  }, options);
  return "reason" in result ? pipelineFailure(result.reason, result.detail) : result;
}

/** Repeat the existing pure frequency rule under Board's single writer, using durable history. */
function automaticPlanAdmission(state: BoardState, plan: ToolLearningPlan) {
  if (plan.trigger.action === "user_requested") return undefined;
  const history: ProposalRecord[] = [];
  for (const job of state.jobs) {
    if (!job.jobId.startsWith(TOOL_JOB_PREFIX)) continue;
    const previous = planForJob(state, job.jobId);
    if (previous === undefined) return pipelineFailure("invalid_job_binding", job.jobId);
    if (previous.trigger.action !== "user_requested") history.push({ key: previous.trigger.proposalKey, runId: previous.trigger.runId,
      proposedAt: previous.createdAt, ...(previous.trigger.tool === undefined ? {} : { tool: previous.trigger.tool }) });
  }
  const verdict = admitProposal({ candidate: { key: plan.trigger.proposalKey, ...(plan.trigger.tool === undefined ? {} : { tool: plan.trigger.tool }) },
    runId: plan.trigger.runId, at: plan.createdAt, history });
  return verdict.allowed ? undefined : pipelineFailure(`automatic_proposal_${verdict.reason}`, "automatic proposal admission was refused by the existing frequency rule");
}

export function planForJob(state: BoardState, jobId: string): ToolLearningPlan | undefined {
  if (!validToolPipelineJobs(state)) return undefined;
  const asset = state.assets.find(item => item.versionId === planVersionId(jobId));
  if (asset === undefined || asset.kind !== "workflow" || !assetAvailable(state, asset)) return undefined;
  const plan = decodeToolLearningPlan(asset.content);
  return plan !== undefined && toolLearningJobId(plan) === jobId && asset.scope === plan.scope ? plan : undefined;
}

export function recipeForPlan(state: BoardState, plan: ToolLearningPlan): { readonly versionId: string; readonly recipe: ToolLearningRecipe } | undefined {
  const ordered = [...state.assets].reverse();
  for (const asset of ordered) {
    if (asset.kind !== "verification_recipe" || asset.scope !== plan.scope || !assetAvailable(state, asset)) continue;
    const proposal = state.proposals.find(item => item.proposalId === asset.createdFromProposalId);
    const recipe = decodeToolLearningRecipe(asset.content);
    if (recipe !== undefined && proposal?.source === "user_explicit" && recipe.request.scope === plan.scope
      && recipe.request.capability === plan.capability && asset.versionId === `tool-recipe_v1_${contentHashOf(recipe)}`) return { versionId: asset.versionId, recipe };
  }
  return undefined;
}

export function resultForJob(state: BoardState, jobId: string, attempt: number) {
  const asset = state.assets.find(item => item.versionId === resultVersionId(jobId, attempt));
  if (asset === undefined || asset.kind !== "workflow" || !assetAvailable(state, asset)) return undefined;
  const result = decodeToolLearningResult(asset.content);
  const plan = planForJob(state, jobId);
  return plan !== undefined && result?.jobId === jobId && result.attempt === attempt && asset.scope === plan.scope ? result : undefined;
}

export function waitingToolJobReady(state: BoardState, job: LearningJob, plan: ToolLearningPlan,
  mode: "manual" | "after_turn", executionAuthorized: boolean): boolean {
  const selected = recipeForPlan(state, plan);
  if (selected === undefined || (mode === "after_turn" && selected.recipe.automation !== "after_turn")) return false;
  const previous = resultForJob(state, job.jobId, job.attempt);
  if (previous === undefined) return false;
  const permissionArrived = previous?.code === "execution_authorization_required" && executionAuthorized;
  return previous?.recipeVersionId !== selected.versionId || previous.code === "manual_recipe" || permissionArrived;
}

export async function nextToolLearningDispatch(boardRoot: string, scope: string, executionAuthorized: boolean, jobIds?: readonly string[]) {
  const loaded = await createBoardReader(boardRoot).load();
  if (!loaded.ok) return pipelineFailure(loaded.reason, loaded.detail);
  if (!validToolPipelineJobs(loaded.state)) return pipelineFailure("invalid_pipeline_job", "tool job namespace contains malformed persisted facts");
  for (const job of loaded.state.jobs) {
    if (!job.jobId.startsWith(TOOL_JOB_PREFIX) || job.scope !== scope || (jobIds !== undefined && !jobIds.includes(job.jobId))
      || (job.state !== "queued" && job.state !== "waiting_evidence")) continue;
    const plan = planForJob(loaded.state, job.jobId);
    if (plan === undefined) return pipelineFailure("invalid_job_binding", job.jobId);
    if (job.state === "waiting_evidence" && resultForJob(loaded.state, job.jobId, job.attempt) === undefined) return pipelineFailure("invalid_pipeline_result", job.jobId);
    if (job.state === "queued" || waitingToolJobReady(loaded.state, job, plan, "after_turn", executionAuthorized)) return { ok: true as const, jobId: job.jobId };
  }
  return { ok: true as const, jobId: undefined };
}

export async function readToolLearningPipeline(boardRoot: string) {
  const loaded = await createBoardReader(boardRoot).load();
  if (!loaded.ok) return pipelineFailure(loaded.reason, loaded.detail);
  if (!validToolPipelineJobs(loaded.state)) return pipelineFailure("invalid_pipeline_job", "tool job namespace contains malformed persisted facts");
  const jobs = loaded.state.jobs.filter(job => job.jobId.startsWith(TOOL_JOB_PREFIX));
  if (jobs.some(job => {
    const present = loaded.state.assets.some(asset => asset.versionId === resultVersionId(job.jobId, job.attempt));
    const required = job.state === "waiting_evidence" || job.state === "waiting_approval";
    return (present || required) && resultForJob(loaded.state, job.jobId, job.attempt) === undefined;
  })) return pipelineFailure("invalid_pipeline_result", "a persisted job result is missing or no longer valid; work was not retried");
  const recipes = loaded.state.assets.flatMap(asset => {
    const recipe = asset.kind === "verification_recipe" && assetAvailable(loaded.state, asset) ? decodeToolLearningRecipe(asset.content) : undefined;
    return recipe === undefined ? [] : [{ versionId: asset.versionId, scope: recipe.request.scope, capability: recipe.request.capability, automation: recipe.automation }];
  });
  return { ok: true as const, recipes, jobs: jobs.map(job => ({ ...job, plan: planForJob(loaded.state, job.jobId),
    result: resultForJob(loaded.state, job.jobId, job.attempt), recovery: job.state === "running" ? "needs_inspection" : "none" })) };
}

/** Explicit operator closeout after inspecting a lost worker; never retries external work. */
export async function expireToolLearningJob(boardRoot: string, jobId: string, issuedAt: string) {
  if (!jobId.startsWith(TOOL_JOB_PREFIX)) return pipelineFailure("invalid_job_binding", jobId);
  const result = await withBoardWriter(boardRoot, async store => {
    const loaded = await store.load();
    if (!loaded.ok) return pipelineFailure(loaded.reason, loaded.detail);
    const job = loaded.state.jobs.find(item => item.jobId === jobId);
    if (job?.domain !== "tool" || planForJob(loaded.state, jobId) === undefined) return pipelineFailure("invalid_job_binding", jobId);
    if (job.state === "expired") return { ok: true as const, jobId };
    const applied = await store.apply({ type: "fail_job", commandId: `${jobId}:operator-expire`, issuedAt, jobId, terminal: "expired" });
    return applied.ok ? { ok: true as const, jobId } : pipelineFailure(applied.reason, applied.detail);
  });
  return "reason" in result ? pipelineFailure(result.reason, result.detail) : result;
}
