import type { CentralLearningGrant, CentralLearningRemaining } from "../../../../control/coordination-contract.js";
import type { SkillCentralFunding, SkillCentralWorker } from "./contracts.js";

/** A stage admission view over the original canonical grant. Nothing is charged
 * here: every reservation/settlement still goes through that grant's sole writer.
 * Counting appended reservation identities avoids mistaking an old late refund
 * for new stage capacity. The immutable boundary is the original claim snapshot. */
export function skillStageFunding(work: Parameters<SkillCentralWorker>[0], limits: CentralLearningRemaining, maxPromptChars?: number): SkillCentralFunding {
  const prior = new Set(work.grant.reservations.map(item => item.reservationId));
  let previous = Promise.resolve();
  const remaining = (grant: CentralLearningGrant, current: CentralLearningRemaining): CentralLearningRemaining => {
    const own = grant.reservations.filter(item => !prior.has(item.reservationId));
    const tokens = own.reduce((sum, item) => sum + (item.usage?.kind === "reported" ? item.usage.totalTokens : item.maxTokens), 0);
    return { tokens: Math.min(current.tokens, Math.max(0, limits.tokens - tokens)),
      calls: Math.min(current.calls, Math.max(0, limits.calls - own.length)),
      steps: Math.min(current.steps, Math.max(0, limits.steps - own.length)) };
  };
  const inspect: SkillCentralFunding["inspect"] = async () => {
    const current = await work.funding.inspect();
    if (!current.ok) return current;
    return { ...current, remaining: remaining(current.grant, current.remaining),
      maxPromptChars: Math.min(current.grant.allowance.maxPromptChars, current.maxPromptChars ?? current.grant.allowance.maxPromptChars,
        maxPromptChars ?? current.grant.allowance.maxPromptChars) };
  };

  return {
    inspect,
    reserve(input) {
      // Serialize admission through the canonical reservation, without a second
      // mutable balance. Rejection of one request does not poison later cleanup.
      const reservation = previous.then(async () => {
        const current = await inspect();
        if (!current.ok) return current;

        if (!current.active) return { ok: false as const, reason: "skill_learning_inactive" };

        if (!Number.isSafeInteger(input.maxTokens) || input.maxTokens <= 0 || input.maxTokens > current.remaining.tokens
          || current.remaining.calls < 1 || current.remaining.steps < 1) {
          return { ok: false as const, reason: "learning_grant_exhausted" };
        }

        const reserved = await work.funding.reserve(input);

        return reserved.ok ? { ...reserved, remaining: remaining(reserved.grant, reserved.remaining) } : reserved;
      });

      previous = reservation.then(() => {}, () => { /* The request retains its rejection; this tail only releases admission. */ });

      return reservation;
    },
    async settle(input) {
      const settled = await work.funding.settle(input);
      return settled.ok ? { ...settled, remaining: remaining(settled.grant, settled.remaining) } : settled;
    },
  };
}
