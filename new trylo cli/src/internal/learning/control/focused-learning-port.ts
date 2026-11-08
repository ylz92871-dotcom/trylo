import type { CentralLearningRemaining, CentralLearningFinishResult } from "./coordination-contract.js";

/** Shared scheduling seam. The mounted subsystem owns source selection, funds and learning. */
export type FocusedLearningDecision = { readonly issueId: string; readonly expectedRevision: number;
  readonly reason: string; readonly sourceRefs: readonly string[] };

/** The owner invoked its worker in this call; the marker is never a success verdict. */
export type FocusedLearningDispatch = { readonly workAttempted?: true } & ({ readonly ok: false; readonly reason: string } | {
  readonly ok: true; readonly status: "idle" | "busy" | "completed" | "waiting_dependency" | "failed" | "cancelled";
  readonly issueId?: string; readonly jobId?: string; readonly grantId?: string;
  readonly remaining?: CentralLearningRemaining; readonly result?: CentralLearningFinishResult;
});

export type FocusedLearningPort = {
  focus(input: FocusedLearningDecision, signal: AbortSignal): Promise<FocusedLearningDispatch>;
  resume(signal: AbortSignal): Promise<FocusedLearningDispatch>;
};
