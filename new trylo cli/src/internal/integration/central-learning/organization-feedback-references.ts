import type { BoardState } from "../../learning/control/state.js";

/** Preserve a central purpose's question identity while resolving its actual
 * native work through original Board relationships. Root money, text similarity
 * and a derived summary never identify a different issue. */
export function originalLearningIssueRefs(board: BoardState, scope: string, refs: readonly string[]): readonly string[] {
  const wanted = new Set(refs);
  const grants = (board.centralLearningGrants ?? []).filter(grant => grant.scope === scope
    && (wanted.has(grant.grantId) || wanted.has(grant.jobId)));
  return (board.learningIssues ?? []).filter(issue => issue.scope === scope && (wanted.has(issue.issueId)
    || issue.grantId !== undefined && wanted.has(issue.grantId) || issue.jobId !== undefined && wanted.has(issue.jobId)
    || grants.some(grant => grant.issueId === issue.issueId))).map(issue => issue.issueId);
}
