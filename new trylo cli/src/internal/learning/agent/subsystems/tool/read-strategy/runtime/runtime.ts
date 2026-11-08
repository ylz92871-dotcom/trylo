import type { ReadRoutingPort } from "../../../../../../ports/read-routing.js";
import { contentHashOf } from "../../../../../control/hash.js";
import { rewardRecordsOf } from "../../../../../control/reward-records.js";
import { isReadStrategyLearningRequest, selectReadStrategy } from "../domain/index.js";
import { createRewardBoardPort } from "../../../../../../integration/reward/board-port.js";
import { latestReadStrategyAsset, readStrategyBoard, publishReadStrategy, readStrategyPolicyOf } from "./archive.js";
import { readStrategyConditions, readStrategyCheck, readStrategyExecution, readStrategyExposureId, type ReadStrategyConfirmation } from "./sensor.js";
import { identity } from "../../../../../reward/validate.js";

export type ReadStrategyRuntimeOptions = {
  readonly boardRoot: string; readonly scope: string; readonly sessionId: string;
  readonly turnId: string; readonly nowMs?: () => number;
  /** Governs adoption and collection; the host can withdraw eligibility during a turn. */
  readonly enabled: boolean | (() => boolean);
  /** Collection-only policy: existing strategies may still be read when this gate is false. */
  readonly collect?: () => boolean;
};

/** Tool execution feedback and strategy consumption. The existing topic controller is the only study scheduler. */
export function createReadStrategyRuntime(options: ReadStrategyRuntimeOptions) {
  const nowMs = options.nowMs ?? Date.now;
  const enabled = () => typeof options.enabled === "function" ? options.enabled() : options.enabled;
  const mayCollect = () => enabled() && (options.collect?.() ?? true);
  const collecting = (signal?: AbortSignal) => mayCollect() && !signal?.aborted;
  const ledgerFor = (signal?: AbortSignal) => createRewardBoardPort(options.boardRoot, {}, () => collecting(signal));
  let pending: Promise<void> = Promise.resolve();

  function write<T>(operation: () => Promise<T>): Promise<T> {
    const run = pending.then(operation);
    // Release only local sequencing after failure; the caller still receives the original rejection.
    pending = run.then(() => undefined, () => undefined);
    return run;
  }

  const defaultPath = (streaming: boolean): "stream" | "whole" => streaming ? "stream" : "whole";
  const port: ReadRoutingPort = {
    async choose(input) {
      if (!enabled()) return { path: defaultPath(input.conditions.streaming), reason: "routing_disabled" };

      input.signal.throwIfAborted();

      try {
        const state = await readStrategyBoard(options.boardRoot);

        input.signal.throwIfAborted();

        if (!enabled()) return { path: defaultPath(input.conditions.streaming), reason: "routing_disabled" };

        const asset = latestReadStrategyAsset(state, options.scope);
        const policy = readStrategyPolicyOf(asset);
        if (asset !== undefined && policy === undefined) {
          return { path: defaultPath(input.conditions.streaming), reason: "routing_asset_invalid" };
        }

        const selection = selectReadStrategy(policy, { scope: options.scope, conditions: readStrategyConditions(input.conditions) }, rewardRecordsOf(state));

        return { path: selection.path ?? defaultPath(input.conditions.streaming), reason: selection.reason,
          ...(selection.path === undefined || asset === undefined ? {} : { versionId: asset.versionId }) };
      } catch {
        if (input.signal.aborted) input.signal.throwIfAborted();
        return { path: defaultPath(input.conditions.streaming), reason: "routing_unavailable" };
      }
    },
    record: (record, signal) => write(async () => {
      if (!collecting(signal)) return;

      const ledger = ledgerFor(signal);
      const observedAt = nowMs();
      // A successful baseline retry must not erase the failure of the adopted route.
      const attempts = [record];

      if (record.actualPath !== record.decision.path && (record.fallbackReason === "adapted_path_failed" || record.fallbackReason === "whole_file_grew")) {
        const { fallbackReason: _fallbackReason, ...original } = record;
        attempts.push({ ...original, executionId: `adapted-failure:${contentHashOf(record.executionId).slice(0, 32)}`,
          actualPath: record.decision.path, outcome: "failed", bytesRead: 0, latencyMs: 0 });
      }

      for (const attempt of attempts) {
        if (!collecting(signal)) return;

        const facts = readStrategyExecution({ record: attempt, scope: options.scope, sessionId: options.sessionId, turnId: options.turnId, nowMs: observedAt });
        const exposed = await ledger.expose(facts.exposure);
        if (!exposed.ok) throw new Error(`routing_record:${exposed.reason}`);

        if (!collecting(signal)) return;

        const parent = readStrategyExposureId(options.scope, options.sessionId, options.turnId, record.executionId);
        const feedback = await ledger.feedback({ ...facts.feedback,
          evidenceIds: [...facts.feedback.evidenceIds, `tool-read:parent:${parent}`] });
        if (!feedback.ok) throw new Error(`routing_record:${feedback.reason}`);
      }
    }),
  };

  return {
    ...port,
    learn: (request: unknown, signal?: AbortSignal) => write(async () => {
      if (!collecting(signal)) return { status: "disabled" as const, reason: signal?.aborted ? "cancelled" : "collection_disabled", consumed: { observations: 0 } };
      if (!isReadStrategyLearningRequest(request) || request.scope !== options.scope || request.budget.maxObservations > 4096) return { status: "disabled" as const, reason: "invalid_request", consumed: { observations: 0 } };
      if (request.budget.maxObservations === 0) return { status: "budget_exhausted" as const, reason: "zero_allowance", consumed: { observations: 0 } };
      return publishReadStrategy(options.boardRoot, request, () => collecting(signal));
    }),
    confirm: (input: ReadStrategyConfirmation, signal?: AbortSignal) => write(async () => {
      if (!collecting(signal)) return { ok: false as const, reason: signal?.aborted ? "cancelled" : "collection_disabled" };

      const ledger = ledgerFor(signal);

      if (!identity(input.executionId) || !identity(input.feedbackId) || !identity(input.proofRef)
        || typeof input.passed !== "boolean" || (input.origin !== undefined && input.origin !== "user" && input.origin !== "environment")) {
        return { ok: false as const, reason: "invalid_feedback" };
      }

      const read = await ledger.read();

      if (!collecting(signal)) return { ok: false as const, reason: "collection_disabled" };

      if (!read.ok) return read;

      const id = readStrategyExposureId(options.scope, options.sessionId, options.turnId, input.executionId);
      const existing = read.records.feedbacks.find(item => item.id === input.feedbackId);
      if (existing !== undefined) return existing.exposureId === id && existing.origin === (input.origin ?? "environment") && existing.evidenceIds.includes(input.proofRef)
        && existing.evidenceIds.includes(`tool-read:${input.passed ? "verified" : "failed"}:${input.executionId}`)
        ? { ok: true as const, duplicate: true } : { ok: false as const, reason: "reward_conflict" };

      try {
        return await ledger.feedback(readStrategyCheck(read.records, input, id, nowMs()));
      } catch (error) {
        return { ok: false as const, reason: error instanceof Error ? error.message : "routing_feedback_unavailable" };
      }
    }),
  };
}
