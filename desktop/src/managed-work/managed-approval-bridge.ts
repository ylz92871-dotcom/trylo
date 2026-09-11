// Trylo — managed-work approval/input bridge (P3 §7.4).
//
// Pure logic bridging CoWork's `input.requested` (an approval or an input
// prompt surfaced by the managed session) and the Trylo ApprovalCard decision.
// The daemon only saves the request state; the actual approval UI is Trylo's.
//
// Rules (doc §7.4):
//   - Child permissions are `min(parent snapshot, ManagedEnvironment ceiling)`
//     — enforced by the caller when constructing the order (CLI side) and by
//     the daemon's permission assertion. The bridge carries the decision.
//   - Sensitive actions are always approved one at a time (never batch).
//   - A `deny` must not be bypassed by the daemon's recovery loop retrying a
//     different tool for the same rejection — the bridge records the requestId
//     decision so a follow-up `input.requested` with the same requestId cannot
//     be re-surfaced as a fresh approval.

export interface ManagedPendingAction {
  type: "approval" | "input";
  requestId: string;
  description: string;
}

export type ManagedDecision = "allow" | "deny";

export interface ManagedInputReceivedEvent {
  type: "input.received";
  requestId: string;
  answers?: Record<string, unknown>;
  status?: string;
}

const SENSITIVE_KEYWORDS = [
  "delete", "send", "purchase", "pay", "login", "sign in", "credential",
  "system settings", "keyboard", "mouse", "install",
];

/** §7.4: sensitive actions must never be auto-approved. */
export function isSensitiveAction(description: string): boolean {
  const lower = description.toLowerCase();
  return SENSITIVE_KEYWORDS.some((k) => lower.includes(k));
}

/** Extract a pending action from a workd broadcast frame whose payload carries
 *  an `input.requested` event (broadcast shape: `managedSession.event` with
 *  `{ sessionId, event }`, or `managedSession.updated` with `{ sessionId,
 *  session }` where the session is `awaiting_input`). */
export function pendingActionFromFrame(payload: unknown): ManagedPendingAction | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;

  // Direct: { event: { type: 'input.requested', payload: { requestId, ... } } }
  const nestedEvent = p.event as Record<string, unknown> | undefined;
  if (nestedEvent && typeof nestedEvent === "object") {
    const action = actionFromInputRequested(nestedEvent);
    if (action) return action;
  }
  // The event's own payload already is { type: 'input.requested', ... }.
  const self = actionFromInputRequested(p);
  if (self) return self;
  // A session object awaiting_input may carry a pending requestId.
  const session = p.session as Record<string, unknown> | undefined;
  if (session && typeof session === "object" && session.status === "awaiting_input") {
    const requestId = stringOr(session.requestId) ?? stringOr(session.pendingRequestId);
    if (requestId) {
      return {
        type: "input",
        requestId,
        description: stringOr(session.requestDescription) ?? "Managed session awaiting your input",
      };
    }
  }
  return null;
}

function actionFromInputRequested(value: Record<string, unknown>): ManagedPendingAction | null {
  if (value.type !== "input.requested") return null;
  const requestId =
    stringOr(value.requestId) ??
    stringOr(value.payload && (value.payload as Record<string, unknown>).requestId) ??
    // Daemon shape: payload.request = { id, questions, ... }
    stringOr(nestedRequest(value.payload)?.id) ??
    stringOr(nestedRequest(value.payload)?.requestId);
  if (!requestId) return null;
  const desc =
    stringOr(value.description) ??
    stringOr(value.message) ??
    stringOr(value.payload && (value.payload as Record<string, unknown>).description) ??
    questionPrompt(nestedRequest(value.payload)) ??
    "Managed session requests approval";
  return {
    type: isSensitiveAction(desc) ? "approval" : "input",
    requestId,
    description: desc,
  };
}

/** `payload.request` may be the request object itself or nested under
 *  `payload.request.request`. */
function nestedRequest(payload: unknown): Record<string, unknown> | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const p = payload as Record<string, unknown>;
  if (p.request && typeof p.request === "object") {
    const req = p.request as Record<string, unknown>;
    if (req.request && typeof req.request === "object") return req.request as Record<string, unknown>;
    return req;
  }
  return undefined;
}

function questionPrompt(request: Record<string, unknown> | undefined): string | undefined {
  if (!request) return undefined;
  const questions = request.questions;
  if (Array.isArray(questions) && questions.length > 0) {
    const first = questions[0] as Record<string, unknown>;
    return stringOr(first?.prompt) ?? stringOr(first?.question) ?? stringOr(first?.label);
  }
  return undefined;
}

function stringOr(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** Build the `managedSession.sendEvent` payload for a user decision (P3 §7.4:
 *  approvals bridge back through `sendEvent(input.received)`). A `deny` records
 *  status `denied` so the same requestId cannot be re-answered as `allow`. */
export function buildInputReceivedEvent(
  requestId: string,
  decision: ManagedDecision,
  answers?: Record<string, unknown>,
): ManagedInputReceivedEvent {
  if (decision === "deny") {
    return { type: "input.received", requestId, status: "denied" };
  }
  return {
    type: "input.received",
    requestId,
    ...(answers && Object.keys(answers).length > 0 ? { answers } : {}),
    status: "approved",
  };
}

/** §7.4: a denied requestId must not be re-surfaced as a fresh approval. */
export function isAlreadyDecided(requestId: string, decided: ReadonlySet<string>): boolean {
  return decided.has(requestId);
}
