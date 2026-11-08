import type { LearningAllocationOffer, LearningAllocationResources } from "../allocation-contract.js";
import { allocationFits, isAllocationOffer } from "../allocation-shape.js";
import type { LearningJob } from "../contracts.js";
import type { CentralLearningGrant, LearningIssue, LearningIssueReport } from "../coordination-contract.js";
import { centralLearningRemaining, centralLearningSpent, learningDependencyResumable } from "../coordination-contract.js";
import { isCentralLearningGrantAllowance, isCentralLearningGrant, isLearningDependency, isLearningIssue } from "../coordination-parse.js";
import { sameCentralLearningResources } from "../central-learning-resources.js";
import { contentHashOf } from "../hash.js";
import { learningIssueOwner } from "../learning-issue-owner.js";
import type { BoardState } from "../state.js";
import { fields, identity, list, sequence } from "../../../validation/json-shape.js";

/** A domain preparation receipt identifies a real macro-stage. It does not give this
 * projection authority to inspect private assets or certify the domain's readiness claim.
 * The source owner must revalidate that claim again at dispatch.
 */
export type CentralDecisionDomainStage = Readonly<{
  stageRef: string;
  kind: "initial" | "continuation";
  policyRef: string;
  sourceReportId: string;
  readiness:
    | Readonly<{ kind: "ready"; evidenceRefs: readonly string[] }>
    | Readonly<{ kind: "waiting_evidence"; evidenceRefs: readonly string[] }>
    | Readonly<{ kind: "terminal"; reason: string; evidenceRefs: readonly string[] }>;
}>;

export type CentralDecisionStageInput = Readonly<{
  /** The canonical store has already decoded this state. This function never loads or writes it. */
  board: BoardState;
  scope: string;
  budgetId: string;
  issueId: string;
  /** The exact canonical identity returned by the original source preparation, including for a new grant. */
  grantId: string;
  sourceBindingRef: string;
  offer: LearningAllocationOffer;
  domainStage: CentralDecisionDomainStage;
}>;

export type CentralDecisionStageSource = Omit<CentralDecisionStageInput, "board" | "scope" | "budgetId" | "offer">;

/** Validate the untrusted source sidecar before composing it with a decoded Board snapshot. */
export function isCentralDecisionStageSource(value: unknown): value is CentralDecisionStageSource {
  if (!fields(value, ["issueId", "grantId", "sourceBindingRef", "domainStage"])
    || ![value.issueId, value.grantId, value.sourceBindingRef].every(identity)
    || !fields(value.domainStage, ["stageRef", "kind", "policyRef", "sourceReportId", "readiness"])) return false;

  const stage = value.domainStage;
  if (![stage.stageRef, stage.policyRef, stage.sourceReportId].every(identity)
    || (stage.kind !== "initial" && stage.kind !== "continuation")) return false;

  const readiness = stage.readiness;
  if (!(fields(readiness, ["kind", "evidenceRefs"]) && (readiness.kind === "ready" || readiness.kind === "waiting_evidence")
    || fields(readiness, ["kind", "reason", "evidenceRefs"]) && readiness.kind === "terminal" && identity(readiness.reason))) return false;

  return list(readiness.evidenceRefs, 1, 32) && readiness.evidenceRefs.every(identity)
    && new Set(readiness.evidenceRefs).size === readiness.evidenceRefs.length;
}

type StageIdentity = Readonly<{
  stageRef: string;
  kind: "initial" | "continuation";
  sourceBindingRef: string;
  issueId: string;
  grantId: string;
  expectedIssueRevision: number;
  chargedAtBasis: LearningAllocationResources;
  progressRef: string;
  sourceRefs: readonly string[];
}>;

type StageStatus = "waiting_evidence" | "in_flight" | "terminal" | "reconcile_then_replan" | "continue_existing";

export type CentralDecisionStageProjection =
  | (StageIdentity & Readonly<{ status: "ready"; mode: "fund" | "extend" }>)
  | (StageIdentity & Readonly<{ status: StageStatus; reason: string }>)
  | (Omit<StageIdentity, "expectedIssueRevision" | "chargedAtBasis"> & Readonly<{
      status: "needs_source"; reason: string; expectedIssueRevision: number | null;
      chargedAtBasis: LearningAllocationResources | null }>);

/** Read-only stage projection. A ready result is a planning input, never a grant or dispatch permit.
 * No expired lease is reclaimed here: even an expired claim must be resolved by its canonical owner.
 */
export function projectCentralDecisionStage(input: CentralDecisionStageInput): CentralDecisionStageProjection {
  const issue = input.board.learningIssues?.find(item => item.issueId === input.issueId);
  const grant = input.board.centralLearningGrants?.find(item => item.grantId === input.grantId);
  const job = input.board.jobs.find(item => item.jobId === grant?.jobId);
  const dependencies = (input.board.learningDependencies ?? []).filter(item => item.grantId === input.grantId);
  const sourceRefs = [...new Set([input.sourceBindingRef, input.domainStage.stageRef,
    input.domainStage.sourceReportId, ...input.domainStage.readiness.evidenceRefs])];
  const progressRef = `central-stage:${contentHashOf({ boardSequence: input.board.sequence,
    issue: issue ?? null, grant: grant ?? null, job: job ?? null, dependencies, stage: input.domainStage })}`;
  const missing = (reason: string): CentralDecisionStageProjection => ({ status: "needs_source", reason,
    stageRef: input.domainStage.stageRef, kind: input.domainStage.kind, sourceBindingRef: input.sourceBindingRef,
    issueId: input.issueId, grantId: input.grantId, expectedIssueRevision: issue?.revision ?? null,
    chargedAtBasis: grant === undefined ? null : centralLearningSpent(grant), progressRef, sourceRefs });

  if (!validStageInput(input)) return missing("stage_input_invalid");

  if (issue === undefined || !isLearningIssue(issue)) return missing("canonical_issue_required");

  if (issue.scope !== input.scope) return missing("stage_scope_mismatch");

  const report = issue.reports.find(item => item.reportId === input.domainStage.sourceReportId);
  if (report === undefined || !sourceOwnerMatches(issue, report, input.offer)) return missing("stage_source_owner_mismatch");

  if (issue.decision.kind !== "focused_learning") return missing("stage_issue_not_focused");

  if (grant !== undefined && !isCentralLearningGrant(grant)) return missing("canonical_grant_required");

  if (!dependencies.every(isLearningDependency)) return missing("canonical_dependency_required");

  if (grant !== undefined && dependencies.some(item => item.issueId !== issue.issueId || item.jobId !== grant.jobId)) {
    return missing("stage_dependency_binding_mismatch");
  }

  const base: StageIdentity = { stageRef: input.domainStage.stageRef, kind: input.domainStage.kind,
    sourceBindingRef: input.sourceBindingRef, issueId: input.issueId, grantId: input.grantId,
    expectedIssueRevision: issue.revision, chargedAtBasis: grant === undefined ? { tokens: 0, calls: 0, steps: 0 }
      : centralLearningSpent(grant), progressRef, sourceRefs };
  const status = (value: StageStatus, reason: string): CentralDecisionStageProjection => ({ ...base, status: value, reason });

  if (input.domainStage.readiness.kind === "terminal") return status("terminal", input.domainStage.readiness.reason);

  if (grant === undefined) return projectUnfunded(input, issue, base, missing);

  if (job === undefined || !grantMatches(input, issue, grant, job)) return missing("stage_grant_binding_mismatch");

  if (grant.status === "closed" || isTerminalJob(job)) return status("terminal", "original_investment_terminal");

  if (grant.claim !== undefined || grant.reservations.some(item => item.state === "reserved") || job.state === "running") {
    return status("in_flight", "original_worker_or_reservation_pending");
  }

  // Legacy workflow freshness belongs to its source owner. Research can yield
  // and quote another genuine stage on this same open managed grant.
  if (job.breakerOpen || grant.budgetId === undefined && job.attempt >= job.maxAttempts) return status("terminal", "original_worker_attempts_unavailable");

  const failedDependency = dependencies.some(item => ["failed", "rejected", "cancelled"].includes(item.state.kind));
  if (failedDependency) return status("terminal", "original_dependency_terminal");

  if (input.domainStage.readiness.kind === "waiting_evidence" || job.state === "waiting_evidence"
    || job.state === "waiting_approval" || dependencies.some(item => !learningDependencyResumable(item))) {
    return status("waiting_evidence", "original_source_or_dependency_waiting");
  }

  if (job.state !== "queued") return missing("original_worker_boundary_required");

  if (input.offer.maxPromptChars > grant.allowance.maxPromptChars && grant.budgetId !== input.budgetId) return missing("original_prompt_envelope_mismatch");

  if (allocationFits(input.offer.reserve, centralLearningRemaining(grant))) {
    return status("continue_existing", "existing_lifetime_grant_covers_stage");
  }

  if (grant.budgetId !== input.budgetId) return missing("independent_grant_cannot_be_extended");

  const cap = { tokens: grant.allowance.maxTokens, calls: grant.allowance.maxCalls, steps: grant.allowance.maxSteps };
  if (!sameCentralLearningResources(cap, base.chargedAtBasis)) {
    return status("reconcile_then_replan", "release_unused_commitment_before_new_basis");
  }

  if (input.domainStage.kind !== "continuation") return missing("new_source_stage_required_for_extension");

  const desired = { schemaVersion: 2, unit: "total_model_tokens", maxTokens: base.chargedAtBasis.tokens + input.offer.reserve.tokens,
    maxCalls: base.chargedAtBasis.calls + input.offer.reserve.calls, maxSteps: base.chargedAtBasis.steps + input.offer.reserve.steps,
    maxPromptChars: input.offer.maxPromptChars };
  if (!isCentralLearningGrantAllowance(desired)) return missing("original_lifetime_allowance_shape_exhausted");

  return { ...base, status: "ready", mode: "extend" };
}

function projectUnfunded(input: CentralDecisionStageInput, issue: LearningIssue, base: StageIdentity,
  missing: (reason: string) => CentralDecisionStageProjection): CentralDecisionStageProjection {
  if (input.domainStage.kind !== "initial") return missing("continuation_requires_original_grant");

  const previous = input.board.centralLearningGrants?.find(item => item.grantId === issue.grantId);
  if (issue.grantId !== undefined && (previous === undefined || !isCentralLearningGrant(previous))) return missing("previous_issue_grant_required");

  if (previous !== undefined && (previous.status !== "closed" || issue.decision.kind !== "focused_learning"
    || issue.decision.revision <= previous.focusRevision)) return missing("issue_requires_new_source_focus");

  return input.domainStage.readiness.kind === "waiting_evidence"
    ? { ...base, status: "waiting_evidence", reason: "original_source_waiting" }
    : { ...base, status: "ready", mode: "fund" };
}

function sourceOwnerMatches(issue: LearningIssue, report: LearningIssueReport, offer: LearningAllocationOffer): boolean {
  if (offer.owner.plane !== "agent") return false;
  const owner = learningIssueOwner(issue), reportOwner = learningIssueOwner({ reports: [report] });
  return owner === reportOwner && (owner === "method" ? "prompt" : owner) === offer.owner.domain;
}

function grantMatches(input: CentralDecisionStageInput, issue: LearningIssue, grant: CentralLearningGrant,
  job: LearningJob | undefined): boolean {
  return input.offer.owner.plane === "agent" && grant.issueId === issue.issueId && grant.scope === input.scope
    && issue.grantId === grant.grantId && issue.jobId === grant.jobId && (grant.domain ?? "collaboration") === input.offer.owner.domain
    && issue.decision.kind === "focused_learning" && grant.focusRevision === issue.decision.revision
    && job !== undefined && job.scope === input.scope && job.domain === input.offer.owner.domain
    && job.coordination?.issueId === issue.issueId && job.coordination.grantId === grant.grantId
    && (grant.budgetId === undefined || grant.budgetId === input.budgetId);
}

function isTerminalJob(job: LearningJob): boolean {
  return ["succeeded", "failed", "cancelled", "expired"].includes(job.state);
}

function validStageInput(input: CentralDecisionStageInput): boolean {
  const source: CentralDecisionStageSource = { issueId: input.issueId, grantId: input.grantId,
    sourceBindingRef: input.sourceBindingRef, domainStage: input.domainStage };
  return isCentralDecisionStageSource(source) && identity(input.scope) && identity(input.budgetId)
    && sequence(input.board.sequence) && isAllocationOffer(input.offer) && input.offer.owner.plane === "agent"
    && input.domainStage.policyRef === input.offer.policyRef;
}
