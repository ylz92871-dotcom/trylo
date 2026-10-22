import type { ProcessSessionEndReason } from "../../../ports/process-session.js";
import type { JsonObject } from "../../../protocol/envelope.js";

/** The same observed terminal facts belong in tool text and structured data.
 * A successful observation is not evidence that the observed command succeeded. */
export function processEndFields(end: ProcessSessionEndReason | undefined): JsonObject {
  if (end === undefined) return {};
  switch (end.kind) {
    case "exited": return { exitCode: end.exitCode, ...(end.signal === undefined ? {} : { signal: end.signal }) };
    case "failed": return { failureCode: end.code, failureMessage: end.message };
    case "lost": return { lostReason: end.reason };
  }
}

export function describeProcessEnd(end: ProcessSessionEndReason): string {
  switch (end.kind) {
    case "exited": return `exit code ${end.exitCode}${end.signal === undefined ? "" : `; signal ${end.signal}`}`;
    case "failed": return `${end.code}: ${end.message}`;
    case "lost": return end.reason;
  }
}

export function processEndSuffix(end: ProcessSessionEndReason | undefined): string {
  return end === undefined ? "" : ` (${describeProcessEnd(end)})`;
}
