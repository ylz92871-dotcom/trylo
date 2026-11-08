import type { RewardReasonerPort } from "../../learning/reward/ports.js";
import { boundedOperation } from "../shared/bounded-operation.js";

/** Even a faulty reasoner ignoring abort cannot hold the learning host open indefinitely. */
export async function interpretBounded(reasoner: RewardReasonerPort,
  input: Parameters<RewardReasonerPort["interpret"]>[0], timeoutMs: number): Promise<string> {
  return boundedOperation(input.signal, timeoutMs, signal => reasoner.interpret({ ...input, signal }), "reward_reasoner_stopped");
}
