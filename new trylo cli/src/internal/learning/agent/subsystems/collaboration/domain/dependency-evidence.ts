import type { BoardState } from "../../../../control/state.js";
import { coordinationForJob } from "../../../../control/coordination-state.js";
import { isCentralLearningGrant, isLearningDependency, isLearningIssue, isLearningJobCoordination } from "../../../../control/coordination-parse.js";

/** Ready library results are sources, never construction consent, permission or evidence of task quality. */
export function collaborationDependencySourceRefs(state: BoardState, input: {
  readonly scope: string; readonly issueId: string; readonly focusRevision?: number; readonly grantId?: string;
}): readonly string[] {
  if (input.focusRevision !== undefined && (!Number.isSafeInteger(input.focusRevision) || input.focusRevision < 1)) return [];

  const issue = state.learningIssues?.find(value => value.issueId === input.issueId && value.scope === input.scope);
  if (!issue || !isLearningIssue(issue)) return [];

  const refs = new Set<string>();

  for (const dependency of state.learningDependencies ?? []) {
    if (!isLearningDependency(dependency) || dependency.state.kind !== "ready" || dependency.issueId !== issue.issueId) continue;

    const current = coordinationForJob(state, dependency.jobId);
    if (!current) continue;

    const { grant, job } = current;

    if (!isCentralLearningGrant(grant) || !isLearningJobCoordination(job.coordination)
      || current.issue.issueId !== issue.issueId || current.issue.scope !== input.scope
      || grant.issueId !== issue.issueId || grant.scope !== input.scope || grant.jobId !== dependency.jobId
      || grant.grantId !== dependency.grantId || job.jobId !== dependency.jobId || job.scope !== input.scope
      || job.domain !== "collaboration" || (grant.domain ?? "collaboration") !== "collaboration"
      || job.coordination?.issueId !== dependency.issueId || job.coordination.grantId !== dependency.grantId
      || grant.focusRevision > issue.revision || input.focusRevision !== undefined && grant.focusRevision !== input.focusRevision
      || input.grantId !== undefined && grant.grantId !== input.grantId) continue;

    // Do not require current issue pointers/open grants: later resolution/refocusing preserves the original result's history.
    refs.add(dependency.dependencyId);
    refs.add(dependency.state.resultRef);
  }

  return [...refs];
}
