import { contentHashOf } from "../../learning/control/hash.js";
import type { FocusedLearningDispatch } from "../../learning/control/focused-learning-port.js";
import type { CentralFundedStage, CentralStageObservation } from "./contracts.js";
import { readCentralStageDispatchEvidence, retainCentralStageDispatchEvidence, type CentralStageReceiptAddress } from "./stage-dispatch-evidence.js";
import { isCentralFundedStage } from "./funded-stage.js";

/** Only in-flight or unconfirmed actual invocation receipts occupy memory.
 * The immutable archive is evidence, not a job/financial or observation writer. */
export function createCentralStageReceipts(address: CentralStageReceiptAddress) {
  const receipts = new Map<string, { readonly inputHash: string; result?: FocusedLearningDispatch }>();
  const capacity = 128;
  const read = async (input: CentralFundedStage) => {
    const receipt = receipts.get(input.stageRef);
    if (receipt?.inputHash === contentHashOf(input) && receipt.result !== undefined) {
      await retainCentralStageDispatchEvidence(address, input, receipt.result);
    }

    const restored = await readCentralStageDispatchEvidence(address, input);
    if (restored.status === "ready") receipts.delete(input.stageRef);

    return restored;
  };

  return {
    async begin(input: CentralFundedStage): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }> {
      const prior = await readCentralStageDispatchEvidence(address, input);
      if (prior.status !== "absent") return { ok: false, reason: prior.status === "ready" ? "central_stage_dispatch_already_recorded" : prior.reason };
      if (receipts.has(input.stageRef)) return { ok: false, reason: "central_stage_dispatch_in_flight" };
      if (receipts.size >= capacity) return { ok: false, reason: "central_stage_receipt_capacity" };
      receipts.set(input.stageRef, { inputHash: contentHashOf(input) });
      return { ok: true };
    },

    async record(input: CentralFundedStage, result: FocusedLearningDispatch) {
      const receipt = receipts.get(input.stageRef);
      if (receipt?.inputHash !== contentHashOf(input)) return { status: "unknown" as const, reason: "central_stage_dispatch_invocation_mismatch" };

      if (result.workAttempted !== true) {
        receipts.delete(input.stageRef);
        return { status: "not_attempted" as const };
      }

      receipt.result = structuredClone(result);
      const saved = await retainCentralStageDispatchEvidence(address, input, result);
      if (saved.status === "retained") receipts.delete(input.stageRef);

      return saved;
    },

    read,

    async observe(input: CentralFundedStage, signal: AbortSignal,
      observer: (actual: FocusedLearningDispatch) => Promise<CentralStageObservation>): Promise<CentralStageObservation> {
      const pending = (reason: string): CentralStageObservation => ({ outcome: "pending", resultRefs: [], sourceRefs: [], reason });
      if (signal.aborted || !isCentralFundedStage(input)) return pending("central_stage_observation_unavailable");
      const restored = await read(input);
      return restored.status === "ready" ? observer(restored.dispatch)
        : pending(restored.status === "absent" ? "central_stage_completed_dispatch_receipt_required" : restored.reason);
    },
  };
}
