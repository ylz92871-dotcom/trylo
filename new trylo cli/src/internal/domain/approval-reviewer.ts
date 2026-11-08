/**
 * Automatic approval review (C67).
 *
 * Source of the semantics: Codex `core/src/guardian/decision.rs` at commit
 * `73a1148c9c775c2a4616ce5096291740a00ed68a`. Three things are copied:
 *
 *  - the reviewer's answer has three shapes, not two. `allow` and `deny` settle
 *    it; `ask_user` is not a decision but a *refusal to decide*, and it is what
 *    the existing user flow is for. Upstream's own summary line is the rule
 *    worth keeping verbatim in spirit: no contributor is never an implicit
 *    allow.
 *  - `None` (nobble registered) and `AskUser` both fall through to the user
 *    flow unless something forces a review. A missing reviewer therefore
 *    degrades to the behaviour that already exists, which is the only safe way
 *    for a component that may not be installed to be wrong.
 *  - a full-access turn short-circuits to approved, but only after the request
 *    validates. Full access skips the *question*, never the validation.
 *
 * What is deliberately not copied: the reviewer is a prompted subagent upstream,
 * with a compaction-aware context, an analytics event per decision and a V2 flag
 * that is off by default. This module carries none of that. What it carries is
 * the part that is load-bearing: an approval produced by a reviewer is
 * `once`-scoped and never enters the grant cache, so a reviewer cannot write
 * itself a permission slip by approving something.
 */

import type { JsonObject } from "../protocol/envelope.js";
import type { PermissionAction } from "../ports/permission.js";

/**
 * The three answers. `ask_user` is deliberately not a denial: collapsing it into
 * `deny` would make a cautious reviewer indistinguishable from a hostile one,
 * and a cautious reviewer that cannot answer must still let the person decide.
 */
export type ReviewAnswer = "allow" | "deny" | "ask_user";

export type ReviewRequest = {
  readonly action: PermissionAction;
  /**
   * Why this call is being reviewed. Upstream tracks approval reason, retry
   * reason and a network-approval context; only the retry flag changes an
   * outcome here, and it is carried because a retry is exactly the case where
   * reusing an earlier verdict would be wrong.
   */
  readonly retry: boolean;
  /** Why the call needs a decision at all, for a reviewer that explains itself. */
  readonly reason?: string;
};

/**
 * What a reviewer is given, and nothing more.
 *
 * The action already carries its own arguments and fingerprint, so a reviewer
 * cannot be handed a name-only request and be expected to guess. It is *not*
 * given the session, the transcript, the grant cache or the learning system:
 * a reviewer whose verdict is derived from how often the agent has done this
 * before is not reviewing the action, it is reviewing its own habit, and that
 * is the learning system wearing a permission's clothes.
 */
export type ReviewerInput = {
  readonly toolCallId: string;
  readonly name: string;
  readonly arguments: JsonObject;
  readonly pattern: string;
  readonly retry: boolean;
  readonly reason?: string;
};

export type ReviewVerdict = {
  readonly answer: ReviewAnswer;
  /** A reviewer's own words; surfaced to the person when the answer is `ask_user`. */
  readonly rationale?: string;
};

export type Reviewer = {
  readonly name: string;
  review(input: ReviewerInput): Promise<ReviewVerdict>;
};

/**
 * What to do when a reviewer cannot be reached or throws.
 *
 * Codex routes a failed decision extension back into the user flow
 * (`session.services.extensions.decide_approval` returning `None` ends in
 * `None`, which asks the user). Same here: a broken reviewer must not be able to
 * turn a decision into an approval by being unavailable, and it must not be able
 * to turn it into a denial that the user cannot override either. It answers
 * nothing, and the person is asked.
 */
export type ReviewerOutcome =
  | { readonly kind: "reviewed"; readonly verdict: ReviewVerdict }
  | { readonly kind: "unavailable"; readonly reason: "not_installed" | "failed"; readonly message: string };

export const NOT_INSTALLED: ReviewerOutcome = {
  kind: "unavailable",
  reason: "not_installed",
  message: "no automatic approval reviewer is installed",
};

export function reviewerInput(request: ReviewRequest): ReviewerInput {
  return {
    toolCallId: request.action.toolCallId,
    name: request.action.name,
    arguments: request.action.arguments,
    pattern: request.action.pattern,
    retry: request.retry,
    ...(request.reason === undefined ? {} : { reason: request.reason }),
  };
}

/**
 * Run a reviewer, converting anything unexpected into "no answer".
 *
 * A reviewer is a component that may be replaced by configuration, so it is
 * treated as untrusted input: it is called inside a try/catch, its answer is
 * checked against the closed set, and a missing or malformed answer is
 * `unavailable` rather than a guess. `null` (thrown) and a wrong `answer` both
 * land in the same place, because from the caller's side they are the same
 * event: this reviewer did not answer.
 */
export async function runReviewer(
  reviewer: Reviewer | undefined,
  request: ReviewRequest,
): Promise<ReviewerOutcome> {
  if (reviewer === undefined) {
    return NOT_INSTALLED;
  }

  let raw: unknown;

  try {
    raw = await reviewer.review(reviewerInput(request));
  } catch (error) {
    return {
      kind: "unavailable",
      reason: "failed",
      message: `reviewer ${reviewer.name} threw: ${describe(error)}`,
    };
  }

  if (!isReviewVerdict(raw)) {
    return {
      kind: "unavailable",
      reason: "failed",
      message: `reviewer ${reviewer.name} returned something that is not a verdict`,
    };
  }

  return { kind: "reviewed", verdict: raw };
}

function isReviewVerdict(value: unknown): value is ReviewVerdict {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const record = value as Readonly<Record<string, unknown>>;
  if (record.answer !== "allow" && record.answer !== "deny" && record.answer !== "ask_user") {
    return false;
  }

  return record.rationale === undefined || typeof record.rationale === "string";
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error;
}

/**
 * Who reviews, and whether the person is still reachable.
 *
 * Upstream's `ApprovalsReviewer` is a two-value config defaulting to `User`, and
 * a run whose reviewer cannot be `User` is forced through a review even when
 * nothing asked for one. Both halves matter: the default has to be the person,
 * because a default that silently installs a reviewer would move authority
 * without anyone deciding to.
 */
export type ReviewerSelection = "user" | "auto_review";

export const REVIEWER_SELECTIONS: ReadonlyArray<ReviewerSelection> = ["user", "auto_review"];

export function isReviewerSelection(value: string): value is ReviewerSelection {
  return (REVIEWER_SELECTIONS as ReadonlyArray<string>).includes(value);
}

/**
 * The reviewer a configuration selects, or `undefined` for the person.
 *
 * `undefined` here is not "no reviewer": it is the `user` selection, and the
 * caller treats it by asking the human. The distinction is kept only so the
 * log can say which of the two was configured.
 */
export function selectReviewer(selection: ReviewerSelection, reviewer: Reviewer | undefined): Reviewer | undefined {
  return selection === "auto_review" ? reviewer : undefined;
}
