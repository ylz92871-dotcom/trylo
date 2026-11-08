import type { TopicAllocation } from "../../learning/control/topic-allocation.js";
import { allocateTopicBudget } from "../../learning/control/topic-allocation.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import type { LearningDomain } from "../../learning/control/contracts.js";
import { createRewardV2BoardPort } from "../reward/v2-board-port.js";
import { claimKey, decodePoolLedger, poolKey, poolPolicyRecord, spendKey, validPoolPolicy, type TopicPoolPolicy, type TopicPoolPlan } from "./pool-ledger.js";
import { identity } from "../../validation/json-shape.js";
import { createTopicCalibrationAllocation, readTopicCalibrationRequest, type TopicCalibrationRequest } from "./calibration-allocation.js";

export type IssuedTopicAllocation = { readonly allocationId: string; readonly allocations: TopicAllocation["allocations"] };

type Failure = { readonly status: "rejected"; readonly reason: string } | { readonly status: "disabled" } | { readonly status: "stale" };

type Options = TopicPoolPolicy & { readonly boardRoot: string; readonly enabled?: () => boolean };

/** Durable reservation owner. A claim is a budget fact, never a Permission grant or proof a task ran. */
export function createTopicBudgetPool(options: Options) {
  const enabled = options.enabled ?? (() => false), policy: TopicPoolPolicy = { scope: options.scope, poolId: options.poolId,
    algorithmVersion: options.algorithmVersion, utilityUnit: options.utilityUnit, quotaUnit: options.quotaUnit, totalQuota: options.totalQuota };
  if (!validPoolPolicy(policy)) throw new Error("topic_pool_identity_invalid");

  const board = createRewardV2BoardPort(options.boardRoot, enabled), key = poolKey(policy);
  const capabilities = new WeakMap<IssuedTopicAllocation, TopicPoolPlan>();
  let suspended = false, busy = false;

  async function run<T>(operation: () => Promise<T>): Promise<T | Failure> {
    if (!enabled()) return { status: "disabled" };

    if (suspended) return { status: "rejected", reason: "topic_pool_suspended" };

    if (busy) return { status: "rejected", reason: "topic_pool_busy" };

    busy = true;

    try { return await operation(); }
    catch {
      suspended = true;
      return { status: "rejected", reason: "topic_pool_unconfirmed" };
    }
    finally { busy = false; }
  }

  const read = async () => {
    const view = await board.read();
    return { view, ledger: decodePoolLedger(policy, view.facts) };
  };
  const append = async (revision: number, id: string, body: unknown) => board.append(revision, { id, scope: policy.scope,
    algorithmVersion: policy.algorithmVersion, kind: "learning_decision", payloadJson: canonicalJson(body) });

  function issued(plan: TopicPoolPlan, remaining: number) {
    const grant = Object.freeze({ allocationId: plan.allocationId, allocations: plan.allocations });
    capabilities.set(grant, plan);
    return { status: "issued" as const, grant, remaining };
  }

  return Object.freeze({
    policy: Object.freeze(policy),
    inspect: () => ({ suspended, busy }),

    open() {
      return run(async () => {
        const { view, ledger } = await read();

        if (ledger.opened) return { status: "open" as const, revision: view.revision, remaining: policy.totalQuota - ledger.reserved };

        const write = await append(view.revision, key + ":open", poolPolicyRecord(policy));
        if (write.status === "stale") return { status: "stale" as const };

        if (write.idempotent) {
          const current = await read();
          return { status: "open" as const, revision: current.view.revision, remaining: policy.totalQuota - current.ledger.reserved };
        }

        return { status: "open" as const, revision: write.revision, remaining: policy.totalQuota };
      });
    },

    /** Lookup never reconstructs an execution capability, including after a process restart. */
    lookupRequest(requestId: string) {
      return run(async () => {
        if (!identity(requestId)) return { status: "rejected" as const, reason: "topic_pool_request_invalid" };
        const { view, ledger } = await read();
        if (!ledger.opened) return { status: "rejected" as const, reason: "topic_pool_not_open" };
        const allocationId = ledger.requests.get(requestId);
        if (allocationId !== undefined) return { status: "previous" as const, allocationId, revision: view.revision };
        return { status: "available" as const, revision: view.revision, remaining: policy.totalQuota - ledger.reserved };
      });
    },

    issue(requestJson: string, requestId?: string) {
      return run(async () => {
        if (requestId !== undefined && !identity(requestId)) return { status: "rejected" as const, reason: "topic_pool_request_invalid" };

        const parsed = allocateTopicBudget(requestJson);
        if (parsed.status !== "allocated") return parsed;

        const { request, plan } = parsed, { view, ledger } = await read();

        if (!ledger.opened) return { status: "rejected" as const, reason: "topic_pool_not_open" };

        if (plan.scope !== policy.scope || plan.utilityUnit !== policy.utilityUnit || plan.quotaUnit !== policy.quotaUnit) {
          return { status: "rejected" as const, reason: "topic_pool_binding" };
        }

        const previous = requestId === undefined ? undefined : ledger.requests.get(requestId);
        if (previous !== undefined) return { status: "already_issued" as const, allocationId: previous };

        if (ledger.plans.has(plan.allocationId)) return { status: "already_issued" as const, allocationId: plan.allocationId };

        if (view.revision !== plan.boardSequence) return { status: "stale" as const };

        if (request.totalQuota > policy.totalQuota - ledger.reserved) return { status: "rejected" as const, reason: "topic_pool_quota" };

        if (plan.allocated === 0) return { status: "idle" as const };

        const write = await append(view.revision, `${key}:reserve:${contentHashOf(plan.allocationId)}`,
          { schemaVersion: 1, type: "ws1_topic_reservation", requestJson: canonicalJson(request), plan,
            ...(requestId === undefined ? {} : { requestId }) });
        if (write.status === "stale") return { status: "stale" as const };

        // A replayed reservation must never mint a second live execution capability.
        if (write.idempotent) return { status: "already_issued" as const, allocationId: plan.allocationId };

        return issued(plan, policy.totalQuota - ledger.reserved - plan.allocated);
      });
    },

    /** Explicit host-only calibration. Unknown value is never replaced by a fabricated positive bid. */
    issueCalibration(input: TopicCalibrationRequest) {
      return run(async () => {
        const request = readTopicCalibrationRequest(input);
        if (request === undefined) return { status: "rejected" as const, reason: "topic_calibration_invalid" };

        const { view, ledger } = await read();

        if (!ledger.opened) return { status: "rejected" as const, reason: "topic_pool_not_open" };

        const previous = ledger.requests.get(request.requestId);
        if (previous !== undefined) return { status: "previous" as const, allocationId: previous };

        if (request.quota > policy.totalQuota - ledger.reserved) return { status: "rejected" as const, reason: "topic_pool_quota" };

        const plan = createTopicCalibrationAllocation(policy, view.revision, request);
        const write = await append(view.revision, `${key}:reserve:${contentHashOf(plan.allocationId)}`,
          { schemaVersion: 1, type: "ws1_topic_calibration", purpose: "calibration", ...request, plan });
        if (write.status === "stale") return { status: "stale" as const };

        // A confirmed historical reservation is not a new live execution capability.
        if (write.idempotent) return { status: "previous" as const, allocationId: plan.allocationId };

        return issued(plan, policy.totalQuota - ledger.reserved - plan.allocated);
      });
    },

    claim(grant: IssuedTopicAllocation, domain: LearningDomain, valuationId: string, units: number, spendId: string) {
      return run(async () => {
        const plan = capabilities.get(grant);
        if (plan === undefined) return { status: "rejected" as const, reason: "topic_pool_capability" };

        const allocation = plan.allocations.find(item => item.domain === domain);
        if (allocation === undefined || allocation.valuationId !== valuationId || !identity(spendId) || !Number.isSafeInteger(units) || units < 1) {
          return { status: "rejected" as const, reason: "topic_pool_claim_binding" };
        }

        const { view, ledger } = await read(), offset = ledger.claims.get(claimKey(plan.allocationId, domain)) ?? 0;
        const previous = ledger.spends.get(spendKey(plan.allocationId, domain, spendId));
        if (previous !== undefined) {
          return previous.units === units && previous.valuationId === valuationId
            ? { status: "replayed" as const, claimId: previous.claimId, units }
            : { status: "rejected" as const, reason: "topic_pool_spend_conflict" };
        }

        if (offset + units > allocation.quota) return { status: "rejected" as const, reason: "topic_pool_quota" };

        const claimId = `${key}:claim:${contentHashOf([plan.allocationId, domain, spendId])}`;
        const write = await append(view.revision, claimId, { schemaVersion: 1, type: "ws1_topic_claim", allocationId: plan.allocationId,
          domain, valuationId, offset, units, spendId });
        if (write.status === "stale") return { status: "stale" as const };

        if (write.idempotent) return { status: "rejected" as const, reason: "topic_pool_claim_replayed" };

        return { status: "claimed" as const, claimId, domain, valuationId, units };
      });
    },
  });
}

export type TopicBudgetPool = ReturnType<typeof createTopicBudgetPool>;
