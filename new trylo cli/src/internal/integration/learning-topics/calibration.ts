import { LEARNING_DOMAINS, type LearningDomain } from "../../learning/control/contracts.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { identity, sequence } from "../../validation/json-shape.js";
import { createRewardV2BoardPort, type RewardV2BoardSnapshot } from "../reward/v2-board-port.js";
import { boundedOperation } from "../shared/bounded-operation.js";
import { calibrationBidHash } from "./calibration-allocation.js";
import { readTopicCalibrationReceipt, type TopicCalibrationExpectation, type TopicCalibrationReceipt } from "./execution-contract.js";
import type { TopicBudgetPool, IssuedTopicAllocation } from "./pool.js";
import { poolKey, readPoolClaim } from "./pool-ledger.js";

export type TopicCalibrationProtocol = {
  /** Trusted host identity for the recipe, units, checker/executor versions and deadline. */
  readonly protocolHash: string; readonly units: number;
  readonly checkerVersion: string; readonly executionVersion: string; readonly timeoutMs?: number;
  run(expected: TopicCalibrationExpectation, signal: AbortSignal): Promise<string>;
  readObservation(ref: string, expected: TopicCalibrationExpectation, signal: AbortSignal): Promise<string>;
};

export type TopicCalibrationRequest = { readonly requestId: string; readonly domain: LearningDomain; readonly quota: number };

export type TopicCalibrationResult = {
  readonly status: "disabled" | "rejected" | "waiting" | "previous" | "completed" | "cancelled" | "unknown";
  /** Number of results whose durable write was confirmed in this invocation, not a claim about unknown work. */
  readonly processed: number; readonly remaining?: number; readonly reason?: string;
};

type Options = {
  readonly boardRoot: string; readonly pool: TopicBudgetPool; readonly enabled?: () => boolean;
  /** Pure local selection of a host-approved protocol; no provider or experiment runs during preparation. */
  readonly prepare: (input: { readonly domain: LearningDomain; readonly signal: AbortSignal }) =>
    TopicCalibrationProtocol | undefined | Promise<TopicCalibrationProtocol | undefined>;
};

type BoundProtocol = TopicCalibrationProtocol & { readonly timeoutMs: number };

const ALGORITHM = "ws1-topic-calibration-v1";

function summary(status: TopicCalibrationResult["status"], processed: number, reason: string, remaining?: number): TopicCalibrationResult {
  return Object.freeze({ status, processed, reason, ...(remaining === undefined ? {} : { remaining }) });
}

function bindProtocol(protocol: TopicCalibrationProtocol): BoundProtocol | undefined {
  const timeoutMs = protocol.timeoutMs ?? 60000;
  if (!/^[a-f0-9]{64}$/.test(protocol.protocolHash) || !Number.isSafeInteger(protocol.units) || protocol.units < 1
    || !identity(protocol.checkerVersion) || !identity(protocol.executionVersion) || !Number.isSafeInteger(timeoutMs)
    || timeoutMs < 1 || timeoutMs > 60000 || typeof protocol.run !== "function" || typeof protocol.readObservation !== "function") return undefined;

  return Object.freeze({ protocolHash: protocol.protocolHash, units: protocol.units, checkerVersion: protocol.checkerVersion,
    executionVersion: protocol.executionVersion, timeoutMs,
    run: protocol.run.bind(protocol), readObservation: protocol.readObservation.bind(protocol) });
}

/** Explicit finite calibration over the existing pool/Board. It never manufactures a value model or updates a posterior. */
export function createTopicCalibrationRuntime(options: Options) {
  const pool = options.pool, policy = pool.policy, enabled = options.enabled ?? (() => false);
  const board = createRewardV2BoardPort(options.boardRoot, enabled);
  let active: { readonly key: string; readonly result: Promise<TopicCalibrationResult> } | undefined;
  const requestPrefix = (requestId: string) => `ws1-calibration:${contentHashOf([policy.scope, policy.poolId, requestId])}`;

  function poolFailure(value: { readonly status: "disabled" | "stale" | "rejected"; readonly reason?: string }): TopicCalibrationResult {
    if (value.status === "disabled") return summary("disabled", 0, "topic_calibration_disabled");
    if (value.status === "stale") return summary("waiting", 0, "topic_calibration_stale");
    if (value.reason === "topic_pool_unconfirmed" || value.reason === "topic_pool_suspended") {
      return summary("unknown", 0, value.reason);
    }
    return summary("waiting", 0, value.reason ?? "topic_calibration_not_issued");
  }

  async function lookup(requestId: string) {
    const previous = await pool.lookupRequest(requestId);
    if (previous.status !== "rejected" || previous.reason !== "topic_pool_not_open") return previous;
    const opened = await pool.open();
    return opened.status === "open" ? pool.lookupRequest(requestId) : opened;
  }

  async function append(id: string, kind: "opportunity" | "feedback", body: unknown, signal: AbortSignal, prefix?: RewardV2BoardSnapshot) {
    if (signal.aborted) return { status: "cancelled" as const };
    const writer = createRewardV2BoardPort(options.boardRoot, () => enabled() && !signal.aborted);
    const current = prefix ?? await writer.read();
    if (signal.aborted) return { status: "cancelled" as const };
    return writer.append(current.revision, { id, scope: policy.scope, algorithmVersion: ALGORITHM,
      kind, payloadJson: canonicalJson(body) });
  }

  function verifyClaim(prefix: RewardV2BoardSnapshot, grant: IssuedTopicAllocation, expected: TopicCalibrationExpectation, offset: number): void {
    const fact = prefix.facts.find(row => row.id === expected.claimId);
    const claim = fact === undefined ? undefined : readPoolClaim(JSON.parse(fact.payloadJson));
    const claimId = `${poolKey(policy)}:claim:${contentHashOf([grant.allocationId, expected.domain, expected.spendId])}`;
    if (fact === undefined || fact.scope !== policy.scope || fact.algorithmVersion !== policy.algorithmVersion || fact.kind !== "learning_decision"
      || expected.claimId !== claimId || claim === undefined || claim.allocationId !== grant.allocationId
      || claim.domain !== expected.domain || claim.valuationId !== expected.valuationId || claim.spendId !== expected.spendId
      || claim.units !== expected.units || claim.offset !== offset) throw new Error("topic_calibration_claim_unconfirmed");
  }

  async function observe(protocol: BoundProtocol, expected: TopicCalibrationExpectation, signal: AbortSignal,
    markDispatched: () => void): Promise<TopicCalibrationReceipt> {
    return boundedOperation(signal, protocol.timeoutMs, async bounded => {
      if (bounded.aborted || !enabled()) throw new Error("topic_calibration_stopped");

      markDispatched();
      const ref = await protocol.run(expected, bounded);

      // A late run completion cannot begin a reader or commit another result.
      if (bounded.aborted || signal.aborted || !enabled() || !identity(ref)) throw new Error("topic_calibration_stopped");

      const json = await protocol.readObservation(ref, expected, bounded);

      if (bounded.aborted || signal.aborted || !enabled()) throw new Error("topic_calibration_stopped");

      const receipt = readTopicCalibrationReceipt(json, ref, expected);
      if (receipt === undefined) throw new Error("topic_calibration_receipt_unconfirmed");

      return Object.freeze(receipt);
    }, "topic_calibration_stopped");
  }

  async function run(request: TopicCalibrationRequest, signal: AbortSignal): Promise<TopicCalibrationResult> {
    let processed = 0;
    try {
      if (!enabled()) return summary("disabled", 0, "topic_calibration_disabled");

      if (!identity(request.requestId) || !LEARNING_DOMAINS.includes(request.domain) || !sequence(request.quota)
        || request.quota > Math.min(6, policy.totalQuota)) return summary("rejected", 0, "topic_calibration_request_invalid");

      if (signal.aborted) return summary("cancelled", 0, "topic_calibration_cancelled_before_admission");

      const previous = await lookup(request.requestId);
      if (previous.status === "previous") return summary("previous", 0, "topic_request_previously_issued");

      if (previous.status !== "available") return poolFailure(previous);

      // Even malformed/orphan execution facts burn this identity; missing pool history cannot authorize replay.
      const prefix = requestPrefix(request.requestId), existing = await board.read();
      if (existing.facts.some(fact => fact.id.startsWith(prefix + ":"))) return summary("unknown", 0, "topic_calibration_history_unconfirmed");

      if (signal.aborted || !enabled()) return summary(signal.aborted ? "cancelled" : "disabled", 0, "topic_calibration_not_admitted");

      if (request.quota === 0 || previous.remaining === 0) return summary("waiting", 0, "topic_calibration_insufficient_quota");

      let prepared: TopicCalibrationProtocol | undefined;

      try { prepared = await options.prepare(Object.freeze({ domain: request.domain, signal })); }
      catch { return summary("waiting", 0, "topic_calibration_prepare_failed"); }

      if (signal.aborted || !enabled()) return summary(signal.aborted ? "cancelled" : "disabled", 0, "topic_calibration_not_admitted");

      if (prepared === undefined) return summary("waiting", 0, "topic_calibration_unbound");

      const protocol = bindProtocol(prepared);
      if (protocol === undefined) return summary("rejected", 0, "topic_calibration_protocol_invalid");

      const quota = Math.floor(Math.min(request.quota, previous.remaining) / protocol.units) * protocol.units;
      if (quota === 0) return summary("waiting", 0, "topic_calibration_insufficient_quota");

      const issued = await pool.issueCalibration({ requestId: request.requestId, domain: request.domain, quota, protocolHash: protocol.protocolHash });
      if (issued.status === "previous") return summary("previous", 0, "topic_request_previously_issued");

      if (issued.status !== "issued") return poolFailure(issued);

      const grant = issued.grant, allocation = grant.allocations.find(row => row.domain === request.domain);
      if (allocation === undefined || grant.allocations.length !== 1 || allocation.quota !== quota || allocation.valuationId !== `calibration:${protocol.protocolHash}`
        || allocation.bidHash !== calibrationBidHash(protocol.protocolHash)) return summary("unknown", 0, "topic_calibration_grant_unconfirmed");

      let remaining = quota;

      for (let index = 0; index < quota / protocol.units; index++) {
        if (signal.aborted || !enabled()) return summary(signal.aborted ? "cancelled" : "disabled", processed,
          "topic_calibration_stopped_before_claim", remaining);

        const spendId = `ws1-calibration-spend:${contentHashOf([policy.scope, policy.poolId, request.requestId, request.domain, protocol.protocolHash, index])}`;
        const claim = await pool.claim(grant, request.domain, allocation.valuationId, protocol.units, spendId);
        if (claim.status !== "claimed" || claim.domain !== request.domain || claim.valuationId !== allocation.valuationId
          || claim.units !== protocol.units || !identity(claim.claimId)) return summary("unknown", processed, "topic_calibration_claim_unconfirmed");

        const expected: TopicCalibrationExpectation = Object.freeze({ purpose: "calibration", protocolHash: protocol.protocolHash,
          scope: policy.scope, domain: request.domain, allocationId: grant.allocationId, valuationId: allocation.valuationId,
          units: protocol.units, spendId, claimId: claim.claimId, checkerVersion: protocol.checkerVersion, executionVersion: protocol.executionVersion });
        const charged = await board.read();

        verifyClaim(charged, grant, expected, quota - remaining);
        remaining -= protocol.units;

        if (signal.aborted || !enabled()) return summary(signal.aborted ? "cancelled" : "disabled", processed,
          "topic_calibration_not_executed_after_claim", remaining);

        const started = await append(`${prefix}:started:${index}`, "opportunity", { schemaVersion: 1,
          type: "ws1_topic_calibration_started", requestId: request.requestId, index, expected, timeoutMs: protocol.timeoutMs }, signal, charged);
        if (started.status === "cancelled") return summary("cancelled", processed, "topic_calibration_not_executed_after_claim", remaining);

        if (started.status !== "written" || started.idempotent) return summary("unknown", processed, "topic_calibration_started_unconfirmed");

        if (signal.aborted || !enabled()) return summary(signal.aborted ? "cancelled" : "disabled", processed,
          "topic_calibration_not_executed_after_started", remaining);

        let dispatched = false, receipt: TopicCalibrationReceipt;

        try { receipt = await observe(protocol, expected, signal, () => { dispatched = true; }); }
        catch {
          if (!dispatched && (signal.aborted || !enabled())) return summary(signal.aborted ? "cancelled" : "disabled", processed,
            "topic_calibration_not_executed_after_started", remaining);
          return summary("unknown", processed, "topic_calibration_execution_unconfirmed");
        }

        if (signal.aborted || !enabled()) return summary("unknown", processed, "topic_calibration_observation_not_committed");

        const saved = await append(`${prefix}:result:${index}`, "feedback", { schemaVersion: 1,
          type: "ws1_topic_calibration_result", requestId: request.requestId, index, expected, receipt }, signal);
        if (saved.status !== "written") return summary("unknown", processed, "topic_calibration_result_unconfirmed");

        processed += 1;
      }

      return summary("completed", processed, "topic_calibration_recorded", remaining);
    } catch { return summary("unknown", processed, "topic_calibration_unconfirmed"); }
  }

  return Object.freeze({
    invoke(request: TopicCalibrationRequest, signal: AbortSignal = new AbortController().signal): Promise<TopicCalibrationResult> {
      const accepted = Object.freeze({ requestId: request.requestId, domain: request.domain, quota: request.quota });
      const key = canonicalJson(accepted);

      if (active !== undefined) return active.key === key ? active.result
        : Promise.resolve(summary("waiting", 0, "topic_calibration_busy"));

      const outcome = run(accepted, signal);
      active = { key, result: outcome };
      const clear = () => { if (active?.result === outcome) active = undefined; };

      void outcome.then(clear, clear);
      return outcome;
    },
  });
}
