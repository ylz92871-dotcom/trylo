import type { ReadRoutingConditions, ReadRoutingRecord } from "../../../../../../ports/read-routing.js";
import type { RewardExposureDraft, RewardFeedback, RewardOrigin, RewardRecords } from "../../../../../reward/contracts.js";
import { READ_STRATEGY_COST_METRIC, READ_STRATEGY_DECISION_POINT, readStrategyEnvironment, readStrategyCost, type ReadStrategyConditions } from "../domain/index.js";
import { contentHashOf } from "../../../../../control/hash.js";

export function readStrategyConditions(input: ReadRoutingConditions): ReadStrategyConditions {
  if (!Number.isSafeInteger(input.fileBytes) || input.fileBytes < 0) throw new Error("routing_conditions_unavailable");
  return { schemaVersion: 1, fileSize: input.fileBytes <= 262144 ? "small" : "large", range: input.range, streaming: input.streaming };
}

export function readStrategyExposureId(scope: string, sessionId: string, turnId: string, executionId: string): string {
  return `tool-read:${contentHashOf([scope, sessionId, turnId, executionId]).slice(0, 32)}`;
}

export function readStrategyExecution(input: { readonly record: ReadRoutingRecord; readonly scope: string;
  readonly sessionId: string; readonly turnId: string; readonly nowMs: number }): {
    readonly exposure: RewardExposureDraft; readonly feedback: RewardFeedback;
  } {
  const { record, scope, sessionId, turnId, nowMs } = input;

  if (!Number.isFinite(record.bytesRead) || record.bytesRead < 0 || !Number.isFinite(record.latencyMs)
    || record.latencyMs < 0) throw new Error("routing_cost_invalid");

  const id = readStrategyExposureId(scope, sessionId, turnId, record.executionId);
  const source = { sessionId, turnId, attemptId: turnId, eventId: record.executionId };
  const path = { kind: "tool_read_path", id: record.actualPath, version: "1" };
  const exposure: RewardExposureDraft = { schemaVersion: 1, id, source, occurredAt: nowMs,
    context: { scope, taskFamily: READ_STRATEGY_DECISION_POINT, environment: readStrategyEnvironment(readStrategyConditions(record.conditions)), metric: READ_STRATEGY_COST_METRIC },
    targets: [path, ...(record.decision.versionId === undefined ? [] : [
      { kind: "routing_policy", id: READ_STRATEGY_DECISION_POINT, version: record.decision.versionId }]),
      // Preserve requested choice and fallback without storing file names or contents.
      { kind: "routing_choice", id: record.decision.path, version: record.decision.reason },
      ...(record.fallbackReason === undefined ? [] : [{ kind: "routing_fallback", id: record.actualPath, version: record.fallbackReason }])],
  };
  const cost = readStrategyCost(record.outcome === "failed" ? "failed" : "completed", record.bytesRead, record.latencyMs);
  const feedback: RewardFeedback = { schemaVersion: 1, id: `${id}:result`, exposureId: id,
    source: { ...source, eventId: `${record.executionId}:result` }, origin: "environment", observedAt: nowMs,
    evidenceIds: [`tool-read:${record.outcome === "completed" ? "completed" : record.outcome === "failed" ? "failed" : "cancelled"}:${record.executionId}`],
    outcome: record.outcome === "cancelled" ? { kind: "unknown", reason: "cancelled" }
      : { kind: "measured", value: cost, confidence: 1, noiseVariance: 0.01 },
    attribution: { kind: "linked", shares: [{ target: path, share: 1 }] },
  };

  return { exposure, feedback };
}

export type ReadStrategyConfirmation = {
  readonly executionId: string;
  readonly feedbackId: string;
  readonly passed: boolean;
  /** Opaque external task check reference, never an agent self-score. */
  readonly proofRef: string;
  readonly origin?: Extract<RewardOrigin, "environment" | "user">;
};

export function readStrategyCheck(records: RewardRecords, input: ReadStrategyConfirmation, exposureId: string, nowMs: number): RewardFeedback {
  const exposure = records.exposures.find(item => item.id === exposureId);
  const automatic = records.feedbacks.find(item => item.id === `${exposureId}:result`);
  if (exposure === undefined || automatic === undefined) throw new Error("routing_execution_missing");

  if (input.passed && !automatic.evidenceIds.includes(`tool-read:completed:${input.executionId}`)) throw new Error("routing_result_unavailable");

  const origin = input.origin ?? "environment";
  const previous = records.feedbacks.filter(item => item.exposureId === exposureId && item.origin === origin).at(-1);
  const target = exposure.targets.find(item => item.kind === "tool_read_path");
  if (target === undefined) throw new Error("routing_path_missing");

  return { schemaVersion: 1, id: input.feedbackId, exposureId,
    source: { ...exposure.source, eventId: input.feedbackId }, origin, observedAt: Math.max(nowMs, exposure.occurredAt),
    evidenceIds: [`tool-read:${input.passed ? "verified" : "failed"}:${input.executionId}`, input.proofRef],
    outcome: { kind: "measured", value: input.passed && automatic.outcome.kind === "measured" ? automatic.outcome.value : READ_STRATEGY_COST_METRIC.maximum,
      confidence: 1, noiseVariance: 0.01 }, attribution: { kind: "linked", shares: [{ target, share: 1 }] },
    ...(previous === undefined ? {} : { supersedes: previous.id }) };
}
