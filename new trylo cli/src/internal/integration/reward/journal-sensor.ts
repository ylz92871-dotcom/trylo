import type { Envelope } from "../../protocol/envelope.js";
import type { RewardExposureDraft, RewardFeedback, RewardMetric, RewardTarget } from "../../learning/reward/contracts.js";
import { contentHashOf } from "../../learning/control/hash.js";
import { decodeToolMeasurement, isToolReportClose, isToolReportRefusal } from "./tool-report-classification.js";

/** One sensor implementation. The core knows neither tools nor the execution envelope vocabulary. */
export const TOOL_EXECUTION_METRIC: RewardMetric = {
  id: "execution.tool_result", version: "1", unit: "status", minimum: -1, maximum: 1, preference: "higher",
};

export type RewardSensorInput =
  | { readonly kind: "exposure"; readonly exposure: RewardExposureDraft }
  | { readonly kind: "feedback"; readonly feedback: RewardFeedback };

export type RewardSensorPort = { readonly capture: (event: Envelope) => readonly RewardSensorInput[] };

export function createToolRewardSensor(context: { readonly scope: string; readonly environment: string },
  priorFeedbackCount?: number): RewardSensorPort {
  const pending = new Map<string, RewardExposureDraft>();
  const refused = new Set<string>();

  return { capture: event => {
    if (event.sessionId === undefined || event.turnId === undefined || event.attemptId === undefined) return [];

    const callId = event.payload.toolCallId;

    if (event.kind === "terminal") {
      const feedbacks: RewardSensorInput[] = [];

      for (const [key, exposure] of pending) {
        if (exposure.source.sessionId !== event.sessionId || exposure.source.turnId !== event.turnId) continue;
        feedbacks.push({ kind: "feedback", feedback: toolFeedback(exposure, event,
          refused.has(key) ? "denied" : event.payload.reason === "cancelled" ? "cancelled" : "unknown") });
        pending.delete(key);
        refused.delete(key);
      }

      return feedbacks;
    }

    if (typeof callId !== "string") return [];

    const key = JSON.stringify([event.sessionId, event.turnId, event.attemptId, callId]);
    if (event.kind === "tool_use" && typeof event.payload.name === "string" && !pending.has(key)) {
      if (pending.size >= 128) throw new Error("reward_sensor_capacity");

      const target: RewardTarget = { kind: "tool", id: event.payload.name, version: context.environment };
      const exposure: RewardExposureDraft = { schemaVersion: 1, id: `reward-use:${contentHashOf([key, event.eventId])}`,
        source: { sessionId: event.sessionId, turnId: event.turnId, attemptId: event.attemptId, eventId: event.eventId },
        context: { ...context, taskFamily: "tool_execution", metric: TOOL_EXECUTION_METRIC },
        targets: [target], occurredAt: Date.parse(event.timestamp),
        ...(priorFeedbackCount === undefined ? {} : { priorFeedbackCount }) };

      pending.set(key, exposure);

      return [{ kind: "exposure", exposure }];
    }

    const exposure = pending.get(key);
    if (exposure !== undefined && isToolReportRefusal(event.kind, event.payload)) refused.add(key);

    if (exposure === undefined || !isToolReportClose(event.kind, event.payload)) return [];

    pending.delete(key);
    const status = refused.has(key) ? "denied" : String(event.payload.status);

    refused.delete(key);

    return [{ kind: "feedback", feedback: toolFeedback(exposure, event, status) }];
  } };
}

function toolFeedback(exposure: RewardExposureDraft, event: Envelope, status: string): RewardFeedback {
  const outcome = decodeToolMeasurement(status, event.payload.code);
  return { schemaVersion: 1, id: `reward-result:${contentHashOf([event.eventId, exposure.id])}`, exposureId: exposure.id,
    source: { ...exposure.source, eventId: `reward-event:${contentHashOf([event.eventId, exposure.id])}` },
    origin: "environment", evidenceIds: [event.eventId], observedAt: Date.parse(event.timestamp),
    outcome,
    // A nonzero diagnostic command may be exactly what the user requested. Status alone cannot blame the tool.
    attribution: outcome.kind === "measured" && outcome.value === -1 ? { kind: "unresolved" } :
      { kind: "linked", shares: [{ target: exposure.targets[0]!, share: 1 }] } };
}
