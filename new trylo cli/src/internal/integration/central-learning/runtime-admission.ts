import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import type { CentralCompletedOperation, CentralDeliberationPort, CentralLearningConfiguration, CentralLearningRuntimeState } from "../../learning/central/runtime/contracts.js";
import { CENTRAL_RESOURCE_WAIT_PREFIX } from "../../learning/central/runtime/resource-waits.js";
import { centralDeliberationReservation } from "./deliberation-prompt.js";
import type { CentralRuntimeMaterial } from "../../learning/central/runtime/contracts.js";
import { fields, identity } from "../../validation/json-shape.js";
import { isCentralLearningResources } from "../../learning/control/central-learning-resources.js";
import { isCentralActionCorrectionOperation } from "./runtime-action-correction-identity.js";
import { isCentralDeliberationInputCapacity, type CentralDeliberationInputCapacityReason } from "./deliberation-contract.js";

const ADMISSION_PREFIX = "central-semantic-admission:";

type AdmissionRefusal = "learning_budget_stale" | "central_deliberation_cancelled" | CentralDeliberationInputCapacityReason;

/** Eligibility only. Cancellation has no historical delivery proof of its own;
 * the original receipt, in-flight and root accounting inspection must follow. */
function admissionRefusal(block: CentralRuntimeMaterial, operationId: string): AdmissionRefusal | undefined {
  const body: unknown = JSON.parse(block.text);
  if (fields(body, ["interpretation", "operationId", "configurationRef", "limits", "available", "failureClass", "reason"])
    && (body.reason === "central_deliberation_cancelled" && body.failureClass === "cancelled"
      || isCentralDeliberationInputCapacity(body.reason) && (body.failureClass === "resources" || body.failureClass === "contract"))
    && body.operationId === operationId && identity(body.configurationRef)
    && body.interpretation === "explicit_failure_requires_actual_condition_change_not_extra_paid_deliberation"
    && isCentralLearningResources(body.limits) && isCentralLearningResources(body.available)
    && block.kind === "feedback" && block.ref === `${CENTRAL_RESOURCE_WAIT_PREFIX}${contentHashOf(operationId)}`
    && canonicalJson(block.sourceRefs) === canonicalJson([operationId])) return body.reason;

  if (typeof body === "object" && body !== null && "reason" in body && body.reason === "learning_budget_stale"
    && "operationId" in body && body.operationId === operationId) return body.reason;

  return undefined;
}

export const semanticAdmissionRef = (operationId: string) => `${ADMISSION_PREFIX}${contentHashOf(operationId)}`;

export function semanticAdmissionMaterial(operationId: string, priorOperationId: string, blockRef: string): CentralRuntimeMaterial {
  const body = { type: "central_semantic_admission", operationId, priorOperationId, blockRef };
  return { ref: semanticAdmissionRef(operationId), kind: "work_result", text: canonicalJson(body),
    sourceRefs: [...new Set([operationId, priorOperationId, blockRef])] };
}

/** Original issued metadata survives a crash between the immutable semantic
 * receipt and agenda application. It grants no dispatch or funding capability. */
export function admissionRetirementFor(state: CentralLearningRuntimeState, operationId: string): readonly string[] {
  return state.materials.filter(row => row.ref.startsWith(ADMISSION_PREFIX)).flatMap(row => {
    const body: unknown = JSON.parse(row.text);
    if (!fields(body, ["type", "operationId", "priorOperationId", "blockRef"]) || body.type !== "central_semantic_admission"
      || typeof body.operationId !== "string" || typeof body.priorOperationId !== "string" || typeof body.blockRef !== "string"
      || row.ref !== semanticAdmissionRef(body.operationId)
      || canonicalJson(row.sourceRefs) !== canonicalJson([...new Set([body.operationId, body.priorOperationId, body.blockRef])])) throw new Error("central_semantic_admission_corrupt");

    if (body.operationId !== operationId) return [];

    const block = state.materials.find(item => item.ref === body.blockRef);
    if (block === undefined) return [];

    const refusal = admissionRefusal(block, body.priorOperationId);
    if (refusal === undefined || refusal !== "learning_budget_stale" && body.operationId !== body.priorOperationId) {
      throw new Error("central_semantic_admission_binding");
    }

    return [row.ref, body.blockRef];
  });
}

/** Exact CAS refusals and cancelled, unfinished thoughts may request a fresh
 * original admission proof. Neither record itself proves that sending is safe. */
export function unadmittedSemanticAttempt(state: CentralLearningRuntimeState): {
  readonly completed: CentralCompletedOperation; readonly blockRef: string; readonly reason: AdmissionRefusal;
} | undefined {
  const completed = state.completed.filter(row => row.operation.kind === "think").at(-1);
  if (completed === undefined || completed.outcome === "returned") return undefined;

  const blockRef = `${CENTRAL_RESOURCE_WAIT_PREFIX}${contentHashOf(completed.operation.operationId)}`;
  const block = state.materials.find(row => row.ref === blockRef);
  if (block === undefined) return undefined;

  const reason = admissionRefusal(block, completed.operation.operationId);
  if (reason === undefined || reason === "central_deliberation_cancelled" && (completed.outcome !== "unknown"
    || completed.resultRefs.length !== 0 || isCentralActionCorrectionOperation(state.scope, completed.operation))) return undefined;

  if (isCentralDeliberationInputCapacity(reason) && (completed.outcome !== "failed" || completed.resultRefs.length !== 0)) return undefined;

  // A later unknown write or genuine refusal cannot inherit the old CAS proof.
  const later = [...state.materials].reverse().find(row => {
    if (!row.ref.startsWith(CENTRAL_RESOURCE_WAIT_PREFIX)) return false;
    const value: unknown = JSON.parse(row.text);
    return typeof value === "object" && value !== null && "operationId" in value
      && value.operationId === completed.operation.operationId;
  });
  if (later?.ref !== block.ref) return undefined;

  const purpose = state.intents.find(row => row.intentId === completed.intentId);
  if (completed.intentId !== "central:agenda" && (purpose?.continuation.kind !== "waiting"
    || !purpose.continuation.wait.sourceRefs.includes(completed.operation.operationId))) return undefined;

  if (state.intents.length > 0 && state.intents.every(row => row.continuation.kind === "ended")) return undefined;

  return { completed, blockRef, reason };
}

export function confirmsOriginalAdmission(found: Awaited<ReturnType<NonNullable<CentralDeliberationPort["inspect"]>>>,
  configuration: CentralLearningConfiguration, scope: string, operationId: string,
  reason: AdmissionRefusal = "learning_budget_stale"): boolean {
  if (found.status !== "not_sent" || found.admission === undefined || configuration.rootRef === undefined) return false;

  const proof = found.admission;

  return proof.scope === scope && proof.operationId === operationId && proof.ownerId.length > 0
    // The normal central host binds its funding owner to this original root.
    // Historical CAS compatibility keeps its already-issued capability rules.
    && (reason === "learning_budget_stale" || proof.ownerId === configuration.rootRef.budgetId)
    && Number.isSafeInteger(proof.boardSequence) && proof.boardSequence >= configuration.rootRef.openedSequence
    && canonicalJson(proof.rootRef) === canonicalJson(configuration.rootRef)
    && proof.reservationId === centralDeliberationReservation({ scope, budgetId: configuration.rootRef.budgetId, operationId })
    && found.sourceRefs.includes(proof.reservationId);
}
