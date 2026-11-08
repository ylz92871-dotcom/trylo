import type { TopicEvidenceOrigin } from "../../learning/domains/shared/topics/contracts.js";
import { TOPIC_EVIDENCE_ORIGINS } from "../../learning/domains/shared/topics/contracts.js";
import type { SessionContentSource } from "./sources/session-contract.js";
import type { AutomaticBoardContentSource } from "./sources/board.js";
import type { FeedbackMaterialTransport } from "./sources/feedback-paging.js";
import type { DomainFeedbackMaterialTransport } from "./sources/domain-feedback.js";
import type { ContentSourceTextView } from "./sources/source-text-view.js";

/** The returned fragment is admitted under a new page identity by the host, never under originalRef as full text. */
export interface TaskSourcePage {
  readonly ref: string;
  readonly originalRef: string;
  readonly origin: TopicEvidenceOrigin;
  readonly originalScope: string;
  readonly start: number;
  readonly end: number;
  readonly totalChars: number;
  readonly text: string;
  readonly sourceHash: string;
  readonly coordinate: { readonly runId: string; readonly sequence: number };
  readonly owner: "session" | "board" | "feedback" | "domain_feedback";
  readonly originalSource?: ContentSourceTextView["original"];
}

export type TaskSourcePageRead = { readonly ok: true; readonly value: TaskSourcePage }
  | { readonly ok: false; readonly reason: string };

export interface TaskSourcePageReader {
  read(ref: string, signal: AbortSignal, start?: number, maximumChars?: number): Promise<TaskSourcePageRead>;
}

const missing = (reason: string): boolean => reason === "content_material_missing" || reason === "content_feedback_material_missing";

function admit(value: TaskSourcePage, start: number, maximum: number): TaskSourcePageRead {
  if (typeof value.originalRef !== "string" || !value.originalRef || typeof value.originalScope !== "string" || !value.originalScope
    || !value.coordinate || typeof value.coordinate.runId !== "string" || !value.coordinate.runId || !Number.isSafeInteger(value.coordinate.sequence)
    || value.coordinate.sequence < 0 || !TOPIC_EVIDENCE_ORIGINS.includes(value.origin) || !/^[a-f0-9]{64}$/.test(value.sourceHash)
    || value.start !== start || !Number.isSafeInteger(value.end) || !Number.isSafeInteger(value.totalChars)
    || value.totalChars < 0 || value.end < start || value.end > value.totalChars || value.end - start > maximum
    || typeof value.text !== "string" || value.text.length !== value.end - start) return { ok: false, reason: "content_material_page_invalid" };

  if (value.end === start) return { ok: false, reason: "content_material_no_progress" };

  if (value.originalSource !== undefined && (typeof value.originalSource.ref !== "string" || !value.originalSource.ref
    || typeof value.originalSource.runId !== "string" || !value.originalSource.runId || !Number.isSafeInteger(value.originalSource.sequence)
    || value.originalSource.sequence < 0 || !/^[a-f0-9]{64}$/.test(value.originalSource.sourceHash))) return { ok: false, reason: "content_material_page_invalid" };

  return { ok: true, value: { ref: value.ref, originalRef: value.originalRef, origin: value.origin, originalScope: value.originalScope,
    start: value.start, end: value.end, totalChars: value.totalChars, text: value.text, sourceHash: value.sourceHash,
    coordinate: { runId: value.coordinate.runId, sequence: value.coordinate.sequence }, owner: value.owner,
    ...(value.originalSource === undefined ? {} : { originalSource: { ...value.originalSource } }) } };
}

/** Route only explicit missing across owners. Ambiguous, forbidden, invalid and unavailable reads remain terminal.
 * Each owner retains its own scope policy, full-source hash algorithm and original source coordinates.
 */
export function createTaskSourcePageReader(input: {
  readonly session: Pick<SessionContentSource, "readMaterial">;
  readonly board: Pick<AutomaticBoardContentSource, "readMaterial">;
  readonly feedback: Pick<FeedbackMaterialTransport, "readMaterial">;
  readonly domainFeedback?: Pick<DomainFeedbackMaterialTransport, "readMaterial">;
}): TaskSourcePageReader {
  return { async read(ref, signal, start = 0, maximum = 4096): Promise<TaskSourcePageRead> {
    if (signal.aborted) return { ok: false, reason: "content_material_cancelled" };

    if (typeof ref !== "string" || !ref || !Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(maximum)
      || maximum < 1 || maximum > 8192) return { ok: false, reason: "content_material_range_invalid" };

    try {
      const session = await input.session.readMaterial(ref, signal, start, maximum);

      if (signal.aborted) return { ok: false, reason: "content_material_cancelled" };

      if (session.ok) return admit({ ...session.value, ref, originalRef: session.value.ref,
        coordinate: session.value.coordinate ?? { runId: session.value.sessionId, sequence: session.value.journalSequence }, owner: "session" }, start, maximum);

      if (!missing(session.reason)) return session;

      const board = await input.board.readMaterial(ref, signal, start, maximum);

      if (signal.aborted) return { ok: false, reason: "content_material_cancelled" };

      if (board.ok) return admit({ ...board.value, ref, originalRef: board.value.ref,
        sourceHash: board.value.contentHash, owner: "board" }, start, maximum);

      if (!missing(board.reason)) return board;

      const feedback = input.feedback.readMaterial(ref, start, maximum);

      if (signal.aborted) return { ok: false, reason: "content_material_cancelled" };

      if (feedback.ok) return admit({ ...feedback, ref, coordinate: feedback.originalCoordinate, owner: "feedback" }, start, maximum);

      if (!missing(feedback.reason) || input.domainFeedback === undefined) return { ok: false, reason: feedback.reason };

      const domain = input.domainFeedback.readMaterial(ref, start, maximum);

      if (signal.aborted) return { ok: false, reason: "content_material_cancelled" };

      return domain.ok ? admit({ ...domain.value, ref, originalRef: domain.value.ref,
        sourceHash: domain.value.contentHash, owner: "domain_feedback" }, start, maximum) : domain;
    } catch { return { ok: false, reason: "content_material_unavailable" }; }
  } };
}
