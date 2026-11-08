import type { createSkillReviewProcess, SkillReviewReply } from "../review-process.js";

type Review = ReturnType<typeof createSkillReviewProcess>;

type Timer = ReturnType<typeof setTimeout>;

/** Enforce an explicit caller deadline without inventing a lifetime for native model work. */
export function withSkillReviewDeadline(review: Review, options: {
  readonly timeoutMs?: number;
  readonly setTimer?: (callback: () => void, milliseconds: number) => Timer;
  readonly clearTimer?: (timer: Timer) => void;
} = {}): Review {
  const timeoutMs = options.timeoutMs;
  if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)) throw new Error("hermes_review_deadline_invalid");

  const setTimer = options.setTimer ?? setTimeout, clearTimer = options.clearTimer ?? clearTimeout;

  return async (opportunity, run, signal): Promise<SkillReviewReply> => {
    if (signal.aborted) return { status: "cancelled", error: "cancelled" };

    if (timeoutMs === undefined) return review(opportunity, run, signal);

    const controller = new AbortController();
    let timedOut = false;
    const cancel = () => controller.abort();

    signal.addEventListener("abort", cancel, { once: true });
    const timer = setTimer(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    try {
      if (signal.aborted) cancel();
      const result = await review(opportunity, run, controller.signal);
      return timedOut && !signal.aborted ? { status: "failed", error: "hermes_review_timeout",
        ...("candidateId" in result && result.candidateId !== undefined ? { candidateId: result.candidateId } : {}),
        ...("pendingIds" in result && result.pendingIds !== undefined ? { pendingIds: result.pendingIds } : {}) } : result;
    } catch (error) {
      if (timedOut && !signal.aborted) return { status: "failed", error: "hermes_review_timeout" };
      throw error;
    } finally {
      clearTimer(timer);
      signal.removeEventListener("abort", cancel);
    }
  };
}
