import type { LearningIssue } from "./coordination-contract.js";

export type FocusedLearningDomain = "method" | "tool" | "workflow" | "skill";

/** Agent issue ownership comes from canonical sources; User Learning keeps its peer source contract. */
export function learningIssueOwner(issue: Pick<LearningIssue, "reports">): FocusedLearningDomain | "collaboration" | "ambiguous" {
  const owners = [...new Set(issue.reports.flatMap<FocusedLearningDomain | "collaboration">(report => "subsystem" in report.source ? [report.source.subsystem]
    : "kind" in report.source ? [report.source.domain === "prompt" ? "method" : report.source.domain] : []))];
  return owners.length > 1 ? "ambiguous" : owners[0] ?? "collaboration";
}
