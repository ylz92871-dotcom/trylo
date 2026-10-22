import { selectTextRange } from "./range-stream.js";
import type { ReadOnlyToolLimits } from "./limits.js";

/** What the caller asked for, and what it means when the arguments are absent. */
export type RangeRequest = {
  /** 0-based first line. Absent means the top of the file. */
  readonly offset: number;
  /** Requested line count. Absent means "as many as the limits allow". */
  readonly limit: number | undefined;
};

/** A request that cannot be honoured, with the reason a model can act on. */
export type RangeProblem = {
  readonly reason: "offset_not_integer" | "offset_negative" | "limit_not_integer" | "limit_not_positive";
  readonly message: string;
};

export type RangeSelection = {
  readonly text: string;
  /** 1-based, inclusive; both zero when no source lines were returned. */
  readonly startLine: number;
  readonly endLine: number;
  readonly totalLines: number;
  /** 0-based offset to pass back for the next chunk; absent when nothing follows. */
  readonly nextOffset: number | undefined;
  /** Set when the file held more than the limits returned. */
  readonly truncated: boolean;
  /** Set when the *requested window* held more lines than the limits returned. */
  readonly truncatedLines: boolean;
  readonly truncatedBytes: boolean;
  /**
   * The one line that cannot fit the byte budget by itself. Present instead of a
   * `nextOffset` because a `nextOffset` into the middle of a line would invite a
   * model to spend turns making no progress. `bytes` is the line's real length,
   * so a model can tell "this file has one enormous line" from "the cut landed
   * awkwardly".
   */
  readonly lineTooLong?: { readonly line: number; readonly bytes: number };
};

/**
 * Parse `offset` / `limit` out of raw tool arguments.
 *
 * Absent means "not specified", and that is different from zero — an absent
 * `limit` means the existing ceiling, while `limit: 0` is a request for nothing
 * and is refused, because a model that asked for zero lines has made a mistake
 * worth telling it about rather than a startle.
 */
export function readRangeRequest(args: Readonly<Record<string, unknown>>): RangeRequest | RangeProblem {
  const rawOffset = args["offset"];
  let offset = 0;
  if (rawOffset !== undefined && rawOffset !== null) {
    if (typeof rawOffset !== "number" || !Number.isInteger(rawOffset)) {
      return { reason: "offset_not_integer", message: "offset must be an integer line number, 0-based" };
    }
    if (rawOffset < 0) {
      return { reason: "offset_negative", message: `offset must be 0 or greater, got ${rawOffset}` };
    }
    offset = rawOffset;
  }
  const rawLimit = args["limit"];
  if (rawLimit === undefined || rawLimit === null) {
    return { offset, limit: undefined };
  }
  if (typeof rawLimit !== "number" || !Number.isInteger(rawLimit)) {
    return { reason: "limit_not_integer", message: "limit must be an integer line count" };
  }
  if (rawLimit <= 0) {
    return { reason: "limit_not_positive", message: `limit must be 1 or more, got ${rawLimit}` };
  }
  return { offset, limit: rawLimit };
}

export function isRangeProblem(value: RangeRequest | RangeProblem): value is RangeProblem {
  return "reason" in value;
}

/** Complete-line pagination; the stream and string adapters share one selection owner. */
export function selectRange(text: string, request: RangeRequest, limits: ReadOnlyToolLimits): RangeSelection {
  return selectTextRange(text, request, limits, false);
}
