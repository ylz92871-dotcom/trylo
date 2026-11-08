import { createBoardReader, withBoardWriter } from "../../../../../adapters/learning-store/file-event-store.js";
import type { ToolLearningPlan, ToolLearningResult, ToolDiscoverySummary, ToolGenerationTrace } from "../domain/evolution/pipeline.js";
import { decodeDiscoverySummary, decodeToolGenerationTrace, resultVersionId, TOOL_JOB_PREFIX, validToolPipelineJobs } from "../domain/evolution/pipeline.js";
import { decodeToolEvolutionVerification } from "../domain/evolution/artifact.js";
import type { ToolEvolutionOutcome } from "./evolution-runtime.js";
import { assetAvailable, pipelineFailure, savePipelineAsset } from "./pipeline-assets.js";
import { candidateFromBoard } from "./evolution-reader.js";
import { contentHashOf } from "../../../../control/hash.js";
import { monitorToolJob } from "./pipeline-monitor.js";
import { planForJob, recipeForPlan, resultForJob, waitingToolJobReady } from "./pipeline-queue.js";
import type { ToolPipelineServices } from "./pipeline-services.js";
import { planToolLearningStep, toolLearningInputFingerprint } from "./pipeline-planning.js";
import type { ToolLearningDecision } from "../domain/evolution/learning-plan.js";
import { prepareToolImprovement } from "./evolution-trials.js";
import { ToolLearningServiceError } from "../domain/evolution/service-error.js";
import { performToolResearch, researchRequest, toolPlanningResearch, toolResearchFeedback } from "./pipeline-research.js";
import { MAX_TOOL_RESEARCH_STEPS, type ToolResearchStep, type ToolResearchBoundary } from "../domain/evolution/research.js";
import { decodeNpmToolProductionPlan } from "../domain/evolution/npm-production-plan.js";
import { decodeToolProductionPlan } from "../domain/evolution/production-plan.js";
import { productionFromBoard } from "./production-assets.js";
import { proposeToolContractRevision } from "./contract-revisions.js";
import { toolLearningCleanupCode, type ToolLearningCleanupCode } from "../domain/evolution/cleanup.js";
import { frozenToolRecipeForResult } from "./frozen-recipe.js";
import { rejectedReturnedToolGeneration } from "../domain/evolution/frozen-construction.js";
import { toolConstructionNeedsEvidence } from "../domain/evolution/construction-stop.js";
import { guardPureProductionRegression } from "./pure-production-regression.js";
import { preparePureProductionDescendant } from "./pure-production-descendant.js";
import { TOOL_CYCLE_DEADLINE, toolCycleDeadlineReached } from "../domain/evolution/cycle-deadline.js";
import type { ManagedToolFundingBinding } from "./learning-funding.js";
import { claimManagedToolContinuation, yieldUnspentToolContinuation } from "./pipeline-managed-continuation.js";
import { candidateBindsToolLearningRecipe } from "./pipeline-records.js";
import { isKnownToolPlanningBoundary, isManagedToolCheckpointContinuation, isSettledToolPlanningAttempt, isToolPlanningOutputRejection } from "../domain/evolution/managed-continuation.js";
import { toolResearchRequirements } from "../domain/evolution/research-lineage.js";

export type { ToolPipelineServices } from "./pipeline-services.js";

type WorkerInput = {
  readonly boardRoot: string; readonly scope: string; readonly now: () => number; readonly services: ToolPipelineServices;
  readonly mode: "manual" | "after_turn"; readonly signal: AbortSignal; readonly maxJobs?: number; readonly jobIds?: readonly string[];
  readonly managedBinding?: ManagedToolFundingBinding;
};

/** Claims are serialized by Board; slow work always runs after releasing its writer. */
export async function workToolLearningPipeline(input: WorkerInput) {
  const limit = input.maxJobs ?? 1;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 3) return pipelineFailure("invalid_budget", "maxJobs must be in 1..3");

  const loaded = await createBoardReader(input.boardRoot).load();
  if (!loaded.ok) return pipelineFailure(loaded.reason, loaded.detail);

  if (!validToolPipelineJobs(loaded.state)) return pipelineFailure("invalid_pipeline_job", "tool job namespace contains malformed persisted facts");

  const eligible = loaded.state.jobs.filter(job => job.jobId.startsWith(TOOL_JOB_PREFIX) && job.scope === input.scope
    && (input.jobIds === undefined || input.jobIds.includes(job.jobId)) && (["queued", "running", "waiting_evidence"].includes(job.state)
      || input.managedBinding !== undefined && (isKnownToolPlanningBoundary(loaded.state, job.jobId, resultVersionId(job.jobId, job.attempt))
        || input.mode === "manual" && input.services.executionAuthorized === true
          && isManagedToolCheckpointContinuation(loaded.state, job.jobId, resultVersionId(job.jobId, job.attempt)))));
  const results: { readonly jobId: string; readonly code: string }[] = [];

  for (const job of eligible) {
    if (input.signal.aborted || results.length >= limit) break;
    const result = await runJob(input, job.jobId);
    // A competitor winning the claim is normal and costs no work budget.
    if (result.code !== undefined && result.code !== "not_claimed") results.push({ jobId: job.jobId, code: result.code });
  }

  return { ok: true as const, results, cancelled: input.signal.aborted && !toolCycleDeadlineReached(input.signal) };
}

async function runJob(input: WorkerInput, jobId: string) {
  const claim = await claimJob(input, jobId);
  if (!claim.ok || "code" in claim) return claim;

  const { plan, attempt } = claim;
  let selected = claim.selected;
  const monitor = monitorToolJob({ boardRoot: input.boardRoot, jobId, attempt, signal: input.signal }), signal = monitor.signal;
  const occurredAt = () => new Date(input.now()).toISOString();
  let search: ToolDiscoverySummary = claim.previous?.search ?? { status: "complete", candidates: [], failures: [] };
  let generation: ToolGenerationTrace | undefined;
  let decision: ToolLearningDecision | undefined = claim.previous?.decision;
  let decisionVersionId: string | undefined = claim.previous?.decisionVersionId, inputFingerprint: string | undefined = claim.inputFingerprint;
  let learningFeedback = claim.returnedFeedback ?? "";
  let research: readonly ToolResearchStep[] = [];
  let contractProposalId: string | undefined;
  let cleanupCode: ToolLearningCleanupCode | undefined;
  const base = () => ({ type: "tool_learning_result" as const, schemaVersion: 1 as const, jobId, attempt, search, occurredAt: occurredAt(),
    ...(selected === undefined ? {} : { recipeVersionId: selected.versionId }), ...(generation === undefined ? {} : { generation }),
    ...(decision === undefined || decisionVersionId === undefined ? {} : { decision, decisionVersionId }),
    ...(inputFingerprint === undefined ? {} : { inputFingerprint, inputFingerprintPolicy: 2 as const }),
    ...(contractProposalId === undefined ? {} : { contractProposalId }) });
  let result: ToolLearningResult;

  try {
    let planningFailure: string | undefined;

    if (selected === undefined && input.services.plan !== undefined) {
      const facts = await createBoardReader(input.boardRoot).load();
      if (!facts.ok) throw new Error("planning facts could not be loaded");

      inputFingerprint = toolLearningInputFingerprint(facts.state, plan);
      const previousResearch = toolPlanningResearch(facts.state, plan, jobId);
      if (!previousResearch.ok) throw new ToolLearningServiceError(previousResearch.code);

      research = previousResearch.research;
      // Even a typed planning rejection needs a real evidence baseline. Bind
      // the existing grant once first, so its own initial funding cannot wake
      // this waiting task; successful planning replaces this with its exact view.
      const resources = await constructionResources(input, plan, signal);
      if (!resources.ok) throw new ToolLearningServiceError(resources.code);

      inputFingerprint = resources.inputFingerprint;
      planningFailure = resources.code;
      // Inventory and task evidence are inspected before spending on public discovery.
      let planningLimit = MAX_TOOL_RESEARCH_STEPS + 1;
      let researchBoundary: ToolResearchBoundary | undefined;

      for (let step = 1; planningFailure === undefined && step <= planningLimit; step++) {
        const planned = await planToolLearningStep({ boardRoot: input.boardRoot, plan, jobId, attempt, search,
          services: input.services, signal, occurredAt: occurredAt(), step,
          ...(researchBoundary === undefined ? {} : { researchBoundary }) });
        if (!planned.ok) {
          planningFailure = planned.code;
          break;
        }

        planningLimit = Math.min(planningLimit, planned.allowance.maxCalls);
        decision = planned.decision;
        decisionVersionId = planned.decisionVersionId;
        inputFingerprint = planned.inputFingerprint;
        selected = planned.selected;
        learningFeedback = planned.feedback;

        if (decision.action !== "research") break;

        if (step >= planningLimit || planned.allowance.callsRemaining < 2) {
          planningFailure = "learning_budget_exhausted";
          break;
        }

        const found = await performToolResearch({ boardRoot: input.boardRoot, plan, jobId, attempt, request: researchRequest(decision),
          services: input.services, prior: research, search, signal, occurredAt: occurredAt() });
        if (!found.ok) {
          if (researchBoundary === undefined && (found.code === "research_request_repeated" || found.code === "research_capacity")) {
            researchBoundary = { furtherInvestigation: "closed", reason: found.code };
            continue;
          }
          planningFailure = found.code;
          break;
        }

        research = [...research, found.step];
        search = found.search;

        if (!found.novel) researchBoundary = { furtherInvestigation: "closed", reason: "research_no_new_information" };
      }
    } else if (claim.previous === undefined) {
      const summary = decodeDiscoverySummary(await input.services.search(plan.capability, signal));
      if (summary === undefined) throw new Error("search result exceeds the pipeline contract");
      search = summary;
    }

    if (signal.aborted) result = { ...base(), outcome: "cancelled", code: "cancelled" };
    else if (planningFailure !== undefined) result = { ...base(), outcome: "waiting_evidence", code: planningFailure };
    else if (decision?.action === "reuse") result = { ...base(), outcome: "succeeded", code: "existing_capability_reused" };
    else if (decision?.action === "refine") result = { ...base(), outcome: "waiting_evidence", code: "usage_revision_proposed" };
    else if (decision?.action === "defer") result = { ...base(), outcome: decision.reason === "not_worthwhile" ? "succeeded" : "waiting_evidence", code: decision.reason };
    else if (decision?.action === "revise_contract") {
      const proposed = await proposeToolContractRevision(input.boardRoot, decision.proposal, occurredAt(), { jobId, attempt });
      if (proposed.ok) contractProposalId = proposed.proposalId;
      result = signal.aborted ? { ...base(), outcome: "cancelled", code: "cancelled" }
        : proposed.ok ? { ...base(), outcome: "waiting_evidence", code: "contract_revision_approval_required" }
          : { ...base(), outcome: "waiting_evidence", code: proposed.code };
    }
    else if (decision?.action === "acquire") result = { ...base(), outcome: "waiting_approval", code: "acquisition_approval_required" };
    else if (decision?.action === "adapt") {
      if (input.services.adapt === undefined) result = { ...base(), outcome: "waiting_evidence", code: "npm_adaptation_unavailable" };
      else {
        const adapted = await input.services.adapt(plan, decision.parentVersionId, decision.adaptation, signal, { jobId, attempt });
        result = signal.aborted ? { ...base(), outcome: "cancelled", code: "cancelled" }
          : adapted.ok ? { ...base(), outcome: "waiting_approval", code: "npm_candidate_pending_review", candidateVersionId: adapted.versionId }
            : { ...base(), outcome: "waiting_evidence", code: adapted.code };
      }
    }
    else if (selected === undefined) result = { ...base(), outcome: "waiting_evidence", code: "verification_recipe_required" };
    else if (input.mode === "after_turn" && selected.recipe.automation !== "after_turn") {
      result = { ...base(), outcome: "waiting_evidence", code: "manual_recipe" };
    } else if (input.mode === "after_turn" && input.services.executionAuthorized !== true) {
      result = { ...base(), outcome: "waiting_evidence", code: "execution_authorization_required" };
    } else {
      // Bind/read the same grant before observing construction inputs. Our own
      // initial funding is not later mistaken for new task evidence; facts that
      // arrive after this point remain eligible to wake a stopped construction.
      const resources = await constructionResources(input, plan, signal);
      if (!resources.ok) throw new ToolLearningServiceError(resources.code);

      inputFingerprint = resources.inputFingerprint;

      if (resources.code !== undefined) result = { ...base(), outcome: "waiting_evidence", code: resources.code };
      else {
        let request = { ...selected.recipe.request, requestId: `${jobId}:${attempt}` };
        const regression = await guardPureProductionRegression({ boardRoot: input.boardRoot, plan, request, jobId, attempt, issuedAt: occurredAt(),
          ...(input.services.productionRegression === undefined ? {} : { productionRegression: input.services.productionRegression }),
          ...(decision === undefined ? {} : { decision }) });
        if (!regression.ok) result = { ...base(), outcome: "waiting_evidence", code: regression.code };
        else {
          if (request.operation === "improve" && request.prior !== undefined) {
            const prepared = await prepareToolImprovement(input.boardRoot, request.prior.versionId, request, plan);
            if (!prepared.ok) throw new Error("archived improvement parent is unavailable");
            request = prepared.request;
            learningFeedback = [learningFeedback, prepared.feedback].filter(Boolean).join("\n");
          }

          const feedback = [learningFeedback, discoveryFeedback(search), toolResearchFeedback(research),
            ...(input.services.centralSourceContext === undefined ? [] : ["Public source analysis; unverified, never expected outputs, verification or authorization.\n"
              + input.services.centralSourceContext.ref + "\n" + input.services.centralSourceContext.text])].filter(Boolean).join("\n");
          const outcome = decision?.action === "compose"
            ? input.services.compose === undefined ? { kind: "failed" as const, code: "composition_unavailable", message: "composition adapter is unavailable", attempts: 0 }
              : await input.services.compose(request, decision.descriptor, signal, feedback, { jobId, attempt })
            : await input.services.evolve(request, signal, feedback, { jobId, attempt }, claim.requirements);

          generation = generationTrace(outcome);
          const production = outcome.kind !== "candidate" || signal.aborted ? undefined : await preparePureProductionDescendant({ boardRoot: input.boardRoot,
            versionId: outcome.versionId, jobId, attempt, issuedAt: occurredAt() });

          result = signal.aborted ? { ...base(), outcome: "cancelled", code: "cancelled" }
            : production !== undefined && !production.ok ? { ...base(), outcome: "waiting_evidence", code: production.code }
            : outcome.kind === "candidate" ? { ...base(), outcome: "waiting_approval", code: production?.versionId === undefined ? "candidate_pending_review" : "production_candidate_pending_review",
              candidateVersionId: production?.versionId ?? outcome.versionId }
            : outcome.kind === "cancelled" ? { ...base(), outcome: "cancelled", code: "cancelled" }
            : { ...base(), outcome: toolConstructionNeedsEvidence(outcome.code) ? "waiting_evidence" : "failed", code: outcome.code.slice(0, 160) || "evolution_failed" };
        }
      }
    }
  } catch (error) {
    // Provider/network details can contain credentials; persist only the stage class.
    result = { ...base(), outcome: signal.aborted ? "cancelled" : "failed", code: signal.aborted ? "cancelled" : "pipeline_service_failed" };
    if (!(error instanceof Error)) result = { ...result, code: signal.aborted ? "cancelled" : "pipeline_service_threw" };
    if (!signal.aborted && error instanceof ToolLearningServiceError) result = { ...result,
      outcome: toolConstructionNeedsEvidence(error.code) ? "waiting_evidence" : "failed", code: error.code };
  } finally {
    monitor.close();
    try { await input.services.releaseAllowance?.(); }
    catch (error) {
      // A worker may not be retired even when funding was yielded successfully.
      cleanupCode = toolLearningCleanupCode(error);
    }
  }

  if (result.outcome === "cancelled" && toolCycleDeadlineReached(signal)) {
    result = { ...result, outcome: "waiting_evidence", code: TOOL_CYCLE_DEADLINE };
  }

  if (cleanupCode !== undefined) result = { ...result, previousCode: result.code, code: "allowance_release_failed", cleanupCode };

  const saved = await finishJob(input, plan, result);
  if (saved.ok && claim.continuation !== undefined) {
    const continuation = claim.continuation;
    const yielded = await withBoardWriter(input.boardRoot, board => yieldUnspentToolContinuation(board, continuation, input.now()));
    if (!yielded.ok) return "reason" in yielded ? pipelineFailure(yielded.reason, yielded.detail) : yielded;
  }

  return saved.ok ? { ok: true as const, code: result.code } : saved;
}

async function constructionResources(input: WorkerInput, plan: ToolLearningPlan, signal: AbortSignal) {
  const allowance = await input.services.allowance?.(plan, signal);
  const loaded = await createBoardReader(input.boardRoot).load();
  if (!loaded.ok) return pipelineFailure(loaded.reason, loaded.detail);
  const code = input.services.allowance === undefined ? undefined : allowance === undefined ? "learning_allowance_required"
    : allowance.callsRemaining < 1 || allowance.tokensRemaining < 128 ? "learning_budget_exhausted" : undefined;
  return { ok: true as const, inputFingerprint: toolLearningInputFingerprint(loaded.state, plan), code };
}

function generationTrace(outcome: ToolEvolutionOutcome): ToolGenerationTrace {
  const report = outcome.kind === "candidate" ? outcome.artifact.verification : outcome.kind === "failed" ? outcome.verification : undefined;
  const verification = decodeToolEvolutionVerification(report);
  const trace = decodeToolGenerationTrace({ attempts: outcome.attempts,
    ...(outcome.kind !== "failed" || outcome.rejectionCode === undefined ? {} : { rejectionCode: outcome.rejectionCode }),
    ...(verification === undefined ? {} : { verification }) });
  if (trace === undefined) throw new Error("invalid generation diagnostics");

  return trace;
}

async function claimJob(input: WorkerInput, jobId: string) {
  const result = await withBoardWriter(input.boardRoot, async store => {
    const loaded = await store.load();
    if (!loaded.ok) return pipelineFailure(loaded.reason, loaded.detail);

    const job = loaded.state.jobs.find(item => item.jobId === jobId);
    const plan = planForJob(loaded.state, jobId);
    if (job === undefined || plan === undefined || plan.scope !== input.scope || job.scope !== plan.scope || job.domain !== "tool") return pipelineFailure("invalid_job_binding", jobId);

    if (plan.fundingOrigin !== undefined) return { ok: true as const, code: "inquiry_review_requires_materialization" };

    if (job.state === "running") {
      const recorded = resultForJob(loaded.state, jobId, job.attempt);
      if (recorded === undefined) return pipelineFailure("running_job_requires_inspection", jobId);
      const applied = await store.apply(terminalCommand(recorded));
      return applied.ok ? { ok: true as const, code: "recovered_terminal" } : pipelineFailure(applied.reason, applied.detail);
    }

    const recorded = resultForJob(loaded.state, jobId, job.attempt);
    const frozen = frozenToolRecipeForResult(loaded.state, job, plan, recorded);
    if (!frozen.ok) return frozen;

    const selected = frozen.selected ?? recipeForPlan(loaded.state, plan);
    const planningBoundary = input.managedBinding !== undefined
      && isKnownToolPlanningBoundary(loaded.state, jobId, resultVersionId(jobId, job.attempt));
    const managedBoundary = planningBoundary || input.managedBinding !== undefined && input.mode === "manual" && input.services.executionAuthorized === true
      && isManagedToolCheckpointContinuation(loaded.state, jobId, resultVersionId(jobId, job.attempt));
    const previous = frozen.selected === undefined && !planningBoundary ? undefined : recorded;
    const returnedFeedback = recorded === undefined ? undefined : rejectedReturnedToolGeneration(loaded.state, job, plan, recorded)?.feedback;
    const inputFingerprint = selected === undefined ? undefined : toolLearningInputFingerprint(loaded.state, plan);
    let continuation: import("../../../../control/commands.js").ManagedJobContinuation | undefined;

    if (job.state === "waiting_evidence" && !planningBoundary) {
      if (resultForJob(loaded.state, jobId, job.attempt) === undefined) return pipelineFailure("invalid_pipeline_result", jobId);
      if (!waitingToolJobReady(loaded.state, job, plan, input.mode, input.services.executionAuthorized === true,
        input.mode === "manual" && input.jobIds?.includes(jobId) === true)) return { ok: true as const, code: "not_claimed" };
    } else if (job.state !== "queued" && !managedBoundary) return { ok: true as const, code: "not_claimed" };

    const requirements = toolResearchRequirements(loaded.state, plan);
    if (requirements === undefined) return pipelineFailure("invalid_tool_funding_origin", "Construction lost its canonical public contract");

    const claimed = await claimManagedToolContinuation(store, loaded.state, plan, job, input.managedBinding, input.now());
    if (!claimed.ok) return claimed;

    continuation = "continuation" in claimed ? claimed.continuation : undefined;
    const suffix = continuation === undefined ? "" : `:managed:${contentHashOf(continuation)}`;

    if (job.state === "waiting_evidence" || job.state === "failed" && managedBoundary) {
      const requeued = await store.apply({ type: "requeue_job", commandId: `${jobId}:requeue:${job.attempt}${suffix}`,
        issuedAt: new Date(input.now()).toISOString(), jobId, expectedAttempt: job.attempt, ...(continuation === undefined ? {} : { continuation }) });
      if (!requeued.ok) {
        if (continuation !== undefined) {
          const yielded = await yieldUnspentToolContinuation(store, continuation, input.now());
          if (!yielded.ok) return yielded;
        }
        return pipelineFailure(requeued.reason, requeued.detail);
      }
    }

    const attempt = job.attempt + 1;
    const started = await store.apply({ type: "start_job", commandId: `${jobId}:start:${attempt}${suffix}`, issuedAt: new Date(input.now()).toISOString(), jobId,
      ...(continuation === undefined ? {} : { continuation }) });
    if (!started.ok || started.idempotent) {
      if (continuation !== undefined) {
        const yielded = await yieldUnspentToolContinuation(store, continuation, input.now());
        if (!yielded.ok) return yielded;
      }
      return started.ok ? { ok: true as const, code: "not_claimed" } : pipelineFailure(started.reason, started.detail);
    }

    return { ok: true as const, plan, attempt, selected, previous, inputFingerprint, continuation, requirements, returnedFeedback };
  });
  return "reason" in result ? pipelineFailure(result.reason, result.detail) : result;
}

async function finishJob(input: WorkerInput, plan: ToolLearningPlan, returned: ToolLearningResult) {
  const saved = await withBoardWriter(input.boardRoot, async store => {
    const loaded = await store.load();
    if (!loaded.ok) return pipelineFailure(loaded.reason, loaded.detail);

    const job = loaded.state.jobs.find(item => item.jobId === returned.jobId);
    if (job?.state !== "running" || job.attempt !== returned.attempt) return pipelineFailure("stale_job_result", returned.jobId);

    const result = returned.outcome === "failed" && isToolPlanningOutputRejection(returned.code)
      && returned.cleanupCode === undefined && returned.generation === undefined && returned.decision === undefined
      && returned.candidateVersionId === undefined && returned.contractProposalId === undefined
      && isSettledToolPlanningAttempt(loaded.state, job.jobId, job.attempt)
      ? { ...returned, outcome: "waiting_evidence" as const } : returned;
    if (result.candidateVersionId !== undefined) {
      if (result.decision?.action === "adapt") {
        const asset = loaded.state.assets.find(item => item.versionId === result.candidateVersionId);
        const decoded = asset === undefined ? undefined : decodeNpmToolProductionPlan(asset.content);
        const production = decoded === undefined ? undefined : productionFromBoard(loaded.state, result.candidateVersionId, decoded.workspaceId);
        if (production?.ok !== true || decoded === undefined || decoded.origin.scope !== plan.scope || decoded.origin.capability !== plan.capability
          || decoded.evolution?.parentVersionId !== result.decision.parentVersionId || decoded.evolution.requestId !== `${result.jobId}:${result.attempt}`) return pipelineFailure("candidate_recipe_binding_mismatch", result.jobId);
      } else {
        const raw = decodeToolProductionPlan(loaded.state.assets.find(asset => asset.versionId === result.candidateVersionId)?.content);
        const production = raw?.type === "tool_production_package" ? productionFromBoard(loaded.state, result.candidateVersionId, raw.workspaceId) : undefined;
        if (production !== undefined && !production.ok) return production;

        const candidate = candidateFromBoard(loaded.state, production?.ok === true ? production.plan.origin.versionId : result.candidateVersionId);
        const selected = loaded.state.assets.find(asset => asset.versionId === result.recipeVersionId);
        if (!candidate.ok || selected === undefined || !assetAvailable(loaded.state, selected) || !candidateBindsToolLearningRecipe(candidate.artifact.request, selected.content, plan, result)) {
          return pipelineFailure("candidate_recipe_binding_mismatch", result.jobId);
        }
      }
    }

    const archived = await savePipelineAsset(store, { versionId: resultVersionId(result.jobId, result.attempt), kind: "workflow", content: result,
      scope: plan.scope, source: "inferred", issuedAt: result.occurredAt });
    if (!archived.ok) return archived;

    const applied = await store.apply(terminalCommand(result));

    return applied.ok ? { ok: true as const } : pipelineFailure(applied.reason, applied.detail);
  });
  return "reason" in saved ? pipelineFailure(saved.reason, saved.detail) : saved;
}

function terminalCommand(result: ToolLearningResult) {
  const base = { commandId: `${result.jobId}:terminal:${result.attempt}`, issuedAt: result.occurredAt, jobId: result.jobId };
  return result.outcome === "waiting_approval" || result.outcome === "waiting_evidence" || result.outcome === "succeeded"
    ? { ...base, type: "complete_job" as const, next: result.outcome }
    : { ...base, type: "fail_job" as const, terminal: result.outcome };
}

function discoveryFeedback(search: ToolDiscoverySummary): string {
  return `Public discovery metadata only; do not copy upstream code or claim an installation. Search status: ${search.status}.\n`
    + JSON.stringify(search.candidates.map(candidate => ({ platform: candidate.platform, id: candidate.id, sourceUrl: candidate.sourceUrl, license: candidate.licenseSpdx })));
}
