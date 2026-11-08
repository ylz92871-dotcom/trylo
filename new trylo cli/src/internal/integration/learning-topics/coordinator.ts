import { LEARNING_DOMAINS, type LearningDomain } from "../../learning/control/contracts.js";
import type { TopicBudgetBid } from "../../learning/control/topic-bid.js";
import { isTopicBudgetBid } from "../../learning/control/topic-allocation.js";
import type { TopicOpportunity } from "../../learning/domains/shared/topics/opportunity.js";
import { canonicalJson } from "../../learning/control/hash.js";
import { identity, sequence } from "../../validation/json-shape.js";
import type { IssuedTopicAllocation, TopicBudgetPool } from "./pool.js";

export type TopicDomainExecutionResult = {
  readonly status: "completed" | "waiting" | "cancelled" | "unknown" | "failed";
  readonly reason?: string;
  /** Only confirmed counts belong here. An unknown execution may omit both fields. */
  readonly processed?: number;
  readonly remaining?: number;
};

export type TopicDomainPort = {
  readonly domain: LearningDomain;
  prepare(input: { readonly boardSequence: number; readonly maxQuota: number; readonly signal: AbortSignal }): TopicOpportunity | Promise<TopicOpportunity>;
  execute(input: { readonly grant: IssuedTopicAllocation; readonly requestId: string; readonly signal: AbortSignal }): Promise<TopicDomainExecutionResult>;
};

export type TopicCoordinatorRequest = { readonly requestId: string; readonly totalQuota: number };

export type TopicPreparationSummary =
  | { readonly domain: LearningDomain; readonly status: "offered"; readonly bid: TopicBudgetBid }
  | { readonly domain: LearningDomain; readonly status: Exclude<TopicOpportunity["status"], "offered">; readonly reason?: string };

export type TopicCoordinatorResult = {
  readonly status: "disabled" | "rejected" | "stale" | "cancelled" | "waiting" | "idle" | "previous" | "completed" | "partial" | "unknown";
  readonly requestId: string;
  readonly reason?: string;
  readonly allocationId?: string;
  readonly preparations: readonly TopicPreparationSummary[];
  readonly results: readonly (TopicDomainExecutionResult & { readonly domain: LearningDomain })[];
};

type Options = {
  readonly pool: TopicBudgetPool;
  readonly domains: readonly TopicDomainPort[];
  /** Host assertion; naming separate domains does not prove additive benefits. */
  readonly domainRelation: "separable";
  readonly enabled?: () => boolean;
};

type RunLog = { preparations: TopicPreparationSummary[]; results: (TopicDomainExecutionResult & { readonly domain: LearningDomain })[] };

/** The allocation and its returned explanation share one immutable, validated offer. */
function snapshotBid(bid: TopicBudgetBid): TopicBudgetBid {
  return Object.freeze({ ...bid, basis: Object.freeze({ ...bid.basis }),
    curve: Object.freeze(bid.curve.map(point => Object.freeze({ ...point }))) });
}

function result(requestId: string, log: RunLog, status: TopicCoordinatorResult["status"], reason?: string, allocationId?: string): TopicCoordinatorResult {
  return Object.freeze({ status, requestId, ...(reason === undefined ? {} : { reason }), ...(allocationId === undefined ? {} : { allocationId }),
    preparations: Object.freeze(log.preparations.map(row => Object.freeze({ ...row }))), results: Object.freeze(log.results.map(row => Object.freeze({ ...row }))) });
}

function executionStatus(value: unknown): value is TopicDomainExecutionResult["status"] {
  return value === "completed" || value === "waiting" || value === "cancelled" || value === "unknown" || value === "failed";
}

function executionSummary(value: unknown, quota: number): TopicDomainExecutionResult | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || Object.keys(value).some(key => !["status", "reason", "processed", "remaining"].includes(key))
    || !("status" in value) || !executionStatus(value.status)
    || ("reason" in value && !identity(value.reason)) || ("processed" in value && !sequence(value.processed))
    || ("remaining" in value && (!sequence(value.remaining) || value.remaining > quota))) return undefined;
  return { status: value.status, ...("reason" in value && typeof value.reason === "string" ? { reason: value.reason } : {}),
    ...("processed" in value && typeof value.processed === "number" ? { processed: value.processed } : {}),
    ...("remaining" in value && typeof value.remaining === "number" ? { remaining: value.remaining } : {}) };
}

/** One explicit nomination over existing domain ports and the existing pool. It never selects a topic or an asset. */
export function createTopicCoordinator(options: Options) {
  const pool = options.pool, policy = pool.policy, enabled = options.enabled ?? (() => false), domainRelation = options.domainRelation;
  const domains = [...options.domains], byDomain = new Map<LearningDomain, TopicDomainPort>();

  for (const port of domains) {
    if (!LEARNING_DOMAINS.includes(port.domain) || byDomain.has(port.domain) || typeof port.prepare !== "function" || typeof port.execute !== "function") {
      throw new Error("topic_coordinator_domains_invalid");
    }
    byDomain.set(port.domain, port);
  }

  if (domainRelation !== "separable") throw new Error("topic_coordinator_relation_required");

  let active: { readonly requestId: string; readonly promise: Promise<TopicCoordinatorResult> } | undefined;
  const collect = async (boardSequence: number, maxQuota: number, signal: AbortSignal, log: RunLog) => {
    const bids: TopicBudgetBid[] = [];

    for (const port of domains) {
      if (signal.aborted || !enabled()) return { status: signal.aborted ? "cancelled" as const : "disabled" as const };

      const opportunity = await port.prepare({ boardSequence, maxQuota, signal });
      if (opportunity.status !== "offered") {
        log.preparations.push({ domain: port.domain, status: opportunity.status, ...("reason" in opportunity ? { reason: opportunity.reason } : {}) });
        continue;
      }

      if (!isTopicBudgetBid(opportunity.bid)) return { status: "rejected" as const };

      const bid = snapshotBid(opportunity.bid);
      if (bid.domain !== port.domain || bid.scope !== policy.scope || bid.basis.boardSequence !== boardSequence
        || bid.utilityUnit !== policy.utilityUnit || bid.quotaUnit !== policy.quotaUnit) return { status: "rejected" as const };

      log.preparations.push({ domain: port.domain, status: "offered", bid });
      bids.push(bid);
    }

    return { status: "ready" as const, bids };
  };
  const execute = async (grant: IssuedTopicAllocation, requestId: string, signal: AbortSignal, log: RunLog) => {
    for (const allocation of grant.allocations) {
      if (allocation.quota === 0) continue;

      if (signal.aborted || !enabled()) return;

      const port = byDomain.get(allocation.domain);
      if (port === undefined) throw new Error("topic_coordinator_domain_missing");

      let summary: TopicDomainExecutionResult;

      try {
        summary = executionSummary(await port.execute({ grant, requestId, signal }), allocation.quota)
          ?? { status: "unknown", reason: "topic_domain_result_invalid" };
      } catch { summary = { status: "unknown", reason: "topic_domain_execution_unconfirmed" }; }

      log.results.push({ domain: allocation.domain, ...summary });
    }
  };

  async function run(request: TopicCoordinatorRequest, signal: AbortSignal): Promise<TopicCoordinatorResult> {
    const log: RunLog = { preparations: [], results: [] };
    const finish = (status: TopicCoordinatorResult["status"], reason?: string, allocationId?: string) => result(request.requestId, log, status, reason, allocationId);
    let allocationId: string | undefined;

    try {
      if (!enabled()) return finish("disabled");

      if (!identity(request.requestId) || !sequence(request.totalQuota) || request.totalQuota > Math.min(6, policy.totalQuota)) return finish("rejected", "topic_coordinator_request_invalid");

      if (signal.aborted) return finish("cancelled");

      const opened = await pool.open();
      if (opened.status !== "open") return finish(opened.status, "reason" in opened ? opened.reason : undefined);

      const previous = await pool.lookupRequest(request.requestId);
      if (previous.status === "previous") return finish("previous", "topic_request_previously_issued", previous.allocationId);

      if (previous.status !== "available") return finish(previous.status, "reason" in previous ? previous.reason : undefined);

      const totalQuota = Math.min(request.totalQuota, previous.remaining);
      if (totalQuota === 0) return finish("idle", "topic_coordinator_zero_quota");

      const prepared = await collect(previous.revision, totalQuota, signal, log);
      if (prepared.status !== "ready") return finish(prepared.status, prepared.status === "rejected" ? "topic_coordinator_bid_binding" : undefined);

      if (signal.aborted || !enabled()) return finish(signal.aborted ? "cancelled" : "disabled");

      if (prepared.bids.length === 0) return finish("waiting", "topic_coordinator_no_valued_domain");

      const issued = await pool.issue(canonicalJson({ schemaVersion: 1, scope: policy.scope, boardSequence: previous.revision,
        utilityUnit: policy.utilityUnit, quotaUnit: policy.quotaUnit, domainRelation, totalQuota, bids: prepared.bids }), request.requestId);
      if (issued.status === "already_issued") return finish("previous", "topic_request_previously_issued", issued.allocationId);

      if (issued.status !== "issued") return finish(issued.status, "reason" in issued ? issued.reason : undefined);

      allocationId = issued.grant.allocationId;
      await execute(issued.grant, request.requestId, signal, log);

      if (signal.aborted || !enabled()) return finish(signal.aborted ? "cancelled" : "disabled", undefined, allocationId);

      return finish(log.results.every(row => row.status === "completed") ? "completed" : "partial", undefined, allocationId);
    } catch { return finish(signal.aborted ? "cancelled" : "unknown", "topic_coordinator_unconfirmed", allocationId); }
  }

  return Object.freeze({
    invoke(request: TopicCoordinatorRequest, signal: AbortSignal): Promise<TopicCoordinatorResult> {
      if (active !== undefined) return active.requestId === request.requestId ? active.promise
        : Promise.resolve(result(request.requestId, { preparations: [], results: [] }, "rejected", "topic_coordinator_busy"));
      const promise = run(request, signal);
      active = { requestId: request.requestId, promise };
      const cleanup = () => { if (active?.promise === promise) active = undefined; };
      void promise.then(cleanup, cleanup);
      return promise;
    },
  });
}
