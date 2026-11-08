import type { CentralLearningGrant, CoordinateLearningCommand, LearningDependency, LearningIssue } from "./coordination-contract.js";
import type { LearningJob } from "./contracts.js";
import type { BoardState } from "./state.js";
import { isCentralLearningGrant, isLearningDependency, isLearningIssue, isLearningJobCoordination } from "./coordination-parse.js";
import { nextSeq, succeed } from "./result.js";
import type { CentralLearningBudget } from "./central-budget-contract.js";
import { validCentralBudgetState } from "./central-budget-state.js";

export type CoordinationPatch = { readonly issue?: LearningIssue; readonly grant?: CentralLearningGrant;
  readonly job?: LearningJob; readonly dependencies?: readonly LearningDependency[]; readonly budget?: CentralLearningBudget };

const replace = <T>(all: readonly T[], value: T, key: (item: T) => string): readonly T[] =>
  all.some(item => key(item) === key(value)) ? all.map(item => key(item) === key(value) ? value : item) : [...all, value];

export function commitCoordination(state: BoardState, command: CoordinateLearningCommand, patch: CoordinationPatch) {
  let dependencies = state.learningDependencies ?? [];

  for (const item of patch.dependencies ?? []) dependencies = replace(dependencies, item, d => d.dependencyId);

  return succeed(state, command.commandId, [{ type: "learning_coordination_changed", sequence: nextSeq(state),
    commandId: command.commandId, occurredAt: command.issuedAt, ...patch }], {
    ...(patch.issue === undefined ? {} : { learningIssues: replace(state.learningIssues ?? [], patch.issue, i => i.issueId) }),
    ...(patch.grant === undefined ? {} : { centralLearningGrants: replace(state.centralLearningGrants ?? [], patch.grant, g => g.grantId) }),
    ...(patch.job === undefined ? {} : { jobs: replace(state.jobs, patch.job, j => j.jobId) }),
    ...(patch.dependencies === undefined ? {} : { learningDependencies: dependencies }),
    ...(patch.budget === undefined ? {} : { centralLearningBudgets: replace(state.centralLearningBudgets ?? [], patch.budget, item => item.budgetId) }),
  });
}

export function validCoordinationState(state: BoardState): boolean {
  const issues = state.learningIssues === undefined ? [] : state.learningIssues;
  const grants = state.centralLearningGrants === undefined ? [] : state.centralLearningGrants;
  const deps = state.learningDependencies === undefined ? [] : state.learningDependencies;
  if (!Array.isArray(issues) || !issues.every(isLearningIssue) || !Array.isArray(grants) || !grants.every(isCentralLearningGrant)
    || !Array.isArray(deps) || !deps.every(isLearningDependency) || !validCentralBudgetState(state)) return false;

  if (new Set(issues.map(i => i.issueId)).size !== issues.length || new Set(issues.map(i => `${i.scope}\u0000${i.problemKey}`)).size !== issues.length
    || new Set(grants.map(g => g.grantId)).size !== grants.length || new Set(deps.map(d => d.dependencyId)).size !== deps.length) return false;

  const reportIds = issues.flatMap(i => i.reports.map(r => r.reportId));
  if (new Set(reportIds).size !== reportIds.length) return false;

  return state.jobs.every(j => j.coordination === undefined || isLearningJobCoordination(j.coordination)
      && grants.some(g => g.grantId === j.coordination?.grantId && g.jobId === j.jobId && g.issueId === j.coordination.issueId))
    && issues.every(i => i.grantId === undefined ? i.jobId === undefined : grants.some(g => g.grantId === i.grantId && g.issueId === i.issueId && g.jobId === i.jobId))
    && grants.every(g => issues.some(i => i.issueId === g.issueId && i.scope === g.scope) && state.jobs.some(j => j.jobId === g.jobId
      && j.domain === (g.domain ?? "collaboration") && j.scope === g.scope && j.coordination?.issueId === g.issueId && j.coordination.grantId === g.grantId))
    && deps.every(d => grants.some(g => g.grantId === d.grantId && g.issueId === d.issueId && g.jobId === d.jobId));
}

export function coordinationForJob(state: BoardState, jobId: string) {
  const job = state.jobs.find(j => j.jobId === jobId);
  const grant = state.centralLearningGrants?.find(g => g.jobId === jobId && g.grantId === job?.coordination?.grantId);
  const issue = state.learningIssues?.find(i => i.issueId === grant?.issueId);
  return job === undefined || grant === undefined || issue === undefined ? undefined : { job, grant, issue };
}

export function withoutClaim(grant: CentralLearningGrant): CentralLearningGrant {
  const { claim: _claim, ...rest } = grant;
  return rest;
}

export function closeCentralGrant(grant: CentralLearningGrant, reason: string): CentralLearningGrant {
  return { ...withoutClaim(grant), status: "closed", closedReason: reason };
}
