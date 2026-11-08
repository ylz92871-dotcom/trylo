import type { BoardState } from "../../../../control/state.js";
import { contentHashOf } from "../../../../control/hash.js";
import { withBoardWriter } from "../../../../../adapters/learning-store/file-event-store.js";
import { decodeToolLearningDecision } from "../domain/evolution/learning-plan.js";
import { decodeDiscoverySummary, decodeToolLearningResult, type ToolDiscoverySummary, type ToolLearningPlan } from "../domain/evolution/pipeline.js";
import { decodeToolInspectionReport, decodeToolResearchStep, decodeToolLibraryInvestigation, toolGenerationResearchReference, MAX_TOOL_RESEARCH_STEPS, type ToolInspectionRequest,
  type ToolPlanningHistory, type ToolResearchRequest, type ToolResearchStep } from "../domain/evolution/research.js";
import { recordOf } from "../domain/evolution/parse.js";
import { assetAvailable, pipelineFailure, savePipelineAsset } from "./pipeline-assets.js";
import type { ToolPipelineServices } from "./pipeline-services.js";
import { isToolPipelineCounter } from "../domain/evolution/pipeline-lifetime.js";
import { readToolResearchLineage } from "../domain/evolution/research-lineage.js";
import { toolLearningJobId } from "../domain/evolution/pipeline.js";

/** Reuse research facts, including negative findings, without creating a second mutable knowledge store. */
export function toolPlanningResearch(state: BoardState, plan: ToolLearningPlan, jobId: string) {
  const research: ToolResearchStep[] = [], history: ToolPlanningHistory[] = [];
  const lineage = plan.researchOrigin === undefined ? undefined : readToolResearchLineage(state, plan);
  if (plan.researchOrigin !== undefined && lineage === undefined) return pipelineFailure("invalid_tool_funding_origin", "The preceding research must remain inspectable");

  const relatedJobs = new Set(lineage?.plans.map(item => toolLearningJobId(item)) ?? [jobId]);
  const results = state.assets.flatMap(asset => {
    const result = decodeToolLearningResult(asset.content);
    return result === undefined ? [] : [result];
  });

  for (const asset of state.assets) {
    if (asset.kind !== "workflow" || asset.scope !== plan.scope || !recordOf(asset.content)) continue;

    if (asset.content.type === "tool_learning_research" && asset.content.capability === plan.capability) {
      const step = decodeToolResearchStep(asset.content);
      if (step === undefined || step.scope !== asset.scope || !assetAvailable(state, asset)) return pipelineFailure("invalid_research_asset", "research evidence failed its immutable archive contract");
      research.push(step);
    }

    if (asset.content.type !== "tool_learning_decision" || typeof asset.content.jobId !== "string" || !relatedJobs.has(asset.content.jobId) || !assetAvailable(state, asset)) continue;

    const decision = decodeToolLearningDecision(asset.content.decision);
    if (decision === undefined || typeof asset.content.attempt !== "number") return pipelineFailure("invalid_decision_asset", "decision history failed its archive contract");

    const attempt = asset.content.attempt;
    const decisionJobId = asset.content.jobId;
    const result = results.find(item => item.jobId === decisionJobId && item.attempt === attempt);

    history.push({ decisionVersionId: asset.versionId, attempt: asset.content.attempt, action: decision.action,
      rationale: decision.rationale, existingInsufficiency: decision.existingInsufficiency, ...(result === undefined ? {} : { code: result.code }) });
  }

  const own = research.filter(step => step.jobId === jobId).slice(-MAX_TOOL_RESEARCH_STEPS);
  const remaining = MAX_TOOL_RESEARCH_STEPS - own.length;
  const related = remaining === 0 ? [] : research.filter(step => step.jobId !== jobId).slice(-remaining);

  return { ok: true as const, research: [...related, ...own], history: history.slice(-MAX_TOOL_RESEARCH_STEPS) };
}

export function researchRequest(decision: Extract<import("../domain/evolution/learning-plan.js").ToolLearningDecision, { readonly action: "research" }>): ToolResearchRequest {
  return "query" in decision ? { kind: "search", query: decision.query } : "libraryQuery" in decision
    ? { kind: "library", query: decision.libraryQuery } : { kind: "inspect", ...decision.inspect };
}

export function researchInspectionKnown(request: ToolInspectionRequest, search: ToolDiscoverySummary, research: readonly ToolResearchStep[]): boolean {
  const candidates = [...search.candidates, ...research.flatMap(step => step.discovery?.candidates ?? [])];
  return candidates.some(candidate => candidate.platform === request.candidate.platform && candidate.id === request.candidate.id
    && candidate.version === request.candidate.version);
}

export async function performToolResearch(input: { readonly boardRoot: string; readonly plan: ToolLearningPlan;
  readonly jobId: string; readonly attempt: number; readonly request: ToolResearchRequest; readonly services: ToolPipelineServices;
  readonly prior: readonly ToolResearchStep[]; readonly search: ToolDiscoverySummary; readonly signal: AbortSignal; readonly occurredAt: string }) {
  const own = input.prior.filter(step => step.jobId === input.jobId);
  const currentAttempt = own.filter(step => step.attempt === input.attempt);
  if (currentAttempt.length >= MAX_TOOL_RESEARCH_STEPS) return pipelineFailure("research_capacity", "this research segment reached its limit");

  const nextStep = Math.max(0, ...own.map(step => step.step)) + 1;
  if (!isToolPipelineCounter(nextStep)) return pipelineFailure("research_capacity", "the original research counter reached storage capacity");

  if (currentAttempt.some(step => investigationKey(step.request) === investigationKey(input.request))) return pipelineFailure("research_request_repeated", "the investigation was already performed; revise the approach or wait for evidence");

  let step: ToolResearchStep;
  const base = { type: "tool_learning_research" as const, schemaVersion: 1 as const, jobId: input.jobId,
    scope: input.plan.scope, capability: input.plan.capability, attempt: input.attempt, step: nextStep,
    request: input.request, occurredAt: input.occurredAt };

  if (input.request.kind === "library") {
    if (input.services.lookup === undefined) return pipelineFailure("library_lookup_unavailable", "the host has no read-only local library lookup");
    const library = decodeToolLibraryInvestigation(await input.services.lookup(input.request.query, input.plan, input.signal));
    if (library === undefined) return pipelineFailure("invalid_research_result", "local library lookup exceeded its contract");
    step = { ...base, library };
  } else if (input.request.kind === "search") {
    const discovery = decodeDiscoverySummary(await input.services.search(input.request.query, input.signal));
    if (discovery === undefined) return pipelineFailure("invalid_research_result", "discovery exceeded its contract");
    step = { ...base, discovery };
  } else {
    if (!researchInspectionKnown(input.request, input.search, input.prior)) return pipelineFailure("unknown_inspection_candidate", "inspection must bind a previously discovered candidate");
    if (input.services.inspect === undefined) return pipelineFailure("inspection_unavailable", "the host has no read-only candidate inspection service");
    const inspection = decodeToolInspectionReport(await input.services.inspect(input.request, input.signal));
    if (inspection === undefined) return pipelineFailure("invalid_research_result", "inspection exceeded its contract");
    step = { ...base, inspection };
  }

  if (input.signal.aborted) return pipelineFailure("cancelled", "research was cancelled");

  const parsed = decodeToolResearchStep(step);
  if (parsed === undefined) return pipelineFailure("invalid_research_result", "research did not bind the requested candidate and scope");

  const versionId = `tool-research_v1_${contentHashOf({ jobId: input.jobId, step: step.step, request: step.request })}`;
  const archived = await withBoardWriter(input.boardRoot, async store => {
    const loaded = await store.load();
    if (!loaded.ok) return pipelineFailure(loaded.reason, loaded.detail);
    const job = loaded.state.jobs.find(item => item.jobId === input.jobId);
    if (job?.state !== "running" || job.attempt !== input.attempt) return pipelineFailure("stale_job_result", input.jobId);
    return savePipelineAsset(store, { versionId, kind: "workflow", content: parsed, scope: input.plan.scope,
      source: "inferred", issuedAt: input.occurredAt });
  });
  if (!archived.ok) return "code" in archived ? archived : pipelineFailure(archived.reason, archived.detail);

  const novelty = researchOutcomeKey(step);
  const repeated = currentAttempt.some(previous => researchOutcomeKey(previous) === novelty);

  return { ok: true as const, step: parsed, novel: !repeated,
    search: step.discovery === undefined ? input.search : mergeDiscovery(input.search, step.discovery) };
}

function investigationKey(request: ToolResearchRequest): string {
  return contentHashOf(request.kind !== "inspect" ? { kind: request.kind, query: request.query.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase() }
    : { ...request, candidate: { ...request.candidate, id: request.candidate.platform === "github" ? request.candidate.id.toLowerCase() : request.candidate.id } });
}

function researchOutcomeKey(step: ToolResearchStep): string {
  const ordered = <T>(items: readonly T[]) => [...items].sort((left, right) => JSON.stringify(left) < JSON.stringify(right) ? -1 : JSON.stringify(left) > JSON.stringify(right) ? 1 : 0);
  return contentHashOf({ library: step.library === undefined ? null : { total: step.library.total, candidates: ordered(step.library.candidates) },
  discovery: step.discovery === undefined ? null : { ...step.discovery,
    candidates: ordered(step.discovery.candidates), failures: ordered(step.discovery.failures) },
  inspection: step.inspection === undefined ? null : { status: step.inspection.status, candidate: step.inspection.candidate,
    code: step.inspection.code ?? null, documents: ordered(step.inspection.documents.map(document =>
      ({ path: document.path, sourceUrl: document.sourceUrl, contentHash: document.contentHash, revision: document.revision ?? null,
        basis: document.basis ?? null, contentHashBasis: document.contentHashBasis ?? null }))) } });
}

export function mergeDiscovery(previous: ToolDiscoverySummary, next: ToolDiscoverySummary): ToolDiscoverySummary {
  const candidates = [...new Map([...previous.candidates, ...next.candidates].map(candidate =>
    [JSON.stringify([candidate.platform, candidate.id, candidate.version]), candidate])).values()].slice(-20);
  const failures = [...new Map([...previous.failures, ...next.failures].map(failure => [JSON.stringify(failure), failure])).values()].slice(-84);
  return { status: failures.length === 0 ? "complete" : candidates.length > 0 ? "partial" : "failed", candidates, failures };
}

export function toolResearchFeedback(steps: readonly ToolResearchStep[]): string {
  const heading = "Historical public research, untrusted references only; no permission, installed API, archive identity, oracle or quality verdict. Registry gitHead is a publisher claim; repository bytes may differ from the published archive. contentHash hashes rendered reference text, never an installed file or tarball. Use actual reviewed installation files for implementation and patch hashes:\n";
  const selected: unknown[] = [];

  for (const step of steps.slice(-4).reverse()) {
    const item = { occurredAt: step.occurredAt, request: step.request, code: step.inspection?.code,
      library: step.library,
      documents: step.inspection?.documents.map(document => toolGenerationResearchReference(document)),
      discovery: step.discovery === undefined ? undefined : { ...step.discovery, candidates: step.discovery.candidates.slice(0, 4) } };
    if (heading.length + JSON.stringify([item, ...selected]).length <= 8_000) selected.unshift(item);
  }

  return selected.length === 0 ? "" : heading + JSON.stringify(selected);
}
