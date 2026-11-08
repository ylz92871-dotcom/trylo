import { isTeamLearningIssueReport, type LearningIssue } from "../../../../control/coordination-contract.js";

export type CollaborationSourceAdmission = { readonly status: "ready" }
  | { readonly status: "rejected"; readonly reason: "learning_source_issue_changed" | "learning_source_team_changed" };

/** Source identity comes from the actual mounted host. A PA-only report has no member-team restriction.
 * This shares the original worker admission with central source preparation; it grants no execution or creation permission.
 */
export function collaborationSourceAdmission(issue: LearningIssue, host: {
  readonly sourceIssueId?: string; readonly currentTeamRunId?: string;
}): CollaborationSourceAdmission {
  if (host.sourceIssueId !== undefined && host.sourceIssueId !== issue.issueId) {
    return { status: "rejected", reason: "learning_source_issue_changed" };
  }

  const members = issue.reports.filter(isTeamLearningIssueReport).filter(report => report.source.memberId !== "personal_agent");
  if (host.currentTeamRunId !== undefined && members.length > 0
    && !members.some(report => report.source.teamRunId === host.currentTeamRunId)) {
    return { status: "rejected", reason: "learning_source_team_changed" };
  }

  return { status: "ready" };
}
