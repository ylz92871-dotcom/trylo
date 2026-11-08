import type { HermesSkillAllowance, HermesSkillEntryStop, HermesSkillGrant, HermesSkillHost, HermesSkillLearningResult, HermesSkillNotRun } from "./contracts.js";

/** Admission only. Hermes owns extraction, selection, pending writes and its original reply. */
export function createHermesSkillSubsystem(host: HermesSkillHost) {
  return {
    async learn(grant: HermesSkillGrant, signal: AbortSignal): Promise<HermesSkillLearningResult> {
      if (host.collection() === "disabled") return stopped({ status: "disabled", reason: "collection_disabled" });

      if (signal.aborted) return stopped({ status: "cancelled", reason: "cancelled" });

      if (typeof grant !== "object" || grant === null || grant.subsystem !== "skill" || !validAllowance(grant.allowance)) {
        return stopped({ status: "failed", reason: "invalid_grant" });
      }

      if (grant.allowance.maxCalls === 0 || grant.allowance.maxOutputTokens === 0) {
        return stopped({ status: "waiting", reason: "allowance_exhausted" });
      }

      const opportunity = await host.opportunity(signal);

      if (host.collection() === "disabled") return stopped({ status: "disabled", reason: "collection_disabled" });

      if (signal.aborted) return stopped({ status: "cancelled", reason: "cancelled" });

      if (opportunity === undefined) return stopped({ status: "waiting", reason: "no_opportunity" });

      return host.run(opportunity, grant.allowance, signal);
    },
  };
}

function validAllowance(value: HermesSkillAllowance): boolean {
  return typeof value === "object" && value !== null
    && Number.isSafeInteger(value.maxCalls) && value.maxCalls >= 0
    && Number.isSafeInteger(value.maxOutputTokens) && value.maxOutputTokens >= 0;
}

function stopped(result: HermesSkillEntryStop): HermesSkillNotRun {
  return { ...result, usage: { calls: 0, usageStatus: "reported", outputTokens: 0, totalTokens: 0 } };
}
