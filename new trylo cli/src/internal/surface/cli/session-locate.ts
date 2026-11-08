import type { SessionRecord } from "../../ports/session.js";
import { isTranscriptItem } from "../../protocol/transcript.js";

/**
 * Locating the turn that holds the nth user message (WP11/F9).
 *
 * One implementation of one rule: messages are numbered 1-based as a person
 * counts, and a `transcript_item` payload that is not a transcript item
 * fails the location instead of being skipped — selecting a rollback or fork
 * point from a journal that cannot be proven intact must never silently pick
 * a neighbour.
 *
 * This duplicates `session-fork.ts`'s private `locateUserMessage` on purpose
 * and says so: fork is WP02's in-flight file, and this package does not edit
 * across a parallel workstream. The numbering, the refusal codes and the
 * refusal wording are kept identical so the two cannot drift apart; the
 * WP11 construction record carries the adoption handoff (one import in
 * `planFork`) for the fork owner.
 */

export type LocatedUserMessage =
  | {
    readonly ok: true;
    readonly turnId: string;
    readonly userMessageIndex: number;
    readonly firstSequence: number;
  }
  | { readonly ok: false; readonly code: "parent_unreadable" | "message_not_found"; readonly detail: string };

export function locateUserMessage(
  records: ReadonlyArray<SessionRecord>,
  n: number,
): LocatedUserMessage {
  if (!Number.isInteger(n) || n < 1) {
    return { ok: false, code: "message_not_found", detail: `message index must be a positive integer, got ${String(n)}` };
  }

  let seen = 0;

  for (const record of records) {
    if (record.type !== "transcript_item") {
      continue;
    }

    if (!isTranscriptItem(record.payload)) {
      return { ok: false, code: "parent_unreadable", detail: `transcript payload at sequence ${record.sequence} is not a transcript item` };
    }

    if (record.payload.kind !== "user") {
      continue;
    }

    seen += 1;

    if (seen === n) {
      return {
        ok: true,
        turnId: record.turnId ?? "",
        userMessageIndex: n,
        firstSequence: record.sequence,
      };
    }
  }

  return {
    ok: false,
    code: "message_not_found",
    detail: `user message ${n} out of range (this session has ${seen}, numbered 1-${seen})`,
  };
}
