import type { JsonObject } from "../protocol/envelope.js";
import { cutToBytes } from "../protocol/text-cut.js";
import { MAX_MEMBER_REPORTS } from "./control-observation.js";
import type { SubagentStatus } from "./types.js";

export type WaitMemberReader = { readonly target: string; readonly status: SubagentStatus;
  readonly read: (reportLimit: number) => JsonObject };
const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");

/** Bound the structured result before the loop's generic text truncation can break JSON. */
export function boundedWaitResponse(members: readonly WaitMemberReader[], timedOut: boolean, maxBytes: number): JsonObject | undefined {
  const pages = members.map(member => ({ member, limit: MAX_MEMBER_REPORTS, snapshot: member.read(MAX_MEMBER_REPORTS) }));
  for (;;) {
    const answer = { status: Object.fromEntries(members.map(member => [member.target, member.status])), timed_out: timedOut,
      results: Object.fromEntries(pages.map(page => [page.member.target, page.snapshot])) };
    if (bytes(answer) <= maxBytes) {
      const pending = pages.some(page => page.snapshot["has_more_reports"] === true);
      const delivered = pages.some(page => Array.isArray(page.snapshot["reports"]) && page.snapshot["reports"].length > 0);
      // Asking for fewer targets must be explicit if this page cannot make progress.
      return pending && !delivered ? undefined : answer;
    }
    // Keep whole report messages. Each re-read returns its own safe consumption cursor.
    const multiReport = pages.filter(page => Array.isArray(page.snapshot["reports"]) && page.snapshot["reports"].length > 1)
      .sort((left, right) => bytes(right.snapshot["reports"]) - bytes(left.snapshot["reports"]))[0];
    if (multiReport !== undefined) {
      multiReport.limit = Math.floor(multiReport.limit / 2);
      multiReport.snapshot = multiReport.member.read(multiReport.limit);
      continue;
    }
    // Full answers already have an independent member transcript. Mark any preview cut explicitly.
    const output = pages.filter(page => typeof page.snapshot["output"] === "string" && page.snapshot["output"].length > 0)
      .sort((left, right) => bytes(right.snapshot["output"]) - bytes(left.snapshot["output"]))[0];
    if (output !== undefined) {
      const text = String(output.snapshot["output"]);
      output.snapshot = { ...output.snapshot, output: cutToBytes(text, Math.floor(Buffer.byteLength(text, "utf8") / 2)), output_truncated: true };
      continue;
    }
    const singleReport = pages.find(page => Array.isArray(page.snapshot["reports"]) && page.snapshot["reports"].length > 0);
    if (singleReport === undefined) return undefined;
    singleReport.limit = 0;
    singleReport.snapshot = singleReport.member.read(0);
  }
}
