import type { ContentDomainFeedbackChange } from "../../../../../integration/learning-content/sources/domain-feedback.js";
import type { BoardState } from "../../../../control/state.js";
import type { LearningAssetVersion } from "../../../../control/contracts.js";
import { contentHashOf } from "../../../../control/hash.js";
import { decodeToolLearningPlan, decodeToolLearningResult, planVersionId, resultVersionId, toolLearningJobId,
  validToolPipelineJobs, type ToolLearningPlan } from "../domain/evolution/pipeline.js";
import { toolLearningFundingIdentity } from "../domain/evolution/funding-identity.js";
import { decodeToolProductionPlan } from "../domain/evolution/production-plan.js";
import { decodeToolTaskFeedbackArtifact } from "../domain/evolution/task-feedback.js";
import { decodeApprovedToolContractRevision, decodeToolContractRevisionProposal, toolContractProposalId, toolContractRevisionId } from "../domain/evolution/contract-revision.js";
import { recordOf } from "../domain/evolution/parse.js";
import { assetAvailable } from "../domain/evolution/asset-availability.js";
import { productionFromBoard } from "./production-assets.js";
import { toolFundingOriginFromBoard } from "./tool-funding-origin.js";
import { contractRevisionReviewFromBoard } from "./contract-revisions.js";
import { checkValidationRecord } from "../../../../verification-authority/validation-record.js";
import { selectToolFocusedSource } from "./central-source.js";
import { readToolResearchLineage } from "../domain/evolution/research-lineage.js";

type Options = { readonly scope: string; readonly workspaceId?: string };

type Kind = ContentDomainFeedbackChange["kind"];

const jobNode = (id: string) => `job:${id}`;
const versionNode = (id: string) => `version:${id}`;
const proposalNode = (id: string) => `proposal:${id}`;

/** Batch discovery over one decoded Board. The graph contains native lineage
 * identities only; no complete per-issue feedback bodies or new state are built.
 * A proposal, research checkpoint, download or financial row is never delivery. */
export function projectToolCentralFeedbackChanges(board: BoardState, input: Options): readonly ContentDomainFeedbackChange[] {
  if (!validToolPipelineJobs(board)) throw new Error("tool_feedback_changes:invalid_pipeline_job");

  const assets = new Map(board.assets.map(asset => [asset.versionId, asset]));
  const jobs = new Map(board.jobs.map(job => [job.jobId, job]));
  const proposals = new Map(board.proposals.map(proposal => [proposal.proposalId, proposal]));
  const availability = new Map<string, boolean>();
  const available = (asset: LearningAssetVersion): boolean => {
    const prior = availability.get(asset.versionId);
    if (prior !== undefined) return prior;
    const value = assetAvailable(board, asset);
    availability.set(asset.versionId, value);
    return value;
  };
  const plans = new Map<string, ToolLearningPlan>(), edges = new Map<string, Set<string>>();
  const owners = new Map<string, Set<string>>(), sourceRefs = new Map<string, readonly string[]>();
  const issueWorkspaces = new Map<string, string>(), nodeWorkspaces = new Map<string, string>();
  const edge = (from: string, to: string) => {
    const next = edges.get(from) ?? new Set<string>();
    next.add(to);
    edges.set(from, next);
  };

  for (const asset of board.assets) {
    if (asset.kind !== "workflow" || !recordOf(asset.content) || asset.content.type !== "tool_learning_plan") continue;
    const plan = decodeToolLearningPlan(asset.content);
    if (plan === undefined) continue;
    const id = toolLearningJobId(plan), job = jobs.get(id);
    if (asset.versionId !== planVersionId(id) || asset.scope !== plan.scope || job?.domain !== "tool" || job.scope !== plan.scope
      || input.workspaceId !== undefined && plan.scope !== input.workspaceId || !available(asset)) continue;
    plans.set(id, plan);
  }

  for (const issue of board.learningIssues ?? []) {
    if (issue.scope !== input.scope && (input.workspaceId === undefined || issue.scope !== input.workspaceId)) continue;

    const report = issue.reports[0];
    if (report === undefined || !("subsystem" in report.source) || report.source.subsystem !== "tool") continue;

    const original = plans.get(report.source.versionId);
    if (original === undefined || toolLearningFundingIdentity(original).issueId !== issue.issueId) continue;

    const selected = selectToolFocusedSource(board, issue, original.scope, issue.scope);
    if (!selected.ok) continue;

    const plan = selected.plan, lineage = readToolResearchLineage(board, plan);
    const episodeIds = lineage?.plans.map(episode => toolLearningJobId(episode)) ?? [selected.jobId];

    for (const id of episodeIds) owners.set(jobNode(id), new Set([issue.issueId]));

    sourceRefs.set(issue.issueId, [issue.issueId, ...episodeIds.map(id => planVersionId(id))]);
    issueWorkspaces.set(issue.issueId, plan.scope);
  }

  // An inquiry materializer may produce another review plan, but the original
  // lineage proof still selects its root issue and original purse.
  for (const [id, plan] of plans) {
    if (plan.fundingOrigin !== undefined || plan.researchOrigin !== undefined) {
      const origin = toolFundingOriginFromBoard(board, plan);
      if (!origin.ok) continue;
      edge(jobNode(origin.rootJobId), jobNode(id));
    }
    if (plan.targetVersionId !== undefined) edge(jobNode(id), versionNode(plan.targetVersionId));
  }

  for (const asset of board.assets) {
    if (asset.kind !== "workflow" || !recordOf(asset.content) || asset.content.type !== "tool_learning_result") continue;

    const result = decodeToolLearningResult(asset.content);
    if (result === undefined) continue;

    const plan = plans.get(result.jobId), job = jobs.get(result.jobId);
    if (plan === undefined || job === undefined || result.attempt > job.attempt || asset.scope !== plan.scope
      || asset.versionId !== resultVersionId(result.jobId, result.attempt) || !available(asset)) continue;

    if (result.candidateVersionId !== undefined) edge(jobNode(result.jobId), versionNode(result.candidateVersionId));

    if (result.contractProposalId !== undefined) edge(jobNode(result.jobId), versionNode(result.contractProposalId));

    const decision = result.decisionVersionId === undefined ? undefined : assets.get(result.decisionVersionId);
    if (decision === undefined || !recordOf(decision.content) || !available(decision) || decision.scope !== plan.scope
      || decision.content.type !== "tool_learning_decision" || decision.content.jobId !== result.jobId || decision.content.attempt !== result.attempt
      || contentHashOf(decision.content.decision) !== contentHashOf(result.decision)) continue;

    if (typeof decision.content.selectedToolVersionId === "string") edge(jobNode(result.jobId), versionNode(decision.content.selectedToolVersionId));
  }

  const production = new Map<string, NonNullable<ReturnType<typeof decodeToolProductionPlan>>>();

  for (const asset of board.assets) {
    if (asset.kind !== "tool_package") continue;

    const plan = decodeToolProductionPlan(asset.content);
    if (plan === undefined || input.workspaceId !== undefined && plan.workspaceId !== input.workspaceId
      || !productionFromBoard(board, asset.versionId, plan.workspaceId).ok) continue;

    production.set(asset.versionId, plan);
    nodeWorkspaces.set(versionNode(asset.versionId), plan.workspaceId);
    edge(versionNode(plan.origin.versionId), versionNode(asset.versionId));

    if (plan.type === "npm_tool_production_package" && plan.learning !== undefined) {
      const learning = jobs.get(plan.learning.jobId);
      if (plans.has(plan.learning.jobId)) edge(jobNode(plan.learning.jobId), versionNode(asset.versionId));
      else if (learning?.domain === "tool" && learning.scope === plan.origin.scope && plans.has(learning.observationId)) {
        edge(jobNode(learning.observationId), versionNode(asset.versionId));
      }
    }
  }

  for (const asset of board.assets) if (asset.createdFromProposalId !== undefined) {
    const workspace = nodeWorkspaces.get(versionNode(asset.versionId)) ?? asset.scope;
    nodeWorkspaces.set(versionNode(asset.versionId), workspace);
    nodeWorkspaces.set(proposalNode(asset.createdFromProposalId), workspace);
    edge(versionNode(asset.versionId), proposalNode(asset.createdFromProposalId));
  }

  for (const asset of board.assets) {
    if (asset.kind !== "workflow" || !recordOf(asset.content) || asset.content.type !== "tool_contract_revision_proposal") continue;
    const proposal = decodeToolContractRevisionProposal(asset.content);
    if (proposal !== undefined && asset.versionId === toolContractProposalId(proposal) && asset.scope === proposal.scope
      && asset.contentHash === contentHashOf(asset.content)) edge(versionNode(proposal.parentVersionId), versionNode(asset.versionId));
  }

  const queue = [...owners.keys()];

  for (let cursor = 0; cursor < queue.length; cursor++) {
    const node = queue[cursor]!, assigned = owners.get(node)!;
    for (const next of edges.get(node) ?? []) {
      const selected = owners.get(next) ?? new Set<string>(), before = selected.size;
      for (const issueId of assigned) selected.add(issueId);
      if (selected.size !== before) {
        owners.set(next, selected);
        queue.push(next);
      }
    }
  }

  const changes = new Map<string, ContentDomainFeedbackChange>();
  const add = (node: string, factRef: string, unitRef: string, revisionRef: string, kind: Kind, refs: readonly string[] = []) => {
    for (const issueId of owners.get(node) ?? []) {
      const workspace = nodeWorkspaces.get(node);
      if (workspace !== undefined && workspace !== issueWorkspaces.get(issueId)) continue;
      const value: ContentDomainFeedbackChange = { domain: "tool", issueId, factRef, unitRef, revisionRef, kind,
        sourceRefs: [...new Set([...(sourceRefs.get(issueId) ?? []), factRef, ...refs])].sort() };
      changes.set(JSON.stringify([issueId, unitRef, revisionRef, kind]), value);
    }
  };
  const uses = new Map((board.toolUses ?? []).map(use => [use.useId, use]));

  for (const use of uses.values()) {
    const asset = assets.get(use.versionId);
    if (asset === undefined || asset.contentHash !== use.contentHash || asset.contentHash !== contentHashOf(asset.content) || asset.scope !== use.scope
      || use.workspaceId !== nodeWorkspaces.get(versionNode(use.versionId))
      || input.workspaceId !== undefined && use.workspaceId !== input.workspaceId) continue;

    // frozen-use writes this immutable receipt only after invoking the executor.
    // It establishes dispatch/use, while its own quality remains unverified.
    add(versionNode(use.versionId), use.useId, `tool-dispatch:${use.useId}`, use.useId, "delivery", [use.versionId, use.toolCallId]);
    add(versionNode(use.versionId), use.useId, `tool-use:${use.useId}`, use.useId, "adoption", [use.versionId, ...(use.usageLessonRefs ?? [])]);
  }

  for (const approval of board.approvals) if (approval.status !== "pending") add(proposalNode(approval.proposalId), approval.approvalId,
    `tool-approval:${approval.approvalId}`, `${approval.approvalId}:${approval.status}`, "approval", [approval.proposalId]);

  for (const activation of board.activations) {
    if (!production.has(activation.versionId) && (activation.previousVersionId === undefined || !production.has(activation.previousVersionId))) continue;
    const refs = [activation.versionId, ...(activation.previousVersionId === undefined ? [] : [activation.previousVersionId])];
    // Pointer changes are configuration adoption, never a claim of task use.
    for (const versionId of refs) add(versionNode(versionId), activation.activationId, `tool-activation-pointer:${activation.activationId}`,
      `${activation.activationId}:generation:${activation.generation}`, activation.pointer === "active" ? "adoption" : "correction", refs);
  }

  for (const evidence of board.evidence) {
    const asset = assets.get(evidence.dataVersion);
    if (asset?.createdFromProposalId !== evidence.proposalId || evidence.receipt === undefined) continue;
    add(versionNode(asset.versionId), evidence.evidenceId, `tool-check:${evidence.evidenceId}`, evidence.evidenceId,
      "quality", [asset.versionId, evidence.receipt.receiptId]);
  }

  for (const trial of board.toolTrials ?? []) {
    const asset = assets.get(trial.versionId);
    if (asset?.scope !== trial.scope) continue;
    add(versionNode(trial.versionId), trial.trialId, `tool-trial:${trial.versionId}:${trial.trialId}`, trial.trialId, "quality", [trial.versionId]);
  }

  for (const asset of board.assets) {
    if (asset.kind !== "workflow" || !recordOf(asset.content)) continue;
    if (asset.content.type === "tool_task_feedback") {
      const artifact = decodeToolTaskFeedbackArtifact(asset.content);
      if (artifact === undefined || asset.scope !== artifact.scope || !available(asset)) continue;

      const feedback = artifact.feedback, target = assets.get(feedback.versionId);
      if (target?.contentHash !== artifact.contentHash || target.scope !== artifact.scope || feedback.useIds.some(id => {
        const use = uses.get(id);
        return use === undefined || use.versionId !== feedback.versionId || use.contentHash !== artifact.contentHash
          || use.workspaceId !== nodeWorkspaces.get(versionNode(feedback.versionId))
          || use.sessionId !== feedback.sessionId || use.scope !== artifact.scope;
      })) continue;

      const refs = [feedback.versionId, ...feedback.useIds, ...feedback.evidenceRefs];

      add(versionNode(feedback.versionId), asset.versionId, `tool-assessment:${feedback.feedbackId}`, asset.versionId, "quality", refs);

      if (feedback.source === "user" && ["change_usage", "improve", "replace", "avoid"].includes(feedback.recommendation)) {
        add(versionNode(feedback.versionId), asset.versionId, `tool-correction:${feedback.feedbackId}`, asset.versionId, "correction", refs);
      }
    } else if (asset.content.type === "tool_contract_revision_approved") {
      const revision = decodeApprovedToolContractRevision(asset.content);
      if (revision === undefined || asset.versionId !== revision.revisionId || revision.revisionId !== toolContractRevisionId(revision.proposal)
        || asset.scope !== revision.proposal.scope || !available(asset)) continue;

      const proposalId = toolContractProposalId(revision.proposal), review = contractRevisionReviewFromBoard(board, proposalId, asset.scope);
      if (!review.ok || !review.approved || review.revisionId !== revision.revisionId) continue;

      add(versionNode(revision.proposal.parentVersionId), asset.versionId, `tool-contract:${proposalId}`, asset.versionId,
        "correction", [revision.proposal.parentVersionId, proposalId]);
      add(versionNode(revision.proposal.parentVersionId), asset.versionId, `tool-contract-approval:${proposalId}`, asset.versionId,
        "approval", [revision.proposal.parentVersionId, revision.approval.grantId]);
    } else if (asset.content.type === "tool_production_check_report" && typeof asset.content.versionId === "string"
      && typeof asset.content.jobId === "string" && production.has(asset.content.versionId) && available(asset)) {
      const target = assets.get(asset.content.versionId), job = jobs.get(asset.content.jobId);
      const checked = checkValidationRecord(asset.content.record);
      if (asset.content.schemaVersion !== 1 || asset.source !== "user_explicit" || !checked.ok || checked.record.packageVersionId !== target?.versionId
        || job?.domain !== "tool" || job.scope !== asset.scope || job.observationId !== target?.createdFromProposalId
        || job.attempt !== 1 || !["succeeded", "failed", "cancelled"].includes(job.state)
        || !["verified", "failed", "cancelled"].includes(String(asset.content.outcome))
        || job.state !== (asset.content.outcome === "verified" ? "succeeded" : asset.content.outcome)
        || asset.versionId !== `production-check-report:${contentHashOf(asset.content)}`) continue;

      add(versionNode(asset.content.versionId), asset.versionId, `tool-production-check:${job.jobId}`, asset.versionId,
        "quality", [asset.content.versionId, job.jobId]);
    }
  }

  for (const asset of board.assets) {
    const proposal = asset.createdFromProposalId === undefined ? undefined : proposals.get(asset.createdFromProposalId);
    if (proposal !== undefined && ["rejected", "suspended", "rolled_back", "retired"].includes(proposal.lifecycle)) {
      add(versionNode(asset.versionId), asset.versionId, `tool-lifecycle:${asset.versionId}`,
        `${proposal.proposalId}:${proposal.lifecycle}`, "correction", [asset.versionId]);
    }
  }

  for (const dependency of board.learningDependencies ?? []) {
    if (!sourceRefs.has(dependency.issueId) || dependency.state.kind === "waiting" || dependency.state.kind === "unavailable") continue;
    const node = `dependency:${dependency.dependencyId}`;
    owners.set(node, new Set([dependency.issueId]));
    add(node, dependency.dependencyId, node, `${dependency.dependencyId}:revision:${dependency.revision}`, "dependency",
      [dependency.correlationRef, ...(dependency.requestId === undefined ? [] : [dependency.requestId])]);
  }

  return [...changes.values()].sort((a, b) => a.issueId.localeCompare(b.issueId) || a.unitRef.localeCompare(b.unitRef)
    || a.revisionRef.localeCompare(b.revisionRef) || a.kind.localeCompare(b.kind));
}
