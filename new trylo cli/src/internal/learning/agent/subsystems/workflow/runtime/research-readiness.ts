import type { CentralLearningGrant } from "../../../../control/coordination-contract.js";
import type { WorkflowImprovementBoardView } from "./improvement-contracts.js";
import { workflowResearchChain } from "./research-state.js";

/** Domain progress is not inferred from job.completed or from time passing. */
export function workflowResearchReadiness(view: WorkflowImprovementBoardView, inputVersionId: string,
  grant: CentralLearningGrant | undefined, now: number) {
  const chain = workflowResearchChain(view.research ?? [], inputVersionId, grant?.grantId ?? "unfunded");
  if (!chain.ok) return { status: "unavailable" as const, reason: chain.code };

  const head = chain.value.at(-1);
  if (head?.record.status === "stopped") return { status: "terminal" as const, reason: "workflow_research_stopped" };

  if (grant?.claim !== undefined && Date.parse(grant.claim.expiresAt) > now) return { status: "waiting" as const, reason: "workflow_research_live_owner" };

  const confirmed = new Set(chain.value.map(item => item.record.reservationId));
  if (grant?.reservations.some(item => item.state === "reserved" || item.usage?.kind !== "reported"
    || !confirmed.has(item.reservationId))) return { status: "waiting" as const, reason: "workflow_research_sent_step_requires_inspection" };

  return { status: "ready" as const, head, records: chain.value, observations: chain.value.flatMap(item =>
    item.record.status === "continue" ? [item.record.observation] : []),
    localPublication: head?.record.status === "candidate" };
}
