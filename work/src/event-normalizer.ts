// Trylo Work — Work Runtime error event normalizer.
//
// v1.16.5+ (Step 1, W-RUN-001 完整收口):
//
//   Upstream Cowork-OS broadcasts `task.event` frames that may
//   signal task failure. The actual error payload lives in
//   different shapes depending on the inner event type and
//   protocol version:
//
//     A. timeline_error + nested message
//        frame.payload.type === 'timeline_error'
//        frame.payload.payload.message === '<string>'
//
//     B. timeline_error with no extractable message
//        frame.payload.type === 'timeline_error'
//        frame.payload.payload === {} (or no .message)
//
//     C. error event + string error
//        frame.payload.type === 'error'
//        frame.payload.error === '<string>'
//
//     D. error event + Error-like / nested message
//        frame.payload.type === 'error'
//        frame.payload.error === { message: '<string>' }
//
//     E. protocol upgrade / unknown error shape
//        Any of the above types but the payload is non-standard,
//        OR a new error type we don't recognise yet
//
//   The previous implementation in App.tsx only handled
//   case (A) directly, used the literal string "unknown
//   error" as the fallback, and completely ignored case (C)
//   and (D). Result: a meaningful fraction of failures
//   surfaced to the user as "Task failed: unknown error" or
//   never surfaced at all.
//
//   This normalizer establishes a stable Trylo-internal
//   error representation. The Desktop UI must consume
//   `NormalizedError.userMessage` and never see vendor
//   payload shapes directly. The contract:
//
//     - `normalizeError(frame)` returns `null` for frames
//       that are NOT error events (caller continues normal
//       event flow).
//     - For error events, it ALWAYS returns a
//       `NormalizedError`, even when the upstream payload
//       is malformed or empty.
//     - `userMessage` NEVER equals the literal string
//       "unknown error". If the upstream truly carries no
//       readable message, we generate a deterministic
//       diagnostic that includes the diagnosticId so a
//       follow-up audit can correlate the failure.
//     - The function is pure, side-effect free, and never
//       throws. Malformed input produces a NormalizedError
//       with `errorCode: 'unrecognized_shape'`.
//
//   Future steps (W-RUN-002/003/004) will use `taskId` and
//   `errorCode` to route and reconcile. The shape is stable
//   enough for those consumers to lock on without re-parsing
//   the raw frame.

import type { EventFrame } from "./control-plane/types.js";

/** Stable, vendor-agnostic error code. UI and downstream
 *  consumers (TaskRegistry in Step 2) MUST key off this,
 *  not off `rawEventType` or `frame.event`. */
export type NormalizedErrorCode =
  | "timeline_error"
  | "timeline_error_no_message"
  | "error_string"
  | "error_nested"
  | "error_no_message"
  | "unrecognized_shape";

/** Stable internal error representation. UI never sees the
 *  raw upstream payload directly. */
export interface NormalizedError {
  /** Text to show in the chat as the failure reason.
   *  Guaranteed to be a non-empty string. NEVER the
   *  literal "unknown error". */
  readonly userMessage: string;
  /** Stable error code for filtering / routing. */
  readonly errorCode: NormalizedErrorCode;
  /** taskId extracted from frame.payload.taskId, if present. */
  readonly taskId: string | undefined;
  /** The inner `type` field of frame.payload as observed
   *  (may be 'timeline_error', 'error', or a new value
   *  introduced by a future upstream protocol bump). */
  readonly rawEventType: string;
  /** Deterministic-enough identifier for log / audit
   *  correlation. Format: `err-<base36 timestamp>-<counter>`. */
  readonly diagnosticId: string;
  /** The original frame.payload, kept for advanced display
   *  and future forensic tooling. UI must not show this
   *  directly. */
  readonly raw: unknown;
}

/** Event types that are KNOWN to be error events. Both
 *  shapes are confirmed in upstream vendor:
 *    - timeline_error: vendor/cowork-os/src/electron/agent/
 *      daemon.ts (logEvent taskId "timeline_error" {...})
 *    - error: vendor/cowork-os/src/electron/agent/daemon.ts
 *      (logEvent taskId "error" { error }) */
const KNOWN_ERROR_TYPES: ReadonlySet<string> = new Set([
  "timeline_error",
  "error",
]);

/** Event types that are explicitly NOT errors. We use
 *  this to short-circuit a `frame.payload.type` we
 *  recognise so we don't accidentally try to extract a
 *  message from a completion or step event.
 *
 *  v1.16.5+ (W-UI-002, Phase 3): the previous list
 *  missed the timeline_* family that carries a nested
 *  `payload.message`. Without `timeline_group_*` and
 *  `timeline_step_*` in this set, a frame like
 *      task.event { type: "timeline_group_finished",
 *                  payload: { message: "Completed DISCOVER" } }
 *  was mis-classified as an error and rendered as
 *  "Task failed: Completed DISCOVER" — even though the
 *  underlying task continued and produced a real
 *  artifact. The event is a *plan* event, not a failure. */
const KNOWN_NON_ERROR_TYPES: ReadonlySet<string> = new Set([
  "execution_run_summary",
  "task_completed",
  "task_cancelled",
  "timeline_group_started",
  "timeline_group_finished",
  "timeline_step_started",
  "timeline_step_updated",
  "timeline_step_finished",
  "timeline_evidence_attached",
  "timeline_artifact_emitted",
  "timeline_command_output",
  "loop_end",
  "task_created",
  "task_updated",
]);

/** Detect whether a frame is potentially an error event
 *  that the normalizer should handle. Used by callers
 *  that want a boolean check before invoking the full
 *  normalizer. */
export function isErrorEvent(frame: EventFrame): boolean {
  if (frame.event !== "task.event") return false;
  const p = frame.payload;
  if (typeof p !== "object" || p === null) return false;
  const payload = p as Record<string, unknown>;
  const innerType =
    typeof payload["type"] === "string" ? (payload["type"] as string) : "";
  if (KNOWN_NON_ERROR_TYPES.has(innerType)) return false;
  if (KNOWN_ERROR_TYPES.has(innerType)) return true;
  // v1.16.5+ (W-UI-002, Phase 3): the previous
  // implementation also treated any frame whose nested
  // `payload.payload.message` was a non-empty string as
  // an error. That was the source of the "Task failed:
  // Completed DISCOVER" regression — the agent's
  // plan-stage group-finished events carry a nested
  // message but are not failures. The defensive branch
  // is now narrower: only a top-level `error` field
  // (vendor's "error" event uses
  // `{ error: <Error> | string }`) is treated as an
  // error when the inner type is unrecognised. Unknown
  // shapes fall through to the unrecognised-shape path
  // in normalizeError, which still surfaces a diagnostic
  // but no longer claims the task failed.
  if (typeof payload["error"] !== "undefined") return true;
  return false;
}

/** Normalize a Work Runtime event frame into a stable
 *  internal error representation, or return null if the
 *  frame is not an error event.
 *
 *  Pure, side-effect free, never throws. See the file
 *  header for the 5 input shapes (A–E). */
export function normalizeError(frame: EventFrame): NormalizedError | null {
  if (frame.event !== "task.event") return null;
  const p = frame.payload;
  if (typeof p !== "object" || p === null) return null;
  const payload = p as Record<string, unknown>;
  const innerType =
    typeof payload["type"] === "string" ? (payload["type"] as string) : "";
  const taskId =
    typeof payload["taskId"] === "string"
      ? (payload["taskId"] as string)
      : undefined;

  if (innerType === "timeline_error") {
    return normalizeTimelineError(payload, taskId);
  }
  if (innerType === "error") {
    return normalizeErrorEvent(payload, taskId);
  }
  if (KNOWN_NON_ERROR_TYPES.has(innerType)) {
    return null;
  }
  // Unknown inner type. The previous App.tsx would have
  // dropped this on the floor. Per the codex directive
  // ("must not swallow events; must do deterministic
  // degradation"), we always return a diagnostic so a
  // future upstream protocol bump surfaces in the UI
  // instead of being silently lost.
  return buildUnknownType(payload, taskId, innerType || "unknown");
}

// ---- internals ---------------------------------------------------------

/** The "diagnostic" branches need to embed the same id in
 *  both `userMessage` and `diagnosticId`. We mint the id
 *  once, build the message around it, then return the
 *  full NormalizedError. Centralised here so the format
 *  stays consistent and the counter is monotonic per
 *  process. */
let _diagnosticCounter = 0;
function newDiagnosticId(): string {
  _diagnosticCounter += 1;
  const ts = Date.now().toString(36);
  return `err-${ts}-${_diagnosticCounter.toString(36)}`;
}

function normalizeTimelineError(
  payload: Record<string, unknown>,
  taskId: string | undefined,
): NormalizedError {
  const message = extractNestedMessage(payload);
  if (message !== undefined) {
    return freeze({
      userMessage: message,
      errorCode: "timeline_error",
      taskId,
      rawEventType: "timeline_error",
      diagnosticId: newDiagnosticId(),
      raw: payload,
    });
  }
  // Upstream emitted a timeline_error but with no readable
  // message. The previous code surfaced this as
  // "Task failed: unknown error". Replace with a
  // deterministic diagnostic that still tells the user
  // AND gives the audit trail something to grep.
  const id = newDiagnosticId();
  return freeze({
    userMessage: `Timeline error reported by daemon with no message field${
      taskId !== undefined ? ` (task ${taskId})` : ""
    } — diagnostic ${id}`,
    errorCode: "timeline_error_no_message",
    taskId,
    rawEventType: "timeline_error",
    diagnosticId: id,
    raw: payload,
  });
}

function normalizeErrorEvent(
  payload: Record<string, unknown>,
  taskId: string | undefined,
): NormalizedError {
  const e = payload["error"];
  if (typeof e === "string") {
    if (e.trim().length > 0) {
      return freeze({
        userMessage: e,
        errorCode: "error_string",
        taskId,
        rawEventType: "error",
        diagnosticId: newDiagnosticId(),
        raw: payload,
      });
    }
    return buildErrorNoMessage(payload, taskId, "empty string");
  }
  if (typeof e === "object" && e !== null) {
    const obj = e as Record<string, unknown>;
    // Real upstream emit (vendor daemon.ts):
    //   logEvent(taskId, "error", { error: <Error | string> })
    // The Error object's `.message` is the readable form.
    const m = obj["message"];
    if (typeof m === "string" && m.trim().length > 0) {
      return freeze({
        userMessage: m,
        errorCode: "error_nested",
        taskId,
        rawEventType: "error",
        diagnosticId: newDiagnosticId(),
        raw: payload,
      });
    }
    return buildErrorNoMessage(payload, taskId, "object without .message");
  }
  return buildErrorNoMessage(payload, taskId, "missing or wrong type");
}

function buildErrorNoMessage(
  payload: Record<string, unknown>,
  taskId: string | undefined,
  reason: string,
): NormalizedError {
  const id = newDiagnosticId();
  return freeze({
    userMessage: `Daemon reported an 'error' event with no readable message (${reason})${
      taskId !== undefined ? ` — task ${taskId}` : ""
    } — diagnostic ${id}`,
    errorCode: "error_no_message",
    taskId,
    rawEventType: "error",
    diagnosticId: id,
    raw: payload,
  });
}

function buildUnrecognized(
  payload: Record<string, unknown>,
  taskId: string | undefined,
  innerType: string,
): NormalizedError {
  const id = newDiagnosticId();
  return freeze({
    userMessage: `Unrecognised Work Runtime error shape (inner type: ${
      innerType || "<missing>"
    })${taskId !== undefined ? `, task ${taskId}` : ""} — diagnostic ${id}`,
    errorCode: "unrecognized_shape",
    taskId,
    rawEventType: innerType || "unknown",
    diagnosticId: id,
    raw: payload,
  });
}

/** Unknown inner type (e.g. a future upstream 'task_failed_v2').
 *  Try to extract a usable message from common paths so the
 *  user still sees something useful; if none is recoverable,
 *  fall back to the diagnostic format. Always returns a
 *  NormalizedError — never null — so a protocol upgrade is
 *  visible to the user instead of silently swallowed. */
function buildUnknownType(
  payload: Record<string, unknown>,
  taskId: string | undefined,
  innerType: string,
): NormalizedError {
  const extracted = extractAnyErrorMessage(payload);
  if (extracted !== undefined) {
    return freeze({
      userMessage: extracted,
      errorCode: "unrecognized_shape",
      taskId,
      rawEventType: innerType,
      diagnosticId: newDiagnosticId(),
      raw: payload,
    });
  }
  return buildUnrecognized(payload, taskId, innerType);
}

/** Generic message extractor used by the unknown-type
 *  branch. Returns the first non-empty string found in
 *  any of the common upstream error payload locations. */
function extractAnyErrorMessage(
  payload: Record<string, unknown>,
): string | undefined {
  const nested = payload["payload"];
  if (typeof nested === "object" && nested !== null) {
    const m = (nested as Record<string, unknown>)["message"];
    if (typeof m === "string" && m.trim().length > 0) return m;
  }
  const e = payload["error"];
  if (typeof e === "string" && e.trim().length > 0) return e;
  if (typeof e === "object" && e !== null) {
    const m = (e as Record<string, unknown>)["message"];
    if (typeof m === "string" && m.trim().length > 0) return m;
  }
  const top = payload["message"];
  if (typeof top === "string" && top.trim().length > 0) return top;
  return undefined;
}

/** Wrap a NormalizedError literal in Object.freeze so the
 *  runtime matches the `readonly` TypeScript contract and
 *  accidental mutations surface as TypeErrors in dev. */
function freeze(e: NormalizedError): NormalizedError {
  return Object.freeze(e);
}

/** Pull a string message out of `payload.payload.message`.
 *  The upstream Cowork-OS `timeline_error` event nests the
 *  message two levels deep (frame.payload.payload.message).
 *  We also accept the shallower `frame.payload.message` as
 *  a defensive fallback for protocol drift / older builds. */
function extractNestedMessage(
  payload: Record<string, unknown>,
): string | undefined {
  const nested = payload["payload"];
  if (typeof nested === "object" && nested !== null) {
    const m = (nested as Record<string, unknown>)["message"];
    if (typeof m === "string" && m.trim().length > 0) return m;
  }
  // Defensive: some builds put the message at the top level.
  const top = payload["message"];
  if (typeof top === "string" && top.trim().length > 0) return top;
  return undefined;
}
