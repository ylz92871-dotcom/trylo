import type { PermissionAction, PermissionPort, PermissionReason } from "../ports/permission.js";
import type { ToolSandbox } from "../ports/tools.js";
import type { JsonObject } from "../protocol/envelope.js";
import {
  isEscalatableRefusal,
  type EscalationAuthority,
  type EscalationInput,
  type EscalationTicket,
} from "../domain/sandbox-escalation.js";
import { awaitPermissionDecision } from "./permission-boundary.js";
import type { DoomLoopTracker } from "./doom-loop.js";
import type { PermissionGrantCache } from "./permission-grants.js";
import { buildPermissionAction } from "./permission-grants.js";
import {
  runReviewer,
  type ReviewRequest,
  type Reviewer,
  type ReviewerOutcome,
} from "../domain/approval-reviewer.js";

/**
 * Tool admission: the order in which the guards run is the design.
 *
 *   1. build the action — arguments and their fingerprint must exist, so a
 *      name-only request cannot be approved into a licence for everything;
 *   2. sandbox — something the sandbox already forbids is never put in front of
 *      a person, because asking implies it might be allowed;
 *   3. execution policy — what the operator wrote down about *this command*.
 *      A written refusal is terminal for the same reason a sandbox refusal is,
 *      and a written allowance is answered without involving a human who has
 *      already delegated that decision;
 *   4. repeat detection — a call seen this many times is no longer covered by a
 *      remembered decision;
 *   5. remembered decision — exact calls only;
 *   6. the automatic reviewer (C67) — asked only for calls that reached this
 *      far, and only when one is configured;
 *   7. the permission port — the human, last, and only when needed.
 *
 * Steps 1 and 2 are what make every later step unable to widen access. Step 3
 * sits above a remembered session grant on purpose: a cache answers "this was
 * allowed before this session started talking", a policy answers "this is how
 * this machine is run", and when they disagree the standing instruction has to
 * win or the operator's own configuration becomes advisory.
 *
 * Step 6 sits *below* the cache and *above* the human, and that position is the
 * whole design. A reviewer that ran before the cache would be asked about calls
 * a person already answered this session, which is both wasteful and a way for
 * a reviewer to relitigate a decision that was already made. A reviewer that ran
 * after the human would be decoration. And a reviewer's approval is never
 * written into the cache, so reviewing something does not make the next
 * identical call skip the question - a reviewer that could approve its way to a
 * standing grant would be a grant with extra steps.
 *
 * A refused call has one way out, and it is step 2's own (C65): a refusal that
 * is a drawn boundary rather than a fact may be put to a person once, carrying
 * the refusal it is asking about. Everything else about that path - deciding
 * which refusals qualify, reading the answer back, spending it once - belongs to
 * whoever owns {@link EscalationAuthority}, so nothing here can escalate a
 * refusal into a habit.
 */

/**
 * The command-policy seam (C66/L64).
 *
 * One function, deliberately: the loop is not allowed to know which tool
 * arguments are a command, and the policy is not allowed to know anything about
 * tools. Returning `undefined` means "there is no command here, say nothing",
 * which is how a tool with no command keeps behaving exactly as it does today.
 */
export type ExecPolicyVerdict =
  | { readonly kind: "approved" }
  | { readonly kind: "denied"; readonly code: string; readonly message: string };

export type ExecPolicyGuard = (call: ToolAdmissionRequest) => ExecPolicyVerdict | undefined;

export type AdmissionPorts = {
  readonly permission: PermissionPort;
  readonly sandbox?: ToolSandbox;
  readonly grants: PermissionGrantCache;
  readonly doom: DoomLoopTracker;
  /** Absent means no execution policy is configured, which is today's behaviour. */
  readonly execPolicy?: ExecPolicyGuard;
  /** Absent means a sandbox refusal is simply final, which is today's behaviour. */
  readonly escalation?: EscalationAuthority;
  /**
   * Absent means nobody reviews automatically and the human is asked directly.
   * That is the `user` reviewer, and it is the default: a call nobody reviewed is
   * never an approved one.
   */
  readonly reviewer?: Reviewer;
};

export type AdmissionSource = "prompt" | "remembered" | "policy" | "escalation" | "reviewed";

export type ToolAdmission =
  | { readonly kind: "approved"; readonly source: AdmissionSource }
  | { readonly kind: "denied"; readonly source: AdmissionSource; readonly reason?: PermissionReason }
  | { readonly kind: "cancelled"; readonly reason?: PermissionReason }
  | { readonly kind: "expired" }
  | { readonly kind: "failed"; readonly message: string }
  | {
      readonly kind: "policy_rejected";
      readonly code: string;
      readonly message: string;
    }
  | {
      readonly kind: "sandbox_rejected";
      readonly code: string;
      readonly message: string;
      /** Set when a person was asked to release this refusal and declined. */
      readonly escalated?: boolean;
    }
  | {
      /** A configured reviewer answered `deny`. Carries its own words. */
      readonly kind: "review_rejected";
      readonly reviewer: string;
      readonly rationale: string;
    };

export type ToolAdmissionRequest = {
  readonly toolCallId: string;
  readonly name: string;
  readonly arguments: JsonObject;
  /**
   * Set when a caller is re-presenting a call the sandbox already refused and a
   * person already released. Nothing here trusts its contents: it is a reference
   * whose facts are read back on the other side.
   */
  readonly resume?: EscalationTicket;
};

export function actionFor(request: ToolAdmissionRequest): PermissionAction {
  return buildPermissionAction(request.toolCallId, request.name, request.arguments);
}

export async function admitToolCall(
  ports: AdmissionPorts,
  request: ToolAdmissionRequest,
): Promise<ToolAdmission> {
  // A standing operator denial cannot be overridden by a previous exact-call
  // approval, an execution-policy allowance, a reviewer or an escalation.
  if (ports.permission.isDenied?.(request.name) === true) return { kind: "denied", source: "policy", reason: "policy_denied" };
  if (ports.grants.isDenied(request.name)) return { kind: "denied", source: "remembered", reason: "remembered_denial" };
  const stopped = await runSandboxGuard(ports, request);
  if (stopped !== undefined) {
    return stopped;
  }
  if (ports.execPolicy !== undefined) {
    const verdict = ports.execPolicy(request);
    if (verdict !== undefined) {
      if (verdict.kind === "denied") {
        return { kind: "policy_rejected", code: verdict.code, message: verdict.message };
      }
      return { kind: "approved", source: "policy" };
    }
  }
  const action = actionFor(request);
  const repeated = ports.doom.observe(action);
  if (repeated === false) {
    const remembered = ports.grants.lookup(action);
    if (remembered.kind === "approved") {
      return { kind: "approved", source: "remembered" };
    }
    if (remembered.kind === "denied") {
      return { kind: "denied", source: "remembered", reason: "remembered_denial" };
    }
  }
  const reviewed = await runReviewerGuard(ports, request, action);
  if (reviewed !== undefined) {
    return reviewed;
  }
  const answered = await awaitPermissionDecision(ports.permission, action);
  if (answered.outcome === "failed") {
    return { kind: "failed", message: answered.message };
  }
  ports.grants.record(action, answered.resolution, answered.scope);
  switch (answered.resolution) {
    case "approved":
      return { kind: "approved", source: "prompt" };
    case "denied":
      return { kind: "denied", source: "prompt", ...(answered.reason === undefined ? {} : { reason: answered.reason }) };
    case "cancelled":
      return { kind: "cancelled", ...(answered.reason === undefined ? {} : { reason: answered.reason }) };
    default:
      return { kind: "expired" };
  }
}

/**
 * The automatic review gate (C67).
 *
 * `undefined` means the reviewer did not answer and the human is asked, which is
 * the whole failure policy: `unavailable` for any reason lands here too. Only two
 * reviewer answers are terminal. `allow` settles this one call and is
 * deliberately *not* recorded in the grant cache — see the note on step 6 in the
 * file header for why a review must not become a standing grant. `ask_user` is
 * not a denial, so it falls through to the prompt with the reviewer's words
 * attached, and only a `deny` becomes a refusal the model is told about.
 */
async function runReviewerGuard(
  ports: AdmissionPorts,
  request: ToolAdmissionRequest,
  action: PermissionAction,
): Promise<ToolAdmission | undefined> {
  if (ports.reviewer === undefined) {
    return undefined;
  }
  const review: ReviewRequest = {
    action,
    // A retry is a call the sandbox already refused once and a person already
    // released; it is exactly the case where a verdict carried over from the
    // first attempt would be answering a question nobody asked.
    retry: request.resume !== undefined,
  };
  const outcome: ReviewerOutcome = await runReviewer(ports.reviewer, review);
  if (outcome.kind === "unavailable") {
    return undefined;
  }
  switch (outcome.verdict.answer) {
    case "allow":
      return { kind: "approved", source: "reviewed" };
    case "deny":
      return {
        kind: "review_rejected",
        reviewer: ports.reviewer.name,
        rationale: outcome.verdict.rationale ?? "no reason given",
      };
    default:
      return undefined;
  }
}

/**
 * The sandbox gate, plus the one way past it.
 *
 * `undefined` means the call may continue. Anything else is a terminal verdict,
 * and the ordering inside is the guard chain: an already-presented release is
 * redeemed first (it *is* the answer to this exact refusal), and only a
 * refusal that is a drawn boundary is put to a person at all. A refusal that is
 * a fact, or a host with no escalation authority, ends here exactly as it
 * always did.
 */
async function runSandboxGuard(
  ports: AdmissionPorts,
  request: ToolAdmissionRequest,
): Promise<ToolAdmission | undefined> {
  if (ports.sandbox === undefined) {
    return undefined;
  }
  const verdict = ports.sandbox.evaluate({
    toolCallId: request.toolCallId,
    name: request.name,
    arguments: request.arguments,
  });
  if (verdict.ok) {
    return undefined;
  }
  if (ports.escalation === undefined) {
    return { kind: "sandbox_rejected", code: verdict.code, message: verdict.message };
  }
  const input: EscalationInput = {
    toolCallId: request.toolCallId,
    name: request.name,
    arguments: request.arguments,
    code: verdict.code,
    message: verdict.message,
  };
  if (request.resume !== undefined && ports.escalation.redeem(request.resume, input)) {
    return undefined;
  }
  if (!isEscalatableRefusal(verdict.code)) {
    return { kind: "sandbox_rejected", code: verdict.code, message: verdict.message };
  }
  const asked = await ports.escalation.request(input);
  if (asked.ok) {
    return { kind: "approved", source: "escalation" };
  }
  if (asked.reason === "cancelled") {
    return { kind: "cancelled", reason: "user_cancelled" };
  }
  if (asked.reason === "failed") {
    return { kind: "failed", message: asked.message };
  }
  return {
    kind: "sandbox_rejected",
    code: verdict.code,
    message: verdict.message,
    escalated: true,
  };
}
