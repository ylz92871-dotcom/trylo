import type { LearningIssue } from "../../../../control/coordination-contract.js";
import type { BoardState } from "../../../../control/state.js";
import { readCollaborationCentralResearchRecord } from "./central-research-record.js";

/** Resolve the latest complete input through original report provenance. Reports
 * from real teams retain their existing context path. */
export function collaborationCentralResearchForIssue(board: BoardState, scope: string, issue: LearningIssue) {
  const report = [...issue.reports].reverse().find(item => "kind" in item.source && item.source.kind === "research_request"
    && item.source.domain === "collaboration");
  if (report === undefined) return { status: "absent" as const };

  const source = report.source;
  if (!("kind" in source) || source.kind !== "research_request" || issue.scope !== scope) {
    return { status: "rejected" as const, reason: "collaboration_research_source_changed" };
  }

  const recordRef = report.evidenceRefs.find(ref => ref.startsWith("collaboration-central-research:"));
  if (recordRef === undefined) return { status: "rejected" as const, reason: "collaboration_research_record_missing" };

  const read = readCollaborationCentralResearchRecord(board, scope, recordRef);
  if (read.status !== "ready") return read;

  if (read.request.requestRef !== source.requestRef || read.request.intentRef !== source.intentRef
    || !report.evidenceRefs.includes(read.request.intent.intentId)) {
    return { status: "rejected" as const, reason: "collaboration_research_source_changed" };
  }

  return { status: "ready" as const, recordRef, request: read.request };
}
