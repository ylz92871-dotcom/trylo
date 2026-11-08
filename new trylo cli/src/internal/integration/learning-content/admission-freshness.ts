import type { BoardState } from "../../learning/control/state.js";
import { canonicalJson } from "../../learning/control/hash.js";
import type { StoredIssueContent } from "./issue-view.js";
import { boardUserFeedbackMaterialBatch } from "./sources/feedback-board.js";
import { mapBoardContentArtifacts, contentSubsystem } from "./sources/artifact.js";
import { contentFeedbackHeadMaterial } from "./sources/feedback-paging.js";
import { hasUserStatementSourceEnteredPackets } from "./sources/feedback-user-markers.js";
import { contentRecordsForIssue } from "./issue-view.js";
import { projectContentSourceText } from "./sources/source-text-view.js";

/** Compare real source entry and complete source-owned heads. A deferred locator
 * advertises an unread source and cannot certify that its feedback entered the model. */
export function unseenIssueUserFeedback(board: BoardState, scope: string, issueId: string,
  latest: StoredIssueContent, secrets: readonly string[] = []): readonly string[] {
  const current = boardUserFeedbackMaterialBatch({ board, scope, issueId, subsystem: contentSubsystem(latest.packet.domain),
    artifacts: mapBoardContentArtifacts(board, scope) });
  const packets = [...contentRecordsForIssue(board, scope, issueId).map(record => record.packet), latest.packet];
  const stored = new Set(packets.flatMap(packet => packet.records.map(record => canonicalJson(record))));

  return current.records.filter(record => {
    if (hasUserStatementSourceEnteredPackets(packets, record, secrets)) return false;
    const head = contentFeedbackHeadMaterial(projectContentSourceText(record, secrets).record);
    return head?.entryBasis !== "complete_original_and_active_heads" || !stored.has(canonicalJson(head.record));
  }).map(record => record.ref);
}
