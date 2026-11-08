import type { LearningIssue } from "../../learning/control/coordination-contract.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { learningIssueOwner } from "../../learning/control/learning-issue-owner.js";
import { centralResearchRequestRef, CentralResearchIntakeError } from "./research-intake-common.js";
import { readCentralResearchProgramReportMetadata } from "./research-intake-episode-metadata.js";

export interface CentralResearchEpisodeOrigin {
  readonly intentRef: string;
  readonly requestRef: string;
  readonly baseRequestRef: string;
  readonly sourceRefs: readonly string[];
}

/** The caller supplies the request ID decoded by the original native owner
 * (plan.proposalKey/opportunityId), never a guessed parent evidence reference. */
export function readCentralResearchEpisodeOrigin(issue: LearningIssue, nativeRequestRef: string): CentralResearchEpisodeOrigin | undefined {
  const owner = learningIssueOwner(issue), domain = owner === "method" ? "prompt" : owner;
  const native = issue.reports.filter(report => !report.reportId.startsWith("central-research-program-report:"));
  const found: CentralResearchEpisodeOrigin[] = [];

  for (const report of issue.reports) {
    const metadata = readCentralResearchProgramReportMetadata(report);
    if (metadata === undefined || metadata.requestRef !== nativeRequestRef) continue;

    if (metadata.scope !== issue.scope || metadata.domain !== domain
      || report.reportId !== `central-research-program-report:${contentHashOf([issue.scope, issue.issueId, nativeRequestRef, metadata.programRef])}`
      || metadata.baseRequestRef !== centralResearchRequestRef(issue.scope, metadata.intentRef, metadata.domain)
      || !native.some(row => canonicalJson(row.source) === canonicalJson(report.source))
      || "kind" in report.source && (report.source.requestRef !== nativeRequestRef || report.source.intentRef !== metadata.intentRef)) {
      throw new CentralResearchIntakeError("central_research_origin_native_binding_invalid", [issue.issueId, report.reportId]);
    }

    found.push({ intentRef: metadata.intentRef, requestRef: nativeRequestRef, baseRequestRef: metadata.baseRequestRef,
      sourceRefs: [report.reportId, metadata.intentRef, nativeRequestRef, metadata.baseRequestRef] });
  }

  if (found.length === 0) return undefined;

  const origin = found[0]!;
  if (found.some(row => row.intentRef !== origin.intentRef || row.baseRequestRef !== origin.baseRequestRef)) {
    throw new CentralResearchIntakeError("central_research_origin_ambiguous", [issue.issueId]);
  }

  return { ...origin, sourceRefs: [...new Set(found.flatMap(row => row.sourceRefs))] };
}
