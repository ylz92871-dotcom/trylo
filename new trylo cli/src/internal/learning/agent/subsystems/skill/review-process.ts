import type { HermesSkillOpportunity } from "./contracts.js";
import { skillFailureCode } from "./failure.js";

export type SkillProposalReceipt = { readonly pendingId: string; readonly name: string; readonly action: string };

export type SkillReviewExecution = { readonly answer: string; readonly proposals: readonly SkillProposalReceipt[];
  readonly status: "completed" | "failed" | "cancelled";
  /** Absent if execution failed before a complete transcript was returned. */
  readonly toolFailures?: number };

export type SkillReviewPreparation = { readonly status: "ready"; readonly reviewId: string; readonly prompt: string }
  | { readonly status: "skipped"; readonly reasonCode: string };

export type SkillReviewReply = { readonly status: "staged"; readonly candidateId: string; readonly pendingId: string;
  readonly pendingIds: readonly string[]; readonly approval: "required" }
  | { readonly status: "no_learning"; readonly candidateId: string }
  | { readonly status: "skipped"; readonly reasonCode: string }
  | { readonly status: "failed" | "cancelled"; readonly candidateId?: string; readonly error: string; readonly pendingIds?: readonly string[] };

/** Native operations are storage/prompt adapters; this subsystem owns the review lifecycle. */
export type SkillReviewBackend = {
  readonly begin: (opportunity: HermesSkillOpportunity, signal: AbortSignal) => Promise<SkillReviewPreparation>;
  readonly finish: (reviewId: string, execution: SkillReviewExecution, signal: AbortSignal) => Promise<SkillReviewReply>;
  readonly release: (reviewId: string) => Promise<void>;
};

export function createSkillReviewProcess(backend: SkillReviewBackend) {
  return async (opportunity: HermesSkillOpportunity, run: (prompt: string, signal: AbortSignal) => Promise<SkillReviewExecution>,
    signal: AbortSignal): Promise<SkillReviewReply> => {
    if (signal.aborted) return { status: "cancelled", error: "cancelled" };

    const prepared = await backend.begin(opportunity, signal);
    if (prepared.status === "skipped") return prepared;

    let result: SkillReviewReply;

    try {
      const execution = await run(prepared.prompt, signal);
      if (signal.aborted && execution.proposals.length === 0) {
        result = { status: "cancelled", candidateId: prepared.reviewId, error: "cancelled" };
      } else {
        // Staging may commit before or during cancellation. Once real receipts
        // exist, finish is bounded reconciliation and cannot be interrupted by
        // the model's signal. It grants no approval or further model work.
        const finishing = signal.aborted ? { ...execution, status: "cancelled" as const } : execution;
        const finalized = await backend.finish(prepared.reviewId, finishing,
          execution.proposals.length > 0 ? new AbortController().signal : signal);

        result = signal.aborted ? { status: "cancelled", candidateId: prepared.reviewId, error: "cancelled",
          ...("pendingIds" in finalized && finalized.pendingIds !== undefined ? { pendingIds: finalized.pendingIds } : {}) } : finalized;
      }
    } catch (error) {
      result = { status: signal.aborted ? "cancelled" : "failed", candidateId: prepared.reviewId,
        error: skillFailureCode(error, "hermes_review_execution_failed") };
    }

    // Release cannot use an already-aborted signal. It never removes pending
    // writes: cancellation after staging is an unknown/partial native outcome.
    try { await backend.release(prepared.reviewId); }
    catch {
      const pendingIds = result.status === "staged" || result.status === "failed" || result.status === "cancelled" ? result.pendingIds : undefined;
      return { status: "failed", candidateId: prepared.reviewId, error: "hermes_review_release_failed",
        ...(pendingIds === undefined ? {} : { pendingIds }) };
    }

    return result;
  };
}
