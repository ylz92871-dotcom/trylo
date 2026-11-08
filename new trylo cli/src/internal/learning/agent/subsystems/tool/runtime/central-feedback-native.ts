import type { ContentDomainFeedbackChange } from "../../../../../integration/learning-content/sources/domain-feedback.js";
import type { BoardState } from "../../../../control/state.js";
import { contentHashOf } from "../../../../control/hash.js";
import type { ToolLearningPlan } from "../domain/evolution/pipeline.js";
import { decodeToolProductionPlan } from "../domain/evolution/production-plan.js";
import { decodeApprovedToolContractRevision, decodeToolContractRevisionProposal, toolContractProposalId } from "../domain/evolution/contract-revision.js";
import { recordOf } from "../domain/evolution/parse.js";
import { assetAvailable } from "../domain/evolution/asset-availability.js";
import { planForJob, resultForJob } from "./pipeline-records.js";
import { toolFundingOriginFromBoard } from "./tool-funding-origin.js";
import { productionFromBoard } from "./production-assets.js";
import { candidateFromBoard } from "./evolution-reader.js";
import { contractRevisionReviewFromBoard } from "./contract-revisions.js";
import { checkValidationRecord } from "../../../../verification-authority/validation-record.js";

type ChangeKind = ContentDomainFeedbackChange["kind"];

export type NativeToolFeedbackIdentity = { readonly unitRef: string; readonly revisionRef: string; readonly changeKind: ChangeKind };

type NativeRecord = NativeToolFeedbackIdentity & { readonly kind: string; readonly unit: string; readonly factRef: string; readonly payload: unknown };

type Input = { readonly issueId: string; readonly scope: string; readonly jobId: string; readonly plan: ToolLearningPlan;
  readonly versions: ReadonlySet<string>; readonly producedVersions: ReadonlySet<string>;
  readonly changes: readonly ContentDomainFeedbackChange[] };

/** Compare advertisements with identities reconstructed from the raw owner row.
 * Directory strings never become a body or a revision without this match. */
export function nativeToolFeedbackIdentities(changes: readonly ContentDomainFeedbackChange[], issueId: string,
  kind: string, factRef: string, payload: unknown): readonly NativeToolFeedbackIdentity[] {
  if (!recordOf(payload)) return [];

  const expected: NativeToolFeedbackIdentity[] = [];
  const expect = (unitRef: string, revisionRef: string, changeKind: ChangeKind) => { expected.push({ unitRef, revisionRef, changeKind }); };

  if (kind === "tool_invocation" && payload.useId === factRef) {
    expect(`tool-dispatch:${factRef}`, factRef, "delivery");
    expect(`tool-use:${factRef}`, factRef, "adoption");
  } else if (kind === "tool_approval" && payload.approvalId === factRef && typeof payload.status === "string" && payload.status !== "pending") {
    expect(`tool-approval:${factRef}`, `${factRef}:${payload.status}`, "approval");
  } else if (kind === "tool_activation" && payload.activationId === factRef && typeof payload.generation === "number") {
    expect(`tool-activation-pointer:${factRef}`, `${factRef}:generation:${payload.generation}`, payload.pointer === "active" ? "adoption" : "correction");
  } else if (kind === "tool_checker_archive" && payload.evidenceId === factRef && recordOf(payload.receipt)) {
    expect(`tool-check:${factRef}`, factRef, "quality");
  } else if (kind === "tool_task_assessment" && typeof payload.feedbackId === "string") {
    expect(`tool-assessment:${payload.feedbackId}`, factRef, "quality");
    if (payload.source === "user" && ["change_usage", "improve", "replace", "avoid"].includes(String(payload.recommendation))) {
      expect(`tool-correction:${payload.feedbackId}`, factRef, "correction");
    }
  } else if (kind === "tool_asset_lifecycle" && payload.versionId === factRef && typeof payload.proposalId === "string"
    && ["rejected", "suspended", "rolled_back", "retired"].includes(String(payload.lifecycle))) {
    expect(`tool-lifecycle:${factRef}`, `${payload.proposalId}:${String(payload.lifecycle)}`, "correction");
  } else if (kind === "tool_trial" && payload.trialId === factRef && typeof payload.versionId === "string") {
    expect(`tool-trial:${payload.versionId}:${factRef}`, factRef, "quality");
  } else if (kind === "tool_dependency" && payload.dependencyId === factRef && typeof payload.revision === "number"
    && recordOf(payload.state) && payload.state.kind !== "waiting" && payload.state.kind !== "unavailable") {
    expect(`dependency:${factRef}`, `${factRef}:revision:${payload.revision}`, "dependency");
  } else if (kind === "tool_contract_revision") {
    const revision = decodeApprovedToolContractRevision(payload);
    if (revision !== undefined && revision.revisionId === factRef) {
      const proposalId = toolContractProposalId(revision.proposal);
      expect(`tool-contract:${proposalId}`, factRef, "correction");
      expect(`tool-contract-approval:${proposalId}`, factRef, "approval");
    }
  } else if (kind === "tool_production_check_report" && typeof payload.jobId === "string") {
    expect(`tool-production-check:${payload.jobId}`, factRef, "quality");
  }

  return expected.filter(identity => changes.some(change => change.domain === "tool" && change.issueId === issueId && change.factRef === factRef
    && change.unitRef === identity.unitRef && change.revisionRef === identity.revisionRef && change.kind === identity.changeKind));
}

/** Metadata selects where to look, never what to believe. Only these requested
 * units are re-read against native lineage; this does not project the directory. */
export function readNativeToolFeedbackUnits(board: BoardState, input: Input) {
  const changes = input.changes.filter(change => change.domain === "tool" && change.issueId === input.issueId);
  const refs = new Set(changes.flatMap(change => [change.factRef, ...change.sourceRefs]));
  const facts = new Set(changes.map(change => change.factRef)), versions = new Set(input.versions), producedVersions = new Set(input.producedVersions), records: NativeRecord[] = [];
  const assets = new Map(board.assets.map(asset => [asset.versionId, asset])), jobs = new Map(board.jobs.map(job => [job.jobId, job]));
  const root = toolFundingOriginFromBoard(board, input.plan), relatedJobs = new Map<string, boolean>();
  const add = (kind: string, unit: string, factRef: string, payload: unknown) => {
    for (const identity of nativeToolFeedbackIdentities(changes, input.issueId, kind, factRef, payload)) {
      records.push({ kind, unit, factRef, payload, ...identity });
    }
  };
  const relatedJob = (id: string, seen = new Set<string>()): boolean => {
    const known = relatedJobs.get(id);
    if (known !== undefined) return known;

    if (!root.ok || seen.has(id) || seen.size >= 16) return false;

    seen.add(id);
    const job = jobs.get(id);
    if (job?.domain !== "tool" || job.scope !== input.scope) return false;

    if (id === input.jobId) return true;

    const plan = planForJob(board, id);
    const origin = plan === undefined ? undefined : toolFundingOriginFromBoard(board, plan);
    const matches = origin?.ok === true && origin.rootJobId === root.rootJobId && origin.rootPlanHash === root.rootPlanHash
      || (id.startsWith("tool-adaptation_v1_") || id.startsWith("tool-acquisition-inquiry_v1_")) && relatedJob(job.observationId, seen);

    relatedJobs.set(id, matches);
    return matches;
  };
  const relatedCandidate = (versionId: string): boolean => {
    if (versions.has(versionId)) return true;
    const selected = candidateFromBoard(board, versionId);
    if (!selected.ok || selected.artifact.request.scope !== input.scope) return false;
    const match = /^(tool-learning_v1_[a-f0-9]{64}):([1-9][0-9]*)$/.exec(selected.artifact.request.requestId);
    return match !== null && relatedJob(match[1]!) && resultForJob(board, match[1]!, Number(match[2]))?.candidateVersionId === versionId;
  };

  for (const ref of refs) {
    const asset = assets.get(ref);
    if (asset?.kind === "workflow" && recordOf(asset.content) && asset.content.type === "tool_contract_revision_proposal") {
      const proposal = decodeToolContractRevisionProposal(asset.content);
      // Withdrawal deliberately makes the correction unavailable for execution.
      // Its immutable original proposal still exposes its real lifecycle body.
      if (proposal !== undefined && versions.has(proposal.parentVersionId) && proposal.scope === input.scope
        && asset.scope === input.scope && asset.versionId === toolContractProposalId(proposal) && asset.contentHash === contentHashOf(asset.content)) versions.add(ref);
      continue;
    }

    if (asset?.kind !== "tool_package") continue;

    const plan = decodeToolProductionPlan(asset.content);
    if (plan === undefined) {
      if (relatedCandidate(ref)) {
        if (!versions.has(ref)) producedVersions.add(ref);
        versions.add(ref);
      }
      continue;
    }

    if (plan.workspaceId !== input.scope || !productionFromBoard(board, ref, plan.workspaceId).ok) continue;

    if (relatedCandidate(plan.origin.versionId) || plan.type === "npm_tool_production_package" && plan.learning !== undefined && relatedJob(plan.learning.jobId)) {
      versions.add(ref);
      if (producedVersions.has(plan.origin.versionId) || !input.versions.has(plan.origin.versionId)
        || plan.type === "npm_tool_production_package" && plan.learning !== undefined && relatedJob(plan.learning.jobId)) producedVersions.add(ref);
    }
  }

  for (const trial of board.toolTrials ?? []) if (facts.has(trial.trialId) && versions.has(trial.versionId)
    && assets.get(trial.versionId)?.scope === trial.scope && refs.has(trial.versionId)) {
    add("tool_trial", "tool_trial_verification", trial.trialId, trial);
  }

  for (const dependency of board.learningDependencies ?? []) if (facts.has(dependency.dependencyId) && dependency.issueId === input.issueId) {
    if (dependency.state.kind === "waiting" || dependency.state.kind === "unavailable"
      || !changes.some(change => change.factRef === dependency.dependencyId && change.kind === "dependency"
        && change.revisionRef === `${dependency.dependencyId}:revision:${dependency.revision}`)) continue;
    const issue = board.learningIssues?.find(row => row.issueId === input.issueId);
    if (issue === undefined || dependency.grantId !== issue.grantId || dependency.jobId !== issue.jobId) continue;
    add("tool_dependency", "tool_dependency_state", dependency.dependencyId, dependency);
  }

  for (const factRef of facts) {
    const asset = assets.get(factRef);
    if (asset?.kind !== "workflow" || !recordOf(asset.content) || !assetAvailable(board, asset)) continue;

    if (asset.content.type === "tool_contract_revision_approved") {
      const revision = decodeApprovedToolContractRevision(asset.content);
      if (revision === undefined || revision.revisionId !== asset.versionId || !versions.has(revision.proposal.parentVersionId)) continue;
      const review = contractRevisionReviewFromBoard(board, toolContractProposalId(revision.proposal), input.scope);
      if (!review.ok || !review.approved || review.revisionId !== revision.revisionId) continue;
      add("tool_contract_revision", "tool_contract_correction_approval", factRef, revision);
    } else if (asset.content.type === "tool_production_check_report" && typeof asset.content.versionId === "string"
      && typeof asset.content.jobId === "string" && versions.has(asset.content.versionId)) {
      const job = jobs.get(asset.content.jobId), target = assets.get(asset.content.versionId), checked = checkValidationRecord(asset.content.record);
      if (asset.content.schemaVersion !== 1 || asset.source !== "user_explicit" || !checked.ok
        || checked.record.packageVersionId !== asset.content.versionId || job?.domain !== "tool" || job.scope !== asset.scope
        || job.observationId !== target?.createdFromProposalId || job.attempt !== 1
        || !["verified", "failed", "cancelled"].includes(String(asset.content.outcome))
        || job.state !== (asset.content.outcome === "verified" ? "succeeded" : asset.content.outcome)
        || asset.versionId !== `production-check-report:${contentHashOf(asset.content)}`) continue;

      add("tool_production_check_report", "tool_production_check_return", factRef, asset.content);
    }
  }

  return { versions: [...versions].filter(versionId => !input.versions.has(versionId)), producedVersions: [...producedVersions], records };
}
