import { centralLearningRemaining } from "../../../../control/coordination-contract.js";
import { coordinationForJob } from "../../../../control/coordination-state.js";
import type { SkillCentralFunding, SkillCoordinationOptions } from "./contracts.js";
import type { SkillBoardAccess } from "./board.js";

/** Spending capability for one existing claim; it cannot fund or enlarge learning. */
export function skillCentralFunding(options: SkillCoordinationOptions, board: SkillBoardAccess,
  binding: { readonly grantId: string; readonly claimId: string }): SkillCentralFunding {
  const inspect: SkillCentralFunding["inspect"] = async () => {
    const loaded = await board.load();
    if (!loaded.ok) return loaded;

    const grant = loaded.state.centralLearningGrants?.find(item => item.grantId === binding.grantId);
    if (grant === undefined || grant.scope !== options.scope || grant.domain !== "skill") return { ok: false, reason: "learning_grant_not_found" };

    const current = coordinationForJob(loaded.state, grant.jobId);
    // No new calls after a transport loses its bill. A late measured receipt
    // may still replace unknown usage through the original central writer.
    const unsettled = grant.reservations.some(item => item.state === "reserved" || item.usage?.kind === "unknown");

    return { ok: true, grant, remaining: centralLearningRemaining(grant), active: !unsettled && grant.status === "open"
      && current?.issue.decision.kind === "focused_learning" && current.job.state === "running"
      && grant.claim?.claimId === binding.claimId && Date.parse(grant.claim.expiresAt) > Date.parse(options.now()) };
  };
  return {
    inspect,
    async reserve(input) {
      const current = await inspect();
      if (!current.ok) return current;

      if (!current.active) return { ok: false, reason: "skill_learning_inactive" };

      const reserved = await board.send({ kind: "reserve", grantId: binding.grantId, claimId: binding.claimId, ...input });
      if (!reserved.ok) return reserved;

      const grant = reserved.state.centralLearningGrants?.find(item => item.grantId === binding.grantId);

      return grant === undefined ? { ok: false, reason: "learning_grant_not_found" }
        : { ok: true, status: reserved.duplicate ? "duplicate" : "reserved", grant, remaining: centralLearningRemaining(grant) };
    },
    async settle(input) {
      // Cancellation/collection withdrawal cannot erase an already incurred bill.
      const settled = await board.send({ kind: "settle", grantId: binding.grantId, ...input }, true);
      if (!settled.ok) return settled;
      const grant = settled.state.centralLearningGrants?.find(item => item.grantId === binding.grantId);
      return grant === undefined ? { ok: false, reason: "learning_grant_not_found" }
        : { ok: true, status: settled.duplicate ? "duplicate" : "settled", grant, remaining: centralLearningRemaining(grant) };
    },
  };
}
