import type { CentralLearningAllowance, CentralLearningGrantAllowance, CentralLearningGrant, CentralLearningUsage, CoordinationAction,
  LearningDependency, LearningDependencyDraft, LearningDependencyState, LearningIssue, LearningIssueReport } from "./coordination-contract.js";
import { CENTRAL_LEARNING_AGENT_DOMAINS } from "./coordination-contract.js";
import { MAX_CENTRAL_LEARNING_RESOURCE } from "./central-learning-resources.js";
import { centralBudgetSequence, hasCentralBudgetBinding, isCentralBudgetAction, isCentralLearningBudgetRootRef, validOptionalCentralBudgetBinding } from "./central-budget-parse.js";
import { coordinationScopeValid } from "./coordination-scope.js";

export { coordinationScopeValid } from "./coordination-scope.js";

type Row = Record<string, unknown>;

/** Public PA projections use these same persisted decision limits; this does not widen the Board contract. */
export const COORDINATION_DECISION_LIMITS = Object.freeze({ reasonMaxChars: 1000, sourceRefMaxChars: 512,
  maxSourceRefs: 32, issueIdMaxChars: 512, maxRevision: 1_000_000_000 });
const row = (v: unknown): v is Row => v !== null && typeof v === "object" && !Array.isArray(v);
const exact = (v: Row, keys: readonly string[]) => Object.keys(v).every(k => keys.includes(k));
const text = (v: unknown, max = 512): v is string => typeof v === "string" && !!v.trim() && v.length <= max;
const integer = (v: unknown, max = 1_000_000_000): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= max;
const refs = (v: unknown, max = 32, maxChars = 512): v is string[] => Array.isArray(v) && v.length <= max && v.every(x => text(x, maxChars)) && new Set(v).size === v.length;
const date = (v: unknown): v is string => text(v, 64) && Number.isFinite(Date.parse(v));
const decision = (v: unknown) => v === "resolved" || v === "ordinary_execution" || v === "focused_learning";
const domain = (v: unknown) => v === undefined || CENTRAL_LEARNING_AGENT_DOMAINS.some(item => item === v);
export const isCoordinationDecisionReason = (v: unknown): v is string => text(v, COORDINATION_DECISION_LIMITS.reasonMaxChars);
export const isCoordinationDecisionSourceRefs = (v: unknown): v is string[] =>
  refs(v, COORDINATION_DECISION_LIMITS.maxSourceRefs, COORDINATION_DECISION_LIMITS.sourceRefMaxChars);

function researchSource(v: Row): boolean {
  const sourceDomain = v.domain;
  return exact(v, ["kind", "domain", "requestRef", "intentRef"]) && CENTRAL_LEARNING_AGENT_DOMAINS.some(item => item === sourceDomain)
    && text(v.requestRef) && text(v.intentRef);
}

export function isLearningIssueReport(v: unknown): v is LearningIssueReport {
  return row(v) && exact(v, ["reportId", "source", "facts", "hypotheses", "evidenceRefs"]) && text(v.reportId)
    && row(v.source) && (v.source.kind === "research_request"
      ? researchSource(v.source)
      : v.source.subsystem === "method" || v.source.subsystem === "tool" || v.source.subsystem === "workflow" || v.source.subsystem === "skill"
      ? exact(v.source, ["subsystem", "taskId", "versionId"]) && text(v.source.taskId) && text(v.source.versionId)
      : exact(v.source, ["teamRunId", "taskId", "memberId"]) && [v.source.teamRunId, v.source.taskId, v.source.memberId].every(x => text(x)))
    && Array.isArray(v.facts) && v.facts.length > 0 && v.facts.length <= 8 && v.facts.every(x => text(x, 1500))
    && (v.hypotheses === undefined || Array.isArray(v.hypotheses) && v.hypotheses.length <= 8 && v.hypotheses.every(x => text(x, 1000))) && refs(v.evidenceRefs);
}

export function isLearningJobCoordination(v: unknown): boolean {
  return row(v) && exact(v, ["issueId", "grantId", "resultRefs"]) && text(v.issueId) && text(v.grantId)
    && (v.resultRefs === undefined || refs(v.resultRefs));
}

export function isCentralLearningAllowance(v: unknown): v is CentralLearningAllowance {
  return validAllowance(v, 1, 64);
}

/** Cumulative managed authorization; zero is a reconciled/exhausted cap, never a fresh operation. */
export function isCentralLearningGrantAllowance(v: unknown): v is CentralLearningGrantAllowance {
  return validAllowance(v, 0, MAX_CENTRAL_LEARNING_RESOURCE);
}

export function isCentralLearningGrantFundingAllowance(v: unknown): v is CentralLearningGrantAllowance {
  return validAllowance(v, 1, MAX_CENTRAL_LEARNING_RESOURCE);
}

function validAllowance(v: unknown, minimum: 0 | 1, maximumCounters: number): v is CentralLearningAllowance {
  return row(v) && exact(v, ["schemaVersion", "unit", "maxTokens", "maxCalls", "maxSteps", "maxPromptChars"])
    && v.schemaVersion === 2 && v.unit === "total_model_tokens" && integer(v.maxTokens) && v.maxTokens >= minimum
    && integer(v.maxCalls, maximumCounters) && v.maxCalls >= minimum && integer(v.maxSteps, maximumCounters) && v.maxSteps >= minimum
    // An explicitly sized input uses the resource contract's integer range.
    // Provider context, quoted total cost and caller allowance govern admission.
    && integer(v.maxPromptChars, MAX_CENTRAL_LEARNING_RESOURCE);
}

export function isCentralLearningUsage(v: unknown): v is CentralLearningUsage {
  return row(v) && (v.kind === "reported" ? exact(v, ["kind", "totalTokens", "inputTokens", "outputTokens", "model"])
    && integer(v.totalTokens) && (v.inputTokens === undefined || integer(v.inputTokens)) && (v.outputTokens === undefined || integer(v.outputTokens))
    && (v.model === undefined || text(v.model, 200)) : v.kind === "unknown" && exact(v, ["kind", "reason"]) && text(v.reason, 1000));
}

export function isLearningDependencyState(v: unknown): v is LearningDependencyState {
  return row(v) && (v.kind === "ready" ? exact(v, ["kind", "resultRef", "resultVersion", "evidenceRefs"])
    && text(v.resultRef) && text(v.resultVersion) && refs(v.evidenceRefs)
    : v.kind === "authorized" ? exact(v, ["kind", "authorizationRef"]) && text(v.authorizationRef)
    : ["waiting", "unavailable", "failed", "rejected", "cancelled"].includes(String(v.kind)) && exact(v, ["kind", "reason"]) && text(v.reason, 1000));
}

export function isLearningDependencyDraft(v: unknown): v is LearningDependencyDraft {
  return row(v) && exact(v, ["dependencyId", "owner", "requestId", "correlationRef", "state"]) && dependencyBody(v);
}

function dependencyBody(v: Row): boolean {
  return text(v.dependencyId) && ["tool", "expert", "skill"].includes(String(v.owner)) && (v.requestId === undefined || text(v.requestId))
    && text(v.correlationRef) && isLearningDependencyState(v.state) && (v.state.kind !== "authorized" || text(v.requestId));
}

export function isLearningDependency(v: unknown): v is LearningDependency {
  return row(v) && exact(v, ["schemaVersion", "dependencyId", "owner", "requestId", "correlationRef", "state", "issueId", "jobId", "grantId", "revision", "observedAt"])
    && v.schemaVersion === 1 && dependencyBody(v) && [v.issueId, v.jobId, v.grantId].every(x => text(x)) && integer(v.revision) && v.revision > 0 && date(v.observedAt);
}

export function isLearningIssue(v: unknown): v is LearningIssue {
  if (!row(v) || !exact(v, ["schemaVersion", "issueId", "scope", "problemKey", "revision", "reports", "decision", "createdAt", "updatedAt", "jobId", "grantId"])) return false;

  if (v.schemaVersion !== 1 || !text(v.issueId) || !coordinationScopeValid(v.scope) || !text(v.problemKey, 200) || !integer(v.revision) || v.revision < 1
    || !Array.isArray(v.reports) || !v.reports.length || !v.reports.every(isLearningIssueReport) || new Set(v.reports.map(r => r.reportId)).size !== v.reports.length
    || !date(v.createdAt) || !date(v.updatedAt) || (v.jobId !== undefined && !text(v.jobId)) || (v.grantId !== undefined && !text(v.grantId)) || !row(v.decision)) return false;

  return v.decision.kind === "unreviewed" ? exact(v.decision, ["kind"])
    : decision(v.decision.kind) && exact(v.decision, ["kind", "reason", "sourceRefs", "decidedAt", "revision"]) && isCoordinationDecisionReason(v.decision.reason)
      && isCoordinationDecisionSourceRefs(v.decision.sourceRefs) && date(v.decision.decidedAt)
      && integer(v.decision.revision, COORDINATION_DECISION_LIMITS.maxRevision) && v.decision.revision > 0 && v.decision.revision <= v.revision;
}

export function isCentralLearningGrant(v: unknown): v is CentralLearningGrant {
  if (!row(v) || !exact(v, ["schemaVersion", "grantId", "issueId", "scope", "jobId", "domain", "budgetId", "authorizationRef", "planRef", "focusRevision", "allowance", "steps", "reservations", "claim", "status", "closedReason"])
    || v.schemaVersion !== 2 || ![v.grantId, v.issueId, v.jobId].every(x => text(x)) || !coordinationScopeValid(v.scope)
    || !domain(v.domain) || !validOptionalCentralBudgetBinding(v) || !integer(v.focusRevision) || !v.focusRevision
    || !isCentralLearningGrantAllowance(v.allowance) || !hasCentralBudgetBinding(v) && !isCentralLearningAllowance(v.allowance)
    || !integer(v.steps, hasCentralBudgetBinding(v) ? MAX_CENTRAL_LEARNING_RESOURCE : 64)
    || !Array.isArray(v.reservations) || v.reservations.length > v.allowance.maxCalls || v.steps !== v.reservations.length || v.steps > v.allowance.maxSteps
    || !["open", "closed"].includes(String(v.status)) || (v.closedReason !== undefined && !text(v.closedReason, 1000))) return false;

  if (!v.reservations.every(r => row(r) && exact(r, ["reservationId", "claimId", "maxTokens", "state", "usage"]) && text(r.reservationId) && text(r.claimId)
    && integer(r.maxTokens) && r.maxTokens > 0 && (r.state === "reserved" ? r.usage === undefined : r.state === "settled" && isCentralLearningUsage(r.usage)))
    || new Set(v.reservations.map(r => r.reservationId)).size !== v.reservations.length) return false;

  return v.claim === undefined || row(v.claim) && exact(v.claim, ["claimId", "ownerId", "expiresAt", "step", "recoveryAttempts"])
    && text(v.claim.claimId) && text(v.claim.ownerId) && date(v.claim.expiresAt) && integer(v.claim.step) && v.claim.step > 0
    && (v.claim.recoveryAttempts === undefined || hasCentralBudgetBinding(v) && integer(v.claim.recoveryAttempts, 64));
}

export function isCoordinationAction(v: unknown): v is CoordinationAction {
  if (!row(v)) return false;

  if (v.kind === "open_budget" || v.kind === "rebudget" || v.kind === "close_investment"
    || v.kind === "reserve_budget_usage" || v.kind === "settle_budget_usage" || v.kind === "set_budget_limit") return isCentralBudgetAction(v);

  switch (v.kind) {
    case "resume_incomplete": return exact(v, ["kind", "jobId", "grantId", "expectedAttempt", "expectedIssueRevision", "expectedSequence",
      "failedReservationId", "checkpointReceiptId", "recoveryRef", "rootRef"])
      && [v.jobId, v.grantId, v.failedReservationId, v.checkpointReceiptId, v.recoveryRef].every(value => text(value))
      && integer(v.expectedAttempt) && v.expectedAttempt > 0 && integer(v.expectedIssueRevision) && v.expectedIssueRevision > 0
      && centralBudgetSequence(v.expectedSequence) && isCentralLearningBudgetRootRef(v.rootRef);
    case "report": return exact(v, ["kind", "scope", "problemKey", "issueId", "report", "expectedRevision"]) && coordinationScopeValid(v.scope)
      && text(v.problemKey, 200) && text(v.issueId) && isLearningIssueReport(v.report) && (v.expectedRevision === undefined || integer(v.expectedRevision));
    case "decide": return exact(v, ["kind", "issueId", "expectedRevision", "decision", "reason", "sourceRefs"]) && text(v.issueId, COORDINATION_DECISION_LIMITS.issueIdMaxChars)
      && integer(v.expectedRevision, COORDINATION_DECISION_LIMITS.maxRevision) && decision(v.decision)
      && isCoordinationDecisionReason(v.reason) && isCoordinationDecisionSourceRefs(v.sourceRefs);
    case "fund": return exact(v, ["kind", "issueId", "expectedRevision", "grantId", "allowance", "domain", "budgetId", "authorizationRef", "planRef", "expectedSequence"])
      && domain(v.domain) && text(v.issueId) && integer(v.expectedRevision) && text(v.grantId)
      && (hasCentralBudgetBinding(v) ? isCentralLearningGrantFundingAllowance(v.allowance) : isCentralLearningAllowance(v.allowance))
      && validOptionalCentralBudgetBinding(v) && (hasCentralBudgetBinding(v) ? centralBudgetSequence(v.expectedSequence) : v.expectedSequence === undefined);
    case "claim": return exact(v, ["kind", "jobId", "expectedAttempt", "claimId", "ownerId", "expiresAt", "expectedIssueRevision"]) && text(v.jobId)
      && integer(v.expectedAttempt) && text(v.claimId) && text(v.ownerId, 200) && date(v.expiresAt)
      && (v.expectedIssueRevision === undefined || integer(v.expectedIssueRevision) && v.expectedIssueRevision > 0);
    case "renew": return exact(v, ["kind", "jobId", "claimId", "ownerId", "expectedStep", "expectedExpiresAt", "expiresAt", "expectedIssueRevision"])
      && text(v.jobId) && text(v.claimId) && text(v.ownerId, 200) && integer(v.expectedStep) && v.expectedStep > 0
      && date(v.expectedExpiresAt) && date(v.expiresAt)
      && (v.expectedIssueRevision === undefined || integer(v.expectedIssueRevision) && v.expectedIssueRevision > 0);
    case "finish": return exact(v, ["kind", "jobId", "claimId", "result", "expectedIssueRevision"]) && text(v.jobId) && text(v.claimId) && isCentralLearningFinishResult(v.result)
      && (v.expectedIssueRevision === undefined || integer(v.expectedIssueRevision) && v.expectedIssueRevision > 0);
    case "dependency": return exact(v, ["kind", "dependencyId", "expectedRevision", "requestId", "state"]) && text(v.dependencyId) && integer(v.expectedRevision)
      && (v.requestId === undefined || text(v.requestId)) && isLearningDependencyState(v.state);
    case "reserve": return exact(v, ["kind", "grantId", "claimId", "reservationId", "maxTokens"]) && [v.grantId, v.claimId, v.reservationId].every(x => text(x)) && integer(v.maxTokens) && v.maxTokens > 0;
    case "settle": return exact(v, ["kind", "grantId", "reservationId", "usage"]) && text(v.grantId) && text(v.reservationId) && isCentralLearningUsage(v.usage);
    default: return false;
  }
}

export function isCentralLearningWorkResult(v: unknown): v is import("./coordination-contract.js").CentralLearningWorkResult {
  return row(v) && (v.kind === "completed" ? exact(v, ["kind", "resultRefs"]) && refs(v.resultRefs)
    : v.kind === "failed" || v.kind === "cancelled" ? exact(v, ["kind", "reason", "resultRefs"]) && text(v.reason, 1000)
      && (v.resultRefs === undefined || refs(v.resultRefs))
      : v.kind === "waiting_dependency" && exact(v, ["kind", "dependencies"]) && Array.isArray(v.dependencies) && v.dependencies.length > 0
        && v.dependencies.length <= 16 && v.dependencies.every(isLearningDependencyDraft) && new Set(v.dependencies.map(d => d.dependencyId)).size === v.dependencies.length);
}

export function isCentralLearningFinishResult(v: unknown): v is import("./coordination-contract.js").CentralLearningFinishResult {
  return isCentralLearningWorkResult(v) || row(v) && v.kind === "yielded" && exact(v, ["kind", "reason"]) && text(v.reason, 1000);
}
