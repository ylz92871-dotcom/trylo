import type { createHermesNodeClient } from "./client.js";
import type { SkillReviewBackend, SkillReviewPreparation, SkillReviewReply } from "../review-process.js";

/** Validate the process boundary once; the review process consumes typed values. */
export function hermesReviewBackend(client: Pick<ReturnType<typeof createHermesNodeClient>, "review">): SkillReviewBackend {
  return {
    async begin(opportunity, signal) {
      const value = await client.review("begin", { opportunity }, signal);
      if (!isPreparation(value)) throw new Error("hermes_review_invalid_preparation");
      return value;
    },
    async finish(reviewId, execution, signal) {
      const value = await client.review("finish", { reviewId, execution }, signal);
      if (!isReply(value)) throw new Error("hermes_review_invalid_reply");
      return value;
    },
    async release(reviewId) {
      const value = await client.review("release", { reviewId });
      if (!record(value) || value.released !== true) throw new Error("hermes_review_invalid_release");
    },
  };
}

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

const identifier = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const identifiers = (value: unknown): value is readonly string[] => Array.isArray(value) && value.every(identifier);

function isPreparation(value: unknown): value is SkillReviewPreparation {
  return record(value) && (value.status === "ready" && identifier(value.reviewId) && identifier(value.prompt)
    || value.status === "skipped" && identifier(value.reasonCode));
}

function isReply(value: unknown): value is SkillReviewReply {
  if (!record(value)) return false;

  if (value.status === "skipped") return identifier(value.reasonCode);

  if (value.status === "failed" || value.status === "cancelled") return identifier(value.error)
    && (value.candidateId === undefined || identifier(value.candidateId)) && (value.pendingIds === undefined || identifiers(value.pendingIds));

  if (!identifier(value.candidateId)) return false;

  return value.status === "no_learning" || value.status === "staged" && identifier(value.pendingId)
    && identifiers(value.pendingIds) && value.pendingIds.length > 0 && new Set(value.pendingIds).size === value.pendingIds.length
    && value.pendingIds.includes(value.pendingId) && value.approval === "required";
}
