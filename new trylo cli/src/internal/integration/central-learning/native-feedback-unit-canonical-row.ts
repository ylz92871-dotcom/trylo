import type { JsonObject, JsonValue } from "../../protocol/envelope.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { isMethodObservation } from "../../learning/agent/subsystems/method/domain/inference.js";
import { isMethodExecutionTrace } from "../../learning/agent/subsystems/method/domain/execution-trace.js";
import { workflowConditionKey } from "../../learning/agent/subsystems/workflow/domain/family.js";
import { text } from "../../validation/json-shape.js";
import { isJsonData, recordOf } from "../../tooling/contract/json-value.js";
import type { NativeFeedbackUnitPublicView } from "./native-feedback-unit-view.js";

type View = Pick<NativeFeedbackUnitPublicView, "recordKind" | "factRef" | "unitRef" | "revisionRef" | "payload">;

const object = (value: unknown): value is JsonObject => recordOf(value) && isJsonData(value, 32);
const ref = (value: unknown): value is string => text(value, 512) && !/[\u0000-\u001f]/.test(value);
const ids = (value: unknown): value is readonly string[] => Array.isArray(value) && value.length > 0 && value.every(ref);

/** Reproduce the original public row presentation of one fixed native payload.
 * This pure adapter grants no ownership, read acknowledgement or quality claim. */
export function nativeFeedbackUnitCanonicalRow(view: View, owner: string): JsonObject | undefined {
  const body = view.payload;
  if (!object(body)) return undefined;

  if (owner === "method" || owner === "tool") {
    let kind = view.recordKind;

    if (owner === "method") kind = isMethodObservation(body) ? "method_assessment"
      : ref(body.exposureId) && ref(body.proposalId) ? "method_delivery" : typeof body.kind === "string" ? `method_${body.kind}` : kind;
    else if (ref(body.useId)) kind = "tool_invocation";
    else if (ref(body.feedbackId) && ids(body.useIds)) kind = "tool_task_assessment";
    else if (ref(body.revisionId) && body.approved === true && object(body.proposal)
      && body.type === undefined && body.schemaVersion === undefined) kind = "tool_contract_review";
    else if (ref(body.approvalId)) kind = "tool_approval";

    if (kind === "method_execution" && (body.kind !== "execution" || !isMethodExecutionTrace(body.trace))) return undefined;

    return { kind, factRef: view.factRef, revisionRef: view.revisionRef, payloadJson: canonicalJson(body),
      ...(kind === "method_assessment" ? { revision: body.revision ?? null, exposureId: view.unitRef } : {}) };
  }

  if (owner === "workflow" && body.type === "workflow_improvement_feedback" && object(body.feedback)) {
    const { task: _task, ...feedback } = body.feedback;
    return { ...feedback, kind: "workflow_feedback", recordRef: view.factRef,
      processEvidence: feedback.processEvidence ?? { kind: "unverified" } };
  }

  if (owner === "workflow" && body.type === "workflow_improvement_use" && object(body.use) && object(body.use.task)) {
    const task = body.use.task, conditions = task.conditions ?? {};
    if (!object(conditions) || !Object.values(conditions).every(value => typeof value === "string")) return undefined;

    const knownConditions: Record<string, string> = {};

    for (const [key, value] of Object.entries(conditions)) if (typeof value === "string") knownConditions[key] = value;

    return { kind: "workflow_frozen_use", recordRef: view.factRef, useId: body.use.useId ?? null,
      versionId: body.use.versionId ?? null, boundary: body.use.boundary ?? null, sessionId: body.sessionId ?? null,
      afterSequence: body.afterSequence ?? null, taskRef: contentHashOf(task), conditionKey: workflowConditionKey(knownConditions) };
  }

  if (owner === "collaboration" && ids(body.versionIds) && ref(body.receiptId)) {
    const common = { receiptId: body.receiptId, owner: body.owner ?? null, versionIds: body.versionIds,
      relevantVersionIds: body.versionIds.includes(view.unitRef) ? [view.unitRef] : [], recordedAt: body.recordedAt ?? null };

    if (body.phase === "use_feedback") return { kind: "collaboration_use_feedback", ...common,
      usageReceiptId: body.usageReceiptId ?? null, outcome: body.outcome ?? null, summary: body.summary ?? null,
      sourceRefs: body.sourceRefs ?? [], ...(body.assessments === undefined ? {} : { assessments: body.assessments }) };

    if (body.phase === "dispatched" && object(body.boundary)) {
      const boundary: Record<string, JsonValue> = {};
      for (const key of ["executionId", "taskId", "round", "role", "memberId", "teamRunId", "configurationRef", "requestId"]) {
        const value = body.boundary[key];
        if (value !== undefined) boundary[key] = value;
      }
      return { kind: "collaboration_dispatched", ...common, ownerFingerprint: body.ownerFingerprint ?? null, boundary };
    }
  }

  if (owner === "skill") {
    const { sourceRef: _sourceRef, interpretation: _interpretation, ...original } = body;
    return { ...original, sourceRef: view.factRef };
  }

  return undefined;
}
