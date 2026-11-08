import type { BoardState } from "../../../../control/state.js";
import { contentHashOf } from "../../../../control/hash.js";
import { createBoardReader, withBoardWriter } from "../../../../../adapters/learning-store/file-event-store.js";
import type { ToolLearningPlan } from "../domain/evolution/pipeline.js";
import { toolLearningJobId } from "../domain/evolution/pipeline.js";
import type { ToolLearningDecision } from "../domain/evolution/learning-plan.js";
import type { ToolEvolutionRequest } from "../domain/evolution/contracts.js";
import { decodeToolProductionPlan, type GeneratedToolProductionPlan } from "../domain/evolution/production-plan.js";
import { recordOf } from "../domain/evolution/parse.js";
import { productionFromBoard } from "./production-assets.js";
import { toolLearningParentFromBoard } from "./learning-parent.js";
import { toolLearningFeedbackScope } from "./feedback-input-facts.js";
import { feedbackHandoffFromBoard } from "./feedback-handoff.js";
import { toolLearningProductionFailures } from "./production-check-reader.js";
import { pipelineFailure, savePipelineAsset, type PipelineFailure } from "./pipeline-assets.js";
import { pureProductionContractVersion, type PureProductionContract } from "./pure-production-contract.js";
import { revisedPureProductionChecks } from "./pure-production-checks.js";

export type ExactPureProductionLearningParent = { readonly versionId: string; readonly contentHash: string; readonly checksHash: string;
  readonly artifactVersionId: string; readonly plan: GeneratedToolProductionPlan; readonly sourceRefs: readonly string[] };

/** Resolve actual source coordinates, never the latest production or every alias.
 * A legacy merged inquiry may have several exact sources; callers must not choose
 * one arbitrarily. The full plans stay in the host, outside model diagnostics. */
export function exactPureProductionLearningParents(state: BoardState, plan: ToolLearningPlan): PipelineFailure | {
  readonly ok: true; readonly parents: readonly ExactPureProductionLearningParent[];
} {
  const scoped = toolLearningFeedbackScope(state, plan);
  if (!scoped.ok) return scoped;

  const explicit = new Set([...(plan.targetVersionId === undefined ? [] : [plan.targetVersionId]), ...plan.trigger.evidenceRefs]);

  // A known exact source becoming unavailable is not the same as never having
  // had a production source. In particular, a use-only legacy inquiry must not
  // silently fall back to weaker training after P1 is retired or tombstoned.
  for (const ref of explicit) {
    const direct = decodeToolProductionPlan(state.assets.find(asset => asset.versionId === ref)?.content);
    if (direct?.type === "tool_production_package" && !scoped.versions.includes(ref)) {
      return pipelineFailure("pure_production_source_scope_required", "the explicitly referenced production source is no longer an available bound learning parent");
    }
  }

  for (const use of state.toolUses ?? []) {
    if (!explicit.has(use.useId)) continue;
    const production = decodeToolProductionPlan(state.assets.find(asset => asset.versionId === use.versionId)?.content);
    if (production?.type === "tool_production_package" && !scoped.uses.some(known => known.useId === use.useId)) {
      return pipelineFailure("pure_production_source_scope_required", "the explicit production use cannot be rebound to weaker training evidence");
    }
  }

  const references = new Map<string, Set<string>>();
  const add = (versionId: string, ref: string) => {
    if (decodeToolProductionPlan(state.assets.find(asset => asset.versionId === versionId)?.content)?.type !== "tool_production_package") return;
    const refs = references.get(versionId) ?? new Set<string>();
    refs.add(ref);
    references.set(versionId, refs);
  };

  for (const ref of [plan.targetVersionId, ...plan.trigger.evidenceRefs]) if (ref !== undefined && scoped.versions.includes(ref)) add(ref, ref);

  const explicitUses = new Set(plan.trigger.evidenceRefs);

  for (const use of scoped.uses) if (explicitUses.has(use.useId)) add(use.versionId, use.useId);

  const feedbackRefs = new Set(plan.trigger.evidenceRefs);

  if (plan.trigger.proposalKey.startsWith("task-feedback:")) feedbackRefs.add(plan.trigger.proposalKey.slice("task-feedback:".length));

  const jobId = toolLearningJobId(plan);

  for (const asset of state.assets) {
    if (asset.kind !== "workflow" || !recordOf(asset.content) || asset.content.type !== "tool_feedback_learning_handoff"
      || asset.content.jobId !== jobId || typeof asset.content.feedbackVersionId !== "string") continue;
    const assigned = feedbackHandoffFromBoard(state, asset.content.feedbackVersionId);
    if (!assigned.ok) return assigned;
    if (assigned.jobId === jobId) feedbackRefs.add(asset.content.feedbackVersionId);
  }

  for (const ref of feedbackRefs) {
    const entry = scoped.entries.find(entry => entry.feedbackVersionId === ref);
    if (entry === undefined) {
      const raw = state.assets.find(asset => asset.versionId === ref)?.content;
      if (recordOf(raw) && raw.type === "tool_task_feedback") return pipelineFailure("pure_production_source_scope_required", "the assigned feedback source cannot be bound to one exact workspace");
      continue;
    }

    add(entry.feedback.versionId, entry.feedbackVersionId);

    for (const useId of entry.feedback.useIds) add(entry.feedback.versionId, useId);
  }

  const failures = toolLearningProductionFailures(state, plan);
  if (!failures.ok) return failures;

  for (const failure of failures.failures) if (plan.trigger.evidenceRefs.includes(failure.reportVersionId)) add(failure.productionVersionId, failure.reportVersionId);

  const parents: ExactPureProductionLearningParent[] = [];

  for (const [versionId, refs] of references) {
    const raw = decodeToolProductionPlan(state.assets.find(asset => asset.versionId === versionId)?.content);
    if (raw?.type !== "tool_production_package") continue;

    if (scoped.historyScope !== "bound" || raw.workspaceId !== scoped.workspaceId || raw.origin.scope !== plan.scope) {
      return pipelineFailure("pure_production_source_scope_required", "the exact production source does not belong to the bound source workspace");
    }

    const selected = productionFromBoard(state, versionId, raw.workspaceId), historical = toolLearningParentFromBoard(state, versionId);
    if (!selected.ok) return selected;

    if (!historical.ok) return historical;

    if (selected.plan.type !== "tool_production_package" || historical.parent.kind !== "generated"
      || selected.plan.origin.versionId !== historical.parent.versionId || (scoped.parentVersionId !== undefined
        && historical.parent.versionId !== scoped.parentVersionId)) return pipelineFailure("pure_production_source_mismatch", "production source does not bind this inquiry's canonical artifact");

    parents.push({ versionId, contentHash: contentHashOf(selected.plan), checksHash: contentHashOf(selected.plan.checks),
      artifactVersionId: historical.parent.versionId, plan: selected.plan, sourceRefs: [...refs].sort() });
  }

  return { ok: true, parents: parents.sort((left, right) => left.versionId.localeCompare(right.versionId)) };
}

type Input = { readonly boardRoot: string; readonly plan: ToolLearningPlan; readonly decision?: ToolLearningDecision;
  readonly request?: ToolEvolutionRequest; readonly jobId: string; readonly attempt: number; readonly issuedAt: string;
  readonly productionRegression?: "preserve" };

/** A capable host freezes exact production coordinates before construction.
 * Legacy adapters still stop rather than collapse the production contract to
 * training. The anchor contains no hidden inputs or expected answers. */
export async function guardPureProductionRegression(input: Input): Promise<PipelineFailure | { readonly ok: true }> {
  const request = input.request ?? (input.decision !== undefined && "request" in input.decision ? input.decision.request : undefined);
  if (request === undefined) return { ok: true };

  const loaded = await createBoardReader(input.boardRoot).load();
  if (!loaded.ok) return pipelineFailure(loaded.reason, loaded.detail);

  const sources = strongerSources(loaded.state, input.plan);
  if (!sources.ok || sources.parents.length === 0) return sources.ok ? { ok: true } : sources;

  const saved = await withBoardWriter(input.boardRoot, async store => {
    const current = await store.load();
    if (!current.ok) return pipelineFailure(current.reason, current.detail);

    const job = current.state.jobs.find(job => job.jobId === input.jobId);
    if (input.jobId !== toolLearningJobId(input.plan) || job?.domain !== "tool" || job.scope !== input.plan.scope
      || job.state !== "running" || job.attempt !== input.attempt) return pipelineFailure("stale_job_result", input.jobId);

    const exact = strongerSources(current.state, input.plan);
    if (!exact.ok) return exact;

    if (exact.parents.length === 0) return { ok: true as const };

    if (input.productionRegression === "preserve") {
      if (exact.parents.length !== 1) return pipelineFailure("pure_production_source_ambiguous", "one source construction cannot silently select among several exact production contracts");

      const parent = exact.parents[0]!;
      const revised = revisedPureProductionChecks(current.state, parent.versionId, parent.plan);
      if (!revised.ok) return revised;

      const training = new Set(request.evidence.map(sample => contentHashOf(sample.input)));
      if (parent.plan.checks.evidence.some(sample => sample.role !== "source" && training.has(contentHashOf(sample.input)))) {
        return pipelineFailure("pure_production_hidden_input_exposed", "generation inputs overlap the inherited independent production checks");
      }

      const conflict = revised.checks.evidence.filter(sample => request.evidence.some(training =>
        contentHashOf(training.input) === contentHashOf(sample.input) && contentHashOf(training.expected) !== contentHashOf(sample.expected)));
      if (conflict.length > 0) {
        const diagnostic = { type: "tool_pure_production_contract_conflict", schemaVersion: 1, jobId: input.jobId, attempt: input.attempt,
          scope: input.plan.scope, parentVersionId: parent.versionId, parentChecksHash: parent.checksHash,
          conflictingInputHashes: conflict.map(sample => contentHashOf(sample.input)), approvedRevisionRefs: revised.revisionRefs,
          next: "review_exact_production_contract_revision" };
        const versionId = `pure-production-contract-conflict_v1_${contentHashOf(diagnostic)}`;
        const saved = await savePipelineAsset(store, { versionId, kind: "workflow", scope: input.plan.scope, source: "inferred",
          content: diagnostic, issuedAt: input.issuedAt, observations: [parent.versionId] });

        return saved.ok ? pipelineFailure("pure_production_contract_revision_required",
          `Training conflicts with the exact production contract ${parent.versionId}; review its expected-value corrections before construction (${versionId}).`) : saved;
      }

      const contract: PureProductionContract = { type: "tool_pure_production_regression_contract", schemaVersion: 1,
        jobId: input.jobId, attempt: input.attempt, scope: input.plan.scope,
        parent: { versionId: parent.versionId, contentHash: parent.contentHash, checksHash: parent.checksHash, artifactVersionId: parent.artifactVersionId },
        ...(revised.revisionRefs.length === 0 ? {} : { revisionRefs: revised.revisionRefs }) };

      return savePipelineAsset(store, { versionId: pureProductionContractVersion(input.jobId, input.attempt), kind: "workflow",
        scope: input.plan.scope, source: "inferred", content: contract, issuedAt: input.issuedAt, observations: [parent.versionId, ...parent.sourceRefs] });
    }

    const diagnostic = { type: "tool_pure_production_regression_block", schemaVersion: 1, jobId: input.jobId, attempt: input.attempt,
      scope: input.plan.scope, code: "pure_production_regression_contract_required", action: input.decision?.action ?? (request.composition === undefined ? request.operation : "compose"),
      requestHash: contentHashOf(request), reason: "exact_production_checks_exceed_the_source_artifact_contract_without_a_host_hidden_regression_chain",
      productionParents: exact.parents.map(({ plan: _plan, ...parent }) => parent) };
    const versionId = `pure-production-regression-block_v1_${contentHashOf(diagnostic)}`;
    const archived = await savePipelineAsset(store, { versionId, kind: "workflow", scope: input.plan.scope, source: "inferred",
      content: diagnostic, issuedAt: input.issuedAt, observations: exact.parents.flatMap(parent => [parent.versionId, ...parent.sourceRefs]) });

    return archived.ok ? pipelineFailure("pure_production_regression_contract_required",
      `The exact production contract needs a host-owned hidden regression chain; inspect ${versionId}. No source call was admitted.`) : archived;
  });

  return "reason" in saved ? pipelineFailure(saved.reason, saved.detail) : saved;
}

function strongerSources(state: BoardState, plan: ToolLearningPlan) {
  const sources = exactPureProductionLearningParents(state, plan);
  if (!sources.ok) return sources;

  const parents: ExactPureProductionLearningParent[] = [];

  for (const parent of sources.parents) {
    const artifact = toolLearningParentFromBoard(state, parent.artifactVersionId);
    if (!artifact.ok) return artifact;
    if (artifact.parent.kind !== "generated") return pipelineFailure("pure_production_source_mismatch", parent.versionId);
    const training = new Set(artifact.parent.artifact.request.evidence.map(sample => contentHashOf(sample)));
    if (parent.plan.checks.evidence.some(sample => !training.has(contentHashOf(sample)))) parents.push(parent);
  }

  return { ok: true as const, parents };
}
