import type { BoardState } from "../../learning/control/state.js";
import { canonicalJson } from "../../learning/control/hash.js";
import { readContentRecords } from "./records.js";
import { canReadNativeContentRecord } from "./sources/native-knowledge.js";

export type StoredIssueContent = ReturnType<typeof readContentRecords>[number];

/** One current canonical focus view for context and admission. Funding may change the
 * issue revision without changing the decision/reports the domain model actually saw. */
export function contentRecordsForIssue(board: BoardState, scope: string, issueId: string): readonly StoredIssueContent[] {
  const issue = board.learningIssues?.find(row => row.issueId === issueId && row.scope === scope);
  if (issue === undefined) return [];

  const reports = new Map(issue.reports.map(report => [report.reportId, canonicalJson(report)]));

  return readContentRecords(board.rewardV2Facts ?? [], scope, board.sequence)
    .filter(row => canReadNativeContentRecord(board, scope, row, { inspectionIssueIds: [issueId] }))
    .filter(row => row.packet.focus?.scope === scope && row.packet.focus.issueId === issueId
      && canonicalJson(row.packet.focus.decision) === canonicalJson(issue.decision)
      && row.packet.focus.reports.every(report => reports.get(report.reportId) === canonicalJson(report)))
    .sort((left, right) => left.sequence - right.sequence);
}
