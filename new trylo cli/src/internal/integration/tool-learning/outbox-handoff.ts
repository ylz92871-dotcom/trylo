import type { ToolFileLedger } from "./ledger-file.js";
import { enqueueToolLearningPlan } from "./pipeline-queue.js";
import { toolLearningJobId } from "../../learning/domains/tool/evolution/pipeline.js";

/** An acknowledgement is a handoff receipt, never a second copy of the Board lifecycle. */
export async function handoffPendingToolPlans(input: {
  readonly ledger: ToolFileLedger; readonly boardRoot: string; readonly scope: string; readonly now: () => number; readonly warn: (message: string) => void;
}): Promise<readonly string[]> {
  const pending = (await input.ledger.pendingPlans()).filter(plan => plan.scope === input.scope).slice(0, 3);
  const jobIds: string[] = [];
  for (const plan of pending) {
    const result = await enqueueToolLearningPlan(input.boardRoot, plan);
    if (result.ok) {
      jobIds.push(result.jobId);
      try { await input.ledger.append({ kind: "pipeline_handoff", at: new Date(input.now()).toISOString(), jobId: result.jobId, outcome: "accepted" }); }
      catch {
        // Board already owns the job. A missing acknowledgement may cause only an idempotent handoff replay.
        input.warn("tool learning: handoff acknowledgement unavailable; the Board job remains valid");
      }
    } else {
      input.warn(`tool learning: could not queue gap (${result.code})`);
      if (!result.code.startsWith("automatic_proposal_")) break;
      await input.ledger.append({ kind: "pipeline_handoff", at: new Date(input.now()).toISOString(), jobId: toolLearningJobId(plan), outcome: "rejected", reason: result.code });
    }
  }
  return jobIds;
}
