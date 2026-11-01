import { rewardView } from "../../learning/reward/algorithm.js";
import type { RewardCatalog } from "../../learning/reward/catalog.js";
import type { RewardRecords } from "../../learning/reward/contracts.js";
import type { RewardDelivery, RewardInputPort, RewardLedgerPort, RewardOutputPort } from "../../learning/reward/ports.js";
import { isExposureDraft, isRewardFeedback } from "../../learning/reward/validate.js";

/** Host-owned collection and catalog. Only the Board owns facts; output is a replaceable projection. */
export function createRewardGateway(input: {
  readonly enabled: () => boolean;
  readonly catalog: RewardCatalog;
  readonly ledger: RewardLedgerPort;
  readonly output: RewardOutputPort;
  readonly degraded: (reason: string) => void;
}): RewardInputPort {
  async function deliver(records: RewardRecords, scope: string): Promise<RewardDelivery> {
    const revision = records.exposures.length + records.feedbacks.length;
    if (!input.enabled()) return { ok: true, delivery: "pending", revision };
    try {
      await input.output.replace({ schemaVersion: 1, scope, revision,
        signals: rewardView(records).signals.filter(item => item.context.scope === scope) });
      return { ok: true, delivery: "delivered", revision };
    } catch {
      input.degraded("reward_output_unavailable");
      return { ok: true, delivery: "pending", revision };
    }
  }
  return {
    expose: async exposure => {
      if (!input.enabled()) return { ok: false, reason: "collect_disabled" };
      if (!isExposureDraft(exposure) || !input.catalog.accepts(exposure.context.metric, exposure.targets)) {
        return { ok: false, reason: "reward_catalog_mismatch" };
      }
      try { return await input.ledger.expose(exposure); }
      catch { return { ok: false, reason: "reward_ledger_unavailable" }; }
    },
    feedback: async feedback => {
      if (!input.enabled()) return { ok: false, reason: "collect_disabled" };
      if (!isRewardFeedback(feedback)) return { ok: false, reason: "invalid_reward" };
      try {
        const read = await input.ledger.read();
        if (!read.ok) return read;
        const exposure = read.records.exposures.find(item => item.id === feedback.exposureId);
        if (exposure === undefined) return { ok: false, reason: "reward_exposure_missing" };
        if (!input.catalog.accepts(exposure.context.metric, exposure.targets)) return { ok: false, reason: "reward_catalog_mismatch" };
        if (!input.enabled()) return { ok: false, reason: "collect_disabled" };
        const result = await input.ledger.feedback(feedback);
        if (!result.ok) return result;
        const delivered = await deliver(result.records, exposure.context.scope);
        return { ...result, delivery: delivered.ok ? delivered.delivery : "pending" };
      } catch { return { ok: false, reason: "reward_ledger_unavailable" }; }
    },
    signals: async scope => {
      if (!input.enabled()) return { ok: false, reason: "collect_disabled" };
      try {
        const result = await input.ledger.read();
        if (!input.enabled()) return { ok: false, reason: "collect_disabled" };
        return result.ok ? { ok: true, signals: rewardView(result.records).signals.filter(item => item.context.scope === scope) } : result;
      } catch { return { ok: false, reason: "reward_ledger_unavailable" }; }
    },
    sync: async scope => {
      if (!input.enabled()) return { ok: false, reason: "collect_disabled" };
      try {
        const result = await input.ledger.read();
        return result.ok ? deliver(result.records, scope) : result;
      } catch { return { ok: false, reason: "reward_ledger_unavailable" }; }
    },
    inspect: async exposureId => {
      if (!input.enabled()) return { ok: false, reason: "collect_disabled" };
      try {
        const result = await input.ledger.read();
        if (!input.enabled()) return { ok: false, reason: "collect_disabled" };
        if (!result.ok) return result;
        const exposure = result.records.exposures.find(item => item.id === exposureId);
        return exposure === undefined ? { ok: false, reason: "reward_exposure_missing" } :
          { ok: true, exposure, feedbacks: result.records.feedbacks.filter(item => item.exposureId === exposureId) };
      } catch { return { ok: false, reason: "reward_ledger_unavailable" }; }
    },
  };
}
