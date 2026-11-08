import type { SessionPort } from "../../ports/session.js";
import type { BoardState } from "../../learning/control/state.js";
import type { StoredIssueContent } from "./issue-view.js";
import { hasCandidateEnteredPacket, laterIssueUserInputCandidates } from "./sources/feedback-user-markers.js";

/** The normal host supplies its already-open canonical journal reader. No session registry,
 * feedback writer, model request or second attribution owner is created here. */
export interface ContentAdmissionSessionSource {
  readonly session: Pick<SessionPort, "readRecords">;
  readonly sessionId: string;
  readonly secrets?: readonly string[];
}

export type IssueUserSourceFreshness = { readonly status: "current" }
  | { readonly status: "unseen"; readonly sourceRefs: readonly string[] }
  | { readonly status: "invalid"; readonly reason: string };

/** Read one real journal snapshot against the same Board used by admission. The feedback
 * source owner identifies candidate inputs and authenticates full/chunk/page transport;
 * this layer never guesses whether user prose is negative or assigns its correction target. */
export async function readIssueUserSourceFreshness(input: { readonly board: BoardState; readonly scope: string; readonly issueId: string;
  readonly latest: StoredIssueContent; readonly source: ContentAdmissionSessionSource; readonly signal?: AbortSignal }): Promise<IssueUserSourceFreshness> {
  if (input.signal?.aborted) return { status: "invalid", reason: "content_cancelled" };
  try {
    const read = await input.source.session.readRecords();

    if (input.signal?.aborted) return { status: "invalid", reason: "content_cancelled" };

    if (!read.ok) return { status: "invalid", reason: read.code };

    const current = laterIssueUserInputCandidates({ board: input.board, scope: input.scope, issueId: input.issueId,
      sessionId: input.source.sessionId, records: read.view.records, tornTail: read.view.tornTail,
      ...(input.source.secrets === undefined ? {} : { secrets: input.source.secrets }) });
    if (current.status === "invalid") return current;

    const unseen = current.candidates.filter(candidate => !hasCandidateEnteredPacket(input.latest.packet, candidate));

    return unseen.length === 0 ? { status: "current" } : { status: "unseen", sourceRefs: [...new Set(unseen.map(candidate => candidate.ref))] };
  } catch { return { status: "invalid", reason: "content_user_source_unavailable" }; }
}
