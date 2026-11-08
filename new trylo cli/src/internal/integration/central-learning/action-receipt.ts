import type { createLearningAllocationApplication } from "../learning-allocation/application.js";

type ActionResult = Awaited<ReturnType<ReturnType<typeof createLearningAllocationApplication>["reconcile"]>>;

/** Original writer results include the private Board snapshot. Tool/UI output
 * carries only the confirmed revision or failure; unrelated asset content and
 * other workspace histories never cross this boundary. */
export function centralActionReceipt(result: ActionResult) {
  if ("ok" in result && result.ok) return { status: "confirmed" as const,
    boardSequence: result.state.sequence, idempotent: result.idempotent };
  if ("reason" in result) return { status: "unconfirmed" as const, reason: result.reason };
  return { status: result.status };
}
