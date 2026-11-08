import type { Transcript } from "../../../../../protocol/transcript.js";
import { nextTranscriptSequence } from "../../../../../loop/transcript-messages.js";
import { skillProposalReceipts, skillReviewToolFailures } from "../proposal-receipts.js";
import type { SkillReviewExecution } from "../review-process.js";

/** Historical observations inform this turn; their failures and staged IDs
 * cannot become new failures or new products of the resumed review. */
export function hermesReviewExecution(transcript: Transcript, status: SkillReviewExecution["status"], history: Transcript = []): SkillReviewExecution {
  const boundary = nextTranscriptSequence(history);
  const current = transcript.filter(item => item.sequence >= boundary);
  return { answer: current.filter(item => item.kind === "assistant_text").map(item => item.text).join("\n"), status,
    toolFailures: skillReviewToolFailures(current), proposals: skillProposalReceipts(current) };
}
