import type { LearningDomain } from "../../learning/control/contracts.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import type { RewardV2Fact } from "../../learning/reward/v2-facts.js";
import { fields, identity, sequence } from "../../validation/json-shape.js";
import { readCalibrationReservation } from "./calibration-allocation.js";
import { readTopicCalibrationReceipt, type TopicCalibrationExpectation } from "./execution-contract.js";
import { decodePoolLedger, poolKey, readPoolClaim, validPoolPolicy, type TopicPoolPolicy } from "./pool-ledger.js";

export type TopicCalibrationProgress = { readonly status: "clear"; readonly completed: number }
  | { readonly status: "unconfirmed" };

type Reservation = { readonly requestId: string; readonly allocationId: string; readonly domain: LearningDomain;
  readonly protocolHash: string; readonly quota: number; readonly sequence: number; readonly prefix: string };

type Started = { readonly fact: RewardV2Fact; readonly expected: TopicCalibrationExpectation };

type Result = { readonly fact: RewardV2Fact; readonly expected: unknown; readonly receipt: unknown };

const CALIBRATION_ALGORITHM = "ws1-topic-calibration-v1";
const UNCONFIRMED: TopicCalibrationProgress = Object.freeze({ status: "unconfirmed" });
const requestPrefix = (policy: TopicPoolPolicy, requestId: string) => `ws1-calibration:${contentHashOf([policy.scope, policy.poolId, requestId])}`;

function boundExpected(value: unknown, reservation: Reservation, policy: TopicPoolPolicy,
  index: number, units: number): TopicCalibrationExpectation | undefined {
  if (!fields(value, ["purpose", "protocolHash", "scope", "domain", "allocationId", "valuationId", "units", "spendId", "claimId", "checkerVersion", "executionVersion"])
    || !identity(value.checkerVersion) || !identity(value.executionVersion)) return undefined;

  const spendId = `ws1-calibration-spend:${contentHashOf([policy.scope, policy.poolId, reservation.requestId, reservation.domain, reservation.protocolHash, index])}`;
  const expected: TopicCalibrationExpectation = { purpose: "calibration", protocolHash: reservation.protocolHash,
    scope: policy.scope, domain: reservation.domain, allocationId: reservation.allocationId,
    valuationId: `calibration:${reservation.protocolHash}`, units, spendId,
    claimId: `${poolKey(policy)}:claim:${contentHashOf([reservation.allocationId, reservation.domain, spendId])}`,
    checkerVersion: value.checkerVersion, executionVersion: value.executionVersion };

  return canonicalJson(value) === canonicalJson(expected) ? expected : undefined;
}

function confirmedPair(started: Started, result: Result, reservation: Reservation, index: number, units: number,
  facts: ReadonlyMap<string, RewardV2Fact | false>, policy: TopicPoolPolicy): boolean {
  const expected = started.expected, claimFact = facts.get(expected.claimId);
  if (claimFact === undefined || claimFact === false || claimFact.scope !== policy.scope
    || claimFact.algorithmVersion !== policy.algorithmVersion || claimFact.kind !== "learning_decision"
    || !(reservation.sequence < claimFact.sequence && claimFact.sequence < started.fact.sequence && started.fact.sequence < result.fact.sequence)
    || canonicalJson(result.expected) !== canonicalJson(expected)) return false;

  const claim = readPoolClaim(JSON.parse(claimFact.payloadJson));
  if (claim === undefined || claim.allocationId !== expected.allocationId || claim.domain !== expected.domain
    || claim.valuationId !== expected.valuationId || claim.spendId !== expected.spendId || claim.units !== units || claim.offset !== index * units) return false;

  const ref: unknown = typeof result.receipt === "object" && result.receipt !== null ? Reflect.get(result.receipt, "receiptRef") : undefined;

  return identity(ref) && readTopicCalibrationReceipt(canonicalJson(result.receipt), ref, expected) !== undefined;
}

/** Counts completed pairs only when every reservation for this protocol has fully confirmed durable history. No retries or writes. */
export function readTopicCalibrationProgress(input: { readonly facts: readonly RewardV2Fact[]; readonly policy: TopicPoolPolicy;
  readonly protocolHash: string; readonly units: number }): TopicCalibrationProgress {
  const { facts, policy, protocolHash, units } = input;

  if (!validPoolPolicy(policy) || !/^[a-f0-9]{64}$/.test(protocolHash) || !sequence(units) || units < 1 || units > 6) return UNCONFIRMED;

  try {
    // The pool owns all reservation/claim semantics; this helper only joins its confirmed facts to calibration execution.
    decodePoolLedger(policy, facts);
    const key = poolKey(policy), reservations = new Map<string, Reservation>(), byPrefix = new Map<string, Reservation>();
    const byAllocation = new Map<string, Reservation>(), factIndex = new Map<string, RewardV2Fact | false>();

    for (const fact of facts) {
      factIndex.set(fact.id, factIndex.has(fact.id) ? false : fact);

      if (!fact.id.startsWith(`${key}:reserve:`)) continue;

      const raw: unknown = JSON.parse(fact.payloadJson);
      if (typeof raw !== "object" || raw === null || Reflect.get(raw, "type") !== "ws1_topic_calibration") continue;

      const decoded = readCalibrationReservation(policy, raw, fact.sequence), allocation = decoded.plan.allocations[0]!;
      const reservation: Reservation = { requestId: decoded.requestId, allocationId: decoded.plan.allocationId,
        domain: allocation.domain, protocolHash: allocation.valuationId.slice("calibration:".length), quota: decoded.plan.allocated,
        sequence: fact.sequence, prefix: requestPrefix(policy, decoded.requestId) };
      if (reservation.protocolHash === protocolHash && reservation.quota % units !== 0) return UNCONFIRMED;

      reservations.set(reservation.requestId, reservation);
      byPrefix.set(reservation.prefix, reservation);
      byAllocation.set(reservation.allocationId, reservation);
    }

    const started = new Map<string, Started>(), results = new Map<string, Result>();

    for (const fact of facts) {
      const prefix = /^ws1-calibration:[a-f0-9]{64}(?=:)/.exec(fact.id)?.[0], fromId = prefix === undefined ? undefined : byPrefix.get(prefix);
      if (fromId === undefined && (fact.scope !== policy.scope
        || (fact.algorithmVersion !== CALIBRATION_ALGORITHM && !fact.id.startsWith("ws1-calibration:")))) continue;

      const raw: unknown = JSON.parse(fact.payloadJson);
      if (typeof raw !== "object" || raw === null) {
        if (fromId?.protocolHash === protocolHash) return UNCONFIRMED;
        continue;
      }

      const requestId: unknown = Reflect.get(raw, "requestId"), expected: unknown = Reflect.get(raw, "expected");
      const allocationId: unknown = typeof expected === "object" && expected !== null ? Reflect.get(expected, "allocationId") : undefined;
      const expectedProtocol: unknown = typeof expected === "object" && expected !== null ? Reflect.get(expected, "protocolHash") : undefined;
      const reservation = fromId ?? (identity(requestId) ? reservations.get(requestId) : undefined)
        ?? (identity(allocationId) ? byAllocation.get(allocationId) : undefined);
      if (reservation === undefined) {
        const ownPrefix = identity(requestId) && fact.id.startsWith(requestPrefix(policy, requestId) + ":");
        if ((expectedProtocol === protocolHash && (!identity(requestId) || ownPrefix))
          || (ownPrefix && (typeof expectedProtocol !== "string" || !/^[a-f0-9]{64}$/.test(expectedProtocol)))) return UNCONFIRMED;
        continue; // A different pool's request prefix cannot be attributed to this pool.
      }

      if (reservation.protocolHash !== protocolHash) {
        if (expectedProtocol === protocolHash) return UNCONFIRMED;
        continue;
      }

      const index: unknown = Reflect.get(raw, "index"), type: unknown = Reflect.get(raw, "type");
      if (fact.scope !== policy.scope || fact.algorithmVersion !== CALIBRATION_ALGORITHM || !sequence(fact.sequence) || fact.sequence === 0
        || requestId !== reservation.requestId || !sequence(index) || index >= reservation.quota / units
        || Reflect.get(raw, "schemaVersion") !== 1) return UNCONFIRMED;

      const id = `${reservation.prefix}:${index}`;

      if (type === "ws1_topic_calibration_started") {
        if (!fields(raw, ["schemaVersion", "type", "requestId", "index", "expected", "timeoutMs"]) || fact.kind !== "opportunity"
          || fact.id !== `${reservation.prefix}:started:${index}` || started.has(id) || !sequence(raw.timeoutMs) || raw.timeoutMs < 1 || raw.timeoutMs > 60000) return UNCONFIRMED;
        const binding = boundExpected(expected, reservation, policy, index, units);
        if (binding === undefined) return UNCONFIRMED;
        started.set(id, { fact, expected: binding });
      } else if (type === "ws1_topic_calibration_result") {
        if (!fields(raw, ["schemaVersion", "type", "requestId", "index", "expected", "receipt"]) || fact.kind !== "feedback"
          || fact.id !== `${reservation.prefix}:result:${index}` || results.has(id)) return UNCONFIRMED;
        results.set(id, { fact, expected, receipt: raw.receipt });
      } else return UNCONFIRMED;
    }

    let completed = 0, versions: string | undefined;

    for (const reservation of reservations.values()) {
      if (reservation.protocolHash !== protocolHash) continue;
      for (let index = 0; index < reservation.quota / units; index++) {
        const id = `${reservation.prefix}:${index}`, begin = started.get(id), result = results.get(id);
        if (begin === undefined || result === undefined || !confirmedPair(begin, result, reservation, index, units, factIndex, policy)) return UNCONFIRMED;
        const currentVersions = canonicalJson([begin.expected.checkerVersion, begin.expected.executionVersion]);
        if (versions !== undefined && versions !== currentVersions) return UNCONFIRMED;
        versions = currentVersions;
        completed += 1;
      }
    }

    return { status: "clear", completed };
  } catch { return UNCONFIRMED; }
}
