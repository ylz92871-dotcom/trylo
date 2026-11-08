import type { createCollaborationControl } from "../control/index.js";
import { learningIssueOwner } from "./focus-owner.js";

type Control = Pick<ReturnType<typeof createCollaborationControl>, "read">;

type State = Extract<Awaited<ReturnType<Control["read"]>>, { readonly ok: true }>;

/** A legacy method grant stays in its original ledger. Other legacy domains
 * never enter this compatibility view or acquire a new routing authority. */
export async function personalAgentInspectionState(control: Control, scope: string, legacyMethodScope?: string) {
  const current = await control.read(scope);
  if (!current.ok || legacyMethodScope === undefined || legacyMethodScope === scope) return current;

  const previous = await control.read(legacyMethodScope);
  if (!previous.ok) return previous;

  const issues = previous.issues.filter(issue => issue.scope === legacyMethodScope && learningIssueOwner(issue) === "method");
  const issueIds = new Set(issues.map(issue => issue.issueId));
  const grants = previous.grants.filter(grant => grant.domain === "prompt" && grant.scope === legacyMethodScope && issueIds.has(grant.issueId));
  const jobs = previous.jobs.filter(job => job.domain === "prompt" && job.scope === legacyMethodScope
    && grants.some(grant => grant.jobId === job.jobId && job.coordination?.grantId === grant.grantId
      && job.coordination.issueId === grant.issueId));
  const dependencies = previous.dependencies.filter(dependency => issueIds.has(dependency.issueId)
    && grants.some(grant => grant.grantId === dependency.grantId && grant.jobId === dependency.jobId));

  return { ...current, issues: [...current.issues, ...issues], jobs: [...current.jobs, ...jobs],
    grants: [...current.grants, ...grants], dependencies: [...current.dependencies, ...dependencies] } satisfies State;
}
