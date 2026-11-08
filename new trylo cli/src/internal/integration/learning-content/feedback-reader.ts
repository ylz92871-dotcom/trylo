import { readFeedbackExplanation, type FeedbackExplanationInput } from "../reward/explanation-reader.js";
import { buildContentFeedbackProjection } from "../../learning/central/content/feedback.js";
import type { ContentFeedbackInput, ContentFeedbackProjection } from "../../learning/central/content/feedback-contracts.js";

/** Actual source/Board read -> identity-checked problem feedback. The existing estimator owns all math. */
export async function readContentFeedbackProjection(input: FeedbackExplanationInput,
  association: Omit<ContentFeedbackInput, "explanation">): Promise<ContentFeedbackProjection> {
  return buildContentFeedbackProjection({ ...association, explanation: await readFeedbackExplanation(input) });
}
