import { LEARNING_DOMAINS, type LearningDomain } from "../../learning/control/contracts.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import type { TopicBudgetBid } from "../../learning/control/topic-bid.js";
import { prepareTopicOpportunity, type TopicOpportunity, type TopicOpportunityInput } from "../../learning/domains/shared/topics/opportunity.js";
import { freezeTopicOpportunityInput, readTopicOpportunitySources } from "../../learning/domains/shared/topics/opportunity-input.js";
import { identity, sequence } from "../../validation/json-shape.js";
import type { TopicDomainExecutionResult, TopicDomainPort } from "./coordinator.js";
import { createTopicDomainExecution } from "./execution.js";
import type { TopicProbePort } from "./execution-contract.js";
import type { TopicExecutionState } from "./execution-state.js";
import type { createTopicBudgetPool, IssuedTopicAllocation } from "./pool.js";
import { createRewardV2BoardPort } from "../reward/v2-board-port.js";
import { topicExperimentBindings } from "./experiment-binding.js";

type Preparation = Parameters<TopicDomainPort["prepare"]>[0];

export type PreparedTopicDomain = {
  readonly input: TopicOpportunityInput; readonly probe: TopicProbePort;
  readonly checkerVersion: string; readonly executionVersion: string;
  /** Host-declared deadline is part of its versioned experiment protocol. */
  readonly timeoutMs?: number;
};

export type TopicDomainRuntimeOptions = {
  readonly boardRoot: string; readonly domain: LearningDomain; readonly scope: string;
  readonly pool: ReturnType<typeof createTopicBudgetPool>; readonly enabled?: () => boolean;
  /** Trusted local model preparation only. It must not call a provider or execute an experiment. */
  readonly prepareInput: (request: Preparation) => PreparedTopicDomain | undefined | Promise<PreparedTopicDomain | undefined>;
};

type Binding = PreparedTopicDomain & { readonly bid: TopicBudgetBid };

type Execution = { readonly requestId: string; readonly result: Promise<TopicDomainExecutionResult> };

export type TopicDomainRuntimeResult = { readonly status: "ready"; readonly port: TopicDomainPort }
  | { readonly status: "rejected"; readonly reason: "topic_domain_binding" };

function result(status: TopicDomainExecutionResult["status"], reason: string, state?: TopicExecutionState): TopicDomainExecutionResult {
  return { status, reason, ...(state === undefined ? {} : { processed: state.applied, remaining: state.remaining }) };
}

const invalidBinding = (): TopicOpportunity => ({ status: "rejected", reason: "topic_model_binding" });

/** Domain-owned composition over the existing pool and execution controller; it has no independent ledger. */
export function createTopicDomainRuntime(options: TopicDomainRuntimeOptions): TopicDomainRuntimeResult {
  const enabled = options.enabled ?? (() => false), policy = options.pool.policy;
  if (!LEARNING_DOMAINS.some(domain => domain === options.domain) || !identity(options.scope)
    || options.scope !== policy.scope || typeof options.prepareInput !== "function") {
    return { status: "rejected", reason: "topic_domain_binding" };
  }

  let binding: Binding | undefined, preparing = false, executing = false;
  const executions = new WeakMap<IssuedTopicAllocation, Execution>();

  async function prepare(request: Preparation): Promise<TopicOpportunity> {
    if (!enabled() || request.signal.aborted || preparing || executing) return { status: "empty" };

    binding = undefined;

    if (!sequence(request.boardSequence) || !Number.isSafeInteger(request.maxQuota)
      || request.maxQuota < 0 || request.maxQuota > Math.min(6, policy.totalQuota)) {
      return { status: "rejected", reason: "topic_opportunity_budget" };
    }

    preparing = true;

    try {
      const prepared = await options.prepareInput(Object.freeze({ ...request }));

      if (!enabled() || request.signal.aborted) return { status: "empty" };

      if (prepared === undefined) return { status: "unvalued", reason: "topic_model_required" };

      const input = freezeTopicOpportunityInput(prepared.input);
      if (input === undefined) return invalidBinding();

      const sources = readTopicOpportunitySources(input);
      if (sources.status !== "ready") return sources;

      if (sources.windows.some(window => window.scope !== options.scope || window.boardSequence > request.boardSequence)
        || sources.boardSequence !== request.boardSequence
        || input.utilityUnit !== policy.utilityUnit || input.quotaUnit !== policy.quotaUnit || input.maxQuota !== request.maxQuota) {
        return invalidBinding();
      }

      // An immutable host resolution may route an earlier prompt question without rewriting its identity.
      if (sources.domain !== options.domain) return invalidBinding();

      if (sources.bindings.size > 0) {
        const actual = await createRewardV2BoardPort(options.boardRoot, enabled).read();
        if (actual.revision !== request.boardSequence || !enabled() || request.signal.aborted) return invalidBinding();
        const recorded = topicExperimentBindings(actual.facts, options.scope);
        for (const resolution of sources.bindings.values()) {
          if (!recorded.some(row => canonicalJson(row) === canonicalJson(resolution))) return invalidBinding();
        }
      }

      const offer = prepareTopicOpportunity(input);
      if (offer.status !== "offered") return offer;

      if (offer.bid.domain !== options.domain || offer.bid.scope !== options.scope
        || offer.bid.basis.boardSequence !== request.boardSequence || offer.bid.utilityUnit !== policy.utilityUnit
        || offer.bid.quotaUnit !== policy.quotaUnit || !identity(prepared.checkerVersion) || !identity(prepared.executionVersion)
        || (prepared.timeoutMs !== undefined && (!Number.isSafeInteger(prepared.timeoutMs) || prepared.timeoutMs < 1 || prepared.timeoutMs > 60000))
        || input.probeBindingHash !== contentHashOf({ checkerVersion: prepared.checkerVersion, executionVersion: prepared.executionVersion })
        || typeof prepared.probe?.run !== "function" || typeof prepared.probe.readObservation !== "function") return invalidBinding();

      // Capture the methods once; replacing the caller's port or input later cannot change this offer.
      const probe: TopicProbePort = Object.freeze({ run: prepared.probe.run.bind(prepared.probe),
        readObservation: prepared.probe.readObservation.bind(prepared.probe) });

      binding = Object.freeze({ input, probe, bid: offer.bid,
        ...(prepared.timeoutMs === undefined ? {} : { timeoutMs: prepared.timeoutMs }),
        checkerVersion: prepared.checkerVersion, executionVersion: prepared.executionVersion });

      return offer;
    } catch { return invalidBinding(); }
    finally { preparing = false; }
  }

  async function execute(prepared: Binding | undefined, request: Parameters<TopicDomainPort["execute"]>[0]): Promise<TopicDomainExecutionResult> {
    if (request.signal.aborted) return result("cancelled", "topic_domain_cancelled");

    if (!enabled()) return result("waiting", "topic_domain_disabled");

    if (preparing || executing) return result("waiting", "topic_domain_busy");

    if (prepared === undefined) return result("waiting", "topic_domain_unprepared");

    const allocation = request.grant.allocations.find(row => row.domain === options.domain);
    if (allocation === undefined || allocation.valuationId !== prepared.bid.valuationId || allocation.bidHash !== contentHashOf(prepared.bid)
      || !Number.isSafeInteger(allocation.quota) || allocation.quota < 1 || allocation.quota > prepared.input.maxQuota) {
      return result("failed", "topic_domain_grant_binding");
    }

    executing = true;

    try {
      const created = createTopicDomainExecution({ boardRoot: options.boardRoot, input: prepared.input, pool: options.pool,
        grant: request.grant, requestId: request.requestId, checkerVersion: prepared.checkerVersion,
        executionVersion: prepared.executionVersion, enabled,
        ...(prepared.timeoutMs === undefined ? {} : { timeoutMs: prepared.timeoutMs }) });
      if (created.status !== "ready") return result("waiting", created.status === "rejected" ? created.reason : "topic_domain_disabled");

      const opened = await created.controller.open();
      if (opened.status !== "open") return result(opened.status === "unknown" ? "unknown" : "waiting",
        "reason" in opened ? opened.reason : "topic_domain_disabled");

      let state: TopicExecutionState = opened;
      if (state.unknown || state.pending !== null) return result("unknown", "topic_probe_pending", state);

      for (let steps = 0; steps < allocation.quota; steps++) {
        if (request.signal.aborted) return result("cancelled", "topic_domain_cancelled", state);

        if (!enabled()) return result("waiting", "topic_domain_disabled", state);

        if (state.remaining === 0) return result("completed", "topic_domain_quota_consumed", state);

        const observed = await created.controller.step(prepared.probe, request.signal);

        // A cancelled in-flight operation may already have charged its claim. Do not report stale balances.
        if (request.signal.aborted || observed.status === "cancelled") return result("cancelled", "topic_domain_cancelled");

        if (!enabled() || observed.status === "disabled") return result("waiting", "topic_domain_disabled");

        const current = await created.controller.view();
        if (current.status !== "state") return result("unknown", "reason" in current ? current.reason : "topic_domain_unconfirmed");

        if (observed.status === "unknown" || current.unknown || current.pending !== null) {
          return result("unknown", "reason" in observed ? observed.reason : "topic_probe_pending", current);
        }

        if (observed.status === "rejected") return result("waiting", observed.reason, current);

        if (observed.status === "stopped") return result("completed", "topic_domain_stopped", current);

        if (observed.status !== "observed" || current.applied !== state.applied + 1 || current.remaining >= state.remaining) {
          return result("unknown", "topic_domain_nonprogress", current);
        }

        state = current;
      }

      return result(state.remaining === 0 ? "completed" : "waiting",
        state.remaining === 0 ? "topic_domain_quota_consumed" : "topic_domain_step_limit", state);
    } finally { executing = false; }
  }

  const port: TopicDomainPort = Object.freeze({ domain: options.domain, prepare,

    execute(request: Parameters<TopicDomainPort["execute"]>[0]) {
      const accepted = Object.freeze({ grant: request.grant, requestId: request.requestId, signal: request.signal });
      if (!identity(accepted.requestId) || accepted.grant === null || typeof accepted.grant !== "object" || !Array.isArray(accepted.grant.allocations)) {
        return Promise.resolve(result("failed", "topic_domain_request_invalid"));
      }

      const previous = executions.get(accepted.grant);
      if (previous !== undefined) return previous.requestId === accepted.requestId ? previous.result
        : Promise.resolve(result("failed", "topic_domain_request_conflict"));

      const prepared = binding;
      const outcome = Promise.resolve().then(() => execute(prepared, accepted))
        .catch(() => result("unknown", "topic_domain_unconfirmed"));

      executions.set(accepted.grant, { requestId: accepted.requestId, result: outcome });

      return outcome;
    },
  });

  return { status: "ready", port };
}
