import type { CoordinateLearningCommand, LearningIssue } from "./coordination-contract.js";
import type { BoardState } from "./state.js";
import { contentHashOf } from "./hash.js";
import { closeCentralGrant, commitCoordination } from "./coordination-state.js";
import { fail, replay } from "./result.js";
import { centralBudgetFundFailure } from "./central-budget-apply.js";

type Command<K extends CoordinateLearningCommand["action"]["kind"]> = CoordinateLearningCommand & {
  readonly action: Extract<CoordinateLearningCommand["action"], { kind: K }> };

export function applyIssueReport(state: BoardState, command: Command<"report">) {
  const a = command.action, issues = state.learningIssues ?? [];
  const sameReport = issues.find(i => i.reports.some(r => r.reportId === a.report.reportId));
  if (sameReport !== undefined) return sameReport.scope === a.scope && sameReport.problemKey === a.problemKey
    && contentHashOf(sameReport.reports.find(r => r.reportId === a.report.reportId)) === contentHashOf(a.report)
    ? replay(state) : fail(state, "command_payload_conflict", a.report.reportId);

  const byId = issues.find(i => i.issueId === a.issueId);
  if (byId !== undefined && (byId.scope !== a.scope || byId.problemKey !== a.problemKey)) return fail(state, "learning_issue_conflict", a.issueId);

  const existing = byId ?? issues.find(i => i.scope === a.scope && i.problemKey === a.problemKey);
  if (a.expectedRevision !== undefined && a.expectedRevision !== (existing?.revision ?? 0)) return fail(state, "learning_issue_conflict", "issue_revision_changed");

  const issue: LearningIssue = existing === undefined ? { schemaVersion: 1, issueId: a.issueId, scope: a.scope, problemKey: a.problemKey,
    revision: 1, reports: [a.report], decision: { kind: "unreviewed" }, createdAt: command.issuedAt, updatedAt: command.issuedAt }
    : { ...existing, reports: [...existing.reports, a.report], revision: existing.revision + 1, updatedAt: command.issuedAt };

  return commitCoordination(state, command, { issue });
}

export function applyIssueDecision(state: BoardState, command: Command<"decide">) {
  const a = command.action, previous = state.learningIssues?.find(i => i.issueId === a.issueId);
  if (previous === undefined) return fail(state, "learning_issue_not_found", a.issueId);

  if (previous.revision !== a.expectedRevision) return fail(state, "learning_issue_conflict", "issue_revision_changed");

  const revision = previous.revision + 1;
  const issue: LearningIssue = { ...previous, revision, updatedAt: command.issuedAt,
    decision: { kind: a.decision, reason: a.reason, sourceRefs: a.sourceRefs, decidedAt: command.issuedAt, revision } };
  const job = state.jobs.find(j => j.jobId === issue.jobId);
  const grant = state.centralLearningGrants?.find(g => g.grantId === issue.grantId);
  if (a.decision === "focused_learning" || job === undefined || grant === undefined) return commitCoordination(state, command, { issue });

  const dependencies = (state.learningDependencies ?? []).filter(d => d.jobId === job.jobId
    && (d.state.kind === "waiting" || d.state.kind === "unavailable" || d.state.kind === "authorized"))
    .map(d => ({ ...d, revision: d.revision + 1, observedAt: command.issuedAt,
      state: { kind: "cancelled" as const, reason: `personal_agent:${a.decision}` } }));
  const activeJob = ["queued", "running", "waiting_evidence", "waiting_approval"].includes(job.state);

  return commitCoordination(state, command, { issue, dependencies,
    ...(activeJob ? { job: { ...job, state: "cancelled" as const } } : {}),
    ...(grant.status === "open" ? { grant: closeCentralGrant(grant, a.decision) } : {}) });
}

export function applyIssueFunding(state: BoardState, command: Command<"fund">) {
  const a = command.action, issue = state.learningIssues?.find(i => i.issueId === a.issueId);
  if (issue === undefined) return fail(state, "learning_issue_not_found", a.issueId);

  if (issue.revision !== a.expectedRevision) return fail(state, "learning_issue_conflict", "issue_revision_changed");

  if (issue.decision.kind !== "focused_learning") return fail(state, "learning_issue_not_focused", issue.issueId);

  const budgetFailure = centralBudgetFundFailure(state, issue.scope, a);
  if (budgetFailure !== undefined) return fail(state, budgetFailure, a.budgetId ?? issue.scope);

  if (state.centralLearningGrants?.some(g => g.grantId === a.grantId)) return fail(state, "learning_grant_conflict", a.grantId);

  const before = state.centralLearningGrants?.find(g => g.grantId === issue.grantId);
  if (before !== undefined && (before.status !== "closed" || issue.decision.revision <= before.focusRevision)) return fail(state, "learning_grant_conflict", "existing_issue_grant");

  const domain = a.domain ?? "collaboration";
  const jobId = `central-${domain}:${contentHashOf([issue.scope, issue.issueId, a.grantId])}`;
  if (state.jobs.some(j => j.jobId === jobId)) return fail(state, "duplicate_job", jobId);

  return commitCoordination(state, command, {
    issue: { ...issue, revision: issue.revision + 1, updatedAt: command.issuedAt, jobId, grantId: a.grantId },
    job: { jobId, observationId: issue.reports[0]!.reportId, domain, scope: issue.scope, state: "queued", attempt: 0,
      // Managed claim recovery applies this to consecutive unresolved takeovers, not successful handoffs.
      maxAttempts: 64, breakerOpen: false, dedupeKey: `${domain}-issue:${issue.issueId}:${a.grantId}`, coordination: { issueId: issue.issueId, grantId: a.grantId } },
    grant: { schemaVersion: 2, grantId: a.grantId, issueId: issue.issueId, scope: issue.scope, jobId, focusRevision: issue.decision.revision,
      ...(a.budgetId === undefined ? {} : { budgetId: a.budgetId, authorizationRef: a.authorizationRef!, planRef: a.planRef! }),
      ...(a.domain === undefined ? {} : { domain: a.domain }), allowance: a.allowance, steps: 0, reservations: [], status: "open" },
  });
}
