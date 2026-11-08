import type { LearningIssue } from "../../../../control/coordination-contract.js";
import { learningIssueOwner } from "../../../../control/learning-issue-owner.js";

// Compatibility for the existing PA service/tests; remove when these callers use the shared control entry.
export { learningIssueOwner } from "../../../../control/learning-issue-owner.js";
export type { FocusedLearningDomain } from "../../../../control/learning-issue-owner.js";

export const COLLABORATION_SKILL_FOCUS_REQUIRED = "collaboration_skill_issue_requires_skill_focus";

export function learningIssueFocusRequired(owner: ReturnType<typeof learningIssueOwner>): string {
  return owner === "ambiguous" ? "learning_issue_has_multiple_subsystem_owners" : `collaboration_${owner}_issue_requires_${owner}_focus`;
}

/** Canonical source ownership only; a report's text cannot select its worker or budget. */
export function hasSkillIssueSource(issue: Pick<LearningIssue, "reports">): boolean {
  return issue.reports.some(report => "subsystem" in report.source && report.source.subsystem === "skill");
}
