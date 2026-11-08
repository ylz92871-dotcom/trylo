import type { ProviderContinuationForkReport, ProviderContinuationForkTransfer } from "../../ports/provider.js";
import { forkGlmCheckpoint } from "./glm-continuation-checkpoint.js";

/** Native fork composition for the existing chat checkpoint codec. It touches
 * only its optional extension; ordinary public records remain byte-equivalent. */
export const transferChatContinuationForFork: ProviderContinuationForkTransfer = input => {
  let reboundCheckpoints = 0;
  let nativeCheckpoints = 0;
  const unavailable = new Map<ProviderContinuationForkReport["unavailable"][number]["cause"], number>();
  const records = input.records.map(record => {
    if (!Object.hasOwn(record.payload, "providerContinuation")) return record;

    const transfer = forkGlmCheckpoint(record, input.parentSessionId, input.childSessionId);
    if (transfer.ok) {
      reboundCheckpoints += 1;
      if (transfer.state === "native") nativeCheckpoints += 1;
      return { ...record, payload: { ...record.payload, providerContinuation: transfer.checkpoint } };
    }

    unavailable.set(transfer.cause, (unavailable.get(transfer.cause) ?? 0) + 1);
    // Leaving foreign data in the child could accidentally make its old scope
    // match the new identity. Omit only the unusable child extension; the parent
    // remains the immutable source and the public envelope still crosses.
    const { providerContinuation: _unavailable, ...payload } = record.payload;

    return { ...record, payload };
  });

  return { records, report: { reboundCheckpoints, nativeCheckpoints,
    unavailable: [...unavailable].map(([cause, checkpoints]) => ({ cause, checkpoints })) } };
};
