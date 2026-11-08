import type { CentralDeliberationRequest, CentralLearningIntentDraft, CentralLearningRuntimeState,
  CentralRuntimeMaterial } from "../../learning/central/runtime/contracts.js";
import type { CentralRuntimeHistory } from "../../learning/central/runtime/records.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { fields, identity } from "../../validation/json-shape.js";
import { CentralDeliberationError } from "./deliberation-contract.js";
import { CENTRAL_REFERENCE_SELECTION_CONTRACT_REF, CENTRAL_REFERENCE_SELECTION_CONTRACT_SPEC, createCentralReferenceSelectionCapability,
  isCentralChangeReferenceRejection, readCentralReferenceSelectionCapability, type CentralChangeReferenceRejection } from "./change-reference-contract.js";
import { centralActionCorrectionOperationId, isCentralActionCorrectionOperation } from "./runtime-action-correction-identity.js";
import type { CentralActionRejection } from "./runtime-action-rejection.js";
import { isActionableCentralChangeStructureRejection, type CentralChangeStructureRejection } from "./change-structure-rejection.js";
import { isCentralChangeInputVersion, usesCentralShortReferenceHandles } from "./change-input-contract.js";
import { CENTRAL_DERIVED_INTENT_CITATION_REJECTION_REASON, isCentralCitationRejection,
  type CentralCitationRejection } from "../../learning/central/runtime/citation-rejection.js";

const PREFIX = "central-action-correction-feedback:";
const ROLE = "original_rejected_action_correction_not_business_evidence";
const interpretation = "One reassessment of the original research after a compiler refusal. No prior action took effect. Preserve its charge. "
  + "Use the current host reference-selection contract and actual supplied choices; never replay old handles or invent the missing old value. "
  + "Choose a useful corrected action, a necessary original read, or an accurate wait yourself. This is control feedback, not a new business sample or learning gain.";
const structureInterpretation = "One reassessment of the original research after a concrete field/type refusal. No prior action took effect. Preserve its charge. "
  + "The diagnostic identifies only a known slot and structural constraint, not the rejected value or a semantic repair. "
  + "Use the current supplied action and reference contracts to choose a useful correction, an original read, or an accurate wait yourself. "
  + "Never replay the old operation or invent missing business facts. This is control feedback, not a new business sample or learning gain.";
const citationInterpretation = "One reassessment after a definite derived-purpose citation refusal. No prior action took effect. Preserve its charge. "
  + "A legacy reason alone does not identify whether a body was absent or unread, a quote was empty, missing or nonunique, or a parent link was missing. "
  + "A typed diagnostic identifies only the original output slot and validation cause; it does not reproduce the rejected quote or supply evidence. "
  + "Use the current action/reference contracts and actual delivered bodies to choose a useful corrected create/revise, a necessary original read, or an accurate wait yourself. "
  + "Never replay the original operation, invent the missing old value or treat this feedback as business evidence or learning gain.";

type CorrectionKnowledge = { readonly kind: "legacy_reason_only" }
  | { readonly kind: "typed_reference_rejection"; readonly value: CentralChangeReferenceRejection }
  | { readonly kind: "typed_structure_rejection"; readonly value: CentralChangeStructureRejection }
  | { readonly kind: "typed_citation_rejection"; readonly value: CentralCitationRejection };

function isCorrectionKnowledge(value: unknown, reason: unknown): value is CorrectionKnowledge {
  return fields(value, ["kind"]) && value.kind === "legacy_reason_only"
      && (reason === "central_learning_change_handle_unbound" || reason === CENTRAL_DERIVED_INTENT_CITATION_REJECTION_REASON)
    || fields(value, ["kind", "value"]) && (value.kind === "typed_reference_rejection" && isCentralChangeReferenceRejection(value.value)
        && (reason === "central_learning_change_handle_unbound" || reason === "central_learning_change_invalid"
          && (value.value.cause === "checkpoint_missing" || value.value.cause === "checkpoint_mismatch"))
      || value.kind === "typed_structure_rejection" && reason === "central_learning_change_invalid"
        && isActionableCentralChangeStructureRejection(value.value)
      || value.kind === "typed_citation_rejection" && reason === CENTRAL_DERIVED_INTENT_CITATION_REJECTION_REASON
        && isCentralCitationRejection(value.value));
}

/** The original operation owns one slot even if the capability version changes.
 * Issued, failed, unknown and compacted attempts all retain the same fence. */
export function centralActionCorrection(state: CentralLearningRuntimeState, history: CentralRuntimeHistory,
  budgetId: string, original: CentralActionRejection) {
  if (original.structureRejection !== undefined && (original.reason !== "central_learning_change_invalid"
    || original.semanticRejection !== undefined || original.citationRejection !== undefined
    || !isActionableCentralChangeStructureRejection(original.structureRejection))) return undefined;

  if (original.reason === CENTRAL_DERIVED_INTENT_CITATION_REJECTION_REASON
    && (original.semanticRejection !== undefined || original.structureRejection !== undefined
      || original.citationRejection !== undefined && !isCentralCitationRejection(original.citationRejection))) return undefined;

  if (original.citationRejection !== undefined && original.reason !== CENTRAL_DERIVED_INTENT_CITATION_REJECTION_REASON) return undefined;

  const operationId = centralActionCorrectionOperationId(state.scope, budgetId, original.operation.operationId);
  if (history.operations.some(row => row.operationId === operationId)
    || state.completed.some(row => row.operation.operationId === operationId)) return undefined;

  const intent: CentralLearningIntentDraft | null = state.intents.find(row => row.intentId === original.completed.intentId) ?? null;
  if (original.completed.intentId !== "central:agenda" && (intent === null || intent.continuation.kind === "ended")) return undefined;

  const capability = createCentralReferenceSelectionCapability();
  const knowledge: CorrectionKnowledge = original.structureRejection !== undefined ? { kind: "typed_structure_rejection", value: original.structureRejection }
    : original.citationRejection !== undefined ? { kind: "typed_citation_rejection", value: original.citationRejection }
    : original.semanticRejection === undefined ? { kind: "legacy_reason_only" }
    : { kind: "typed_reference_rejection", value: original.semanticRejection };
  const body = { schemaVersion: 1, role: ROLE, scope: state.scope, budgetId,
    originalOperationId: original.operation.operationId, rejectionRef: original.rejectionRef,
    rejectionFactRef: original.rejectionFactRef, rejectionHash: contentHashOf(original.rejection.text),
    reservationId: original.reservationId, reason: original.reason, knowledge,
    referenceContractRef: CENTRAL_REFERENCE_SELECTION_CONTRACT_REF,
    interpretation: original.reason === CENTRAL_DERIVED_INTENT_CITATION_REJECTION_REASON ? citationInterpretation
      : original.structureRejection === undefined ? interpretation : structureInterpretation };
  const feedback: CentralRuntimeMaterial = { ref: `${PREFIX}${contentHashOf([state.scope, budgetId, body])}`,
    kind: "feedback", text: canonicalJson(body), sourceRefs: [original.operation.operationId, original.rejectionRef,
      original.rejectionFactRef, original.reservationId, CENTRAL_REFERENCE_SELECTION_CONTRACT_REF] };

  return { intent, feedback, capability, materials: [original.rejection, capability, feedback],
    operation: { kind: "think" as const, operationId,
      purpose: "依据原动作的确定拒绝反馈和当前引用选择能力，重新判断原研究目的及有用下一步。",
      expectedChange: "完整保留原失败和费用，使用实际当前选择合同改正动作或准确等待；不伪造旧错误值，不重复原请求。",
      sourceRefs: [...new Set([original.operation.operationId, budgetId, feedback.ref, capability.ref,
        original.rejectionRef, original.rejectionFactRef, ...original.operation.sourceRefs])] } };
}

/** Called on the actual quoted view, not an announced future capability. The
 * full feedback, original refusal and exact current descriptor must survive packing. */
export function assertCentralActionCorrectionDelivery(request: CentralDeliberationRequest, inputVersion: string,
  referenceSelectionContractRef: unknown): { readonly feedbackRef: string; readonly capabilityRef: string; readonly rejectionRef: string } | undefined {
  if (!request.operation.operationId.startsWith("central-action-correction:")) return;

  const fail = (): never => { throw new CentralDeliberationError("central_action_correction_contract_unavailable", "not_sent"); };

  if (!isCentralActionCorrectionOperation(request.scope, request.operation)
    || request.operation.sourceRefs[1] !== request.budgetId
    || request.operation.sourceRefs[3] !== CENTRAL_REFERENCE_SELECTION_CONTRACT_REF
    || referenceSelectionContractRef !== CENTRAL_REFERENCE_SELECTION_CONTRACT_REF) fail();

  const materials = [...request.materials, ...request.organization];
  const capability = materials.find(row => row.ref === CENTRAL_REFERENCE_SELECTION_CONTRACT_REF);
  const descriptor = capability === undefined ? undefined : readCentralReferenceSelectionCapability(capability);
  const referenceInputVersion = isCentralChangeInputVersion(inputVersion) && usesCentralShortReferenceHandles(inputVersion)
    ? CENTRAL_REFERENCE_SELECTION_CONTRACT_SPEC.inputVersion : inputVersion;
  if (descriptor === undefined || descriptor.inputVersion !== referenceInputVersion) return fail();

  const feedback = materials.find(row => row.ref === request.operation.sourceRefs[2]);
  if (feedback === undefined || feedback.kind !== "feedback") return fail();

  let body: unknown;

  try { body = JSON.parse(feedback.text); } catch { return fail(); }

  if (!fields(body, ["schemaVersion", "role", "scope", "budgetId", "originalOperationId", "rejectionRef", "rejectionFactRef",
    "rejectionHash", "reservationId", "reason", "knowledge", "referenceContractRef", "interpretation"])
    || body.schemaVersion !== 1 || body.role !== ROLE || body.scope !== request.scope || body.budgetId !== request.budgetId
    || body.originalOperationId !== request.operation.sourceRefs[0] || body.referenceContractRef !== descriptor.contractRef
    || !identity(body.rejectionRef) || !identity(body.rejectionFactRef)
    || !identity(body.reservationId) || typeof body.rejectionHash !== "string" || !/^[a-f0-9]{64}$/.test(body.rejectionHash)
    || body.reason !== "central_learning_change_handle_unbound" && body.reason !== "central_learning_change_invalid"
      && body.reason !== CENTRAL_DERIVED_INTENT_CITATION_REJECTION_REASON
    || feedback.text !== canonicalJson(body) || feedback.ref !== `${PREFIX}${contentHashOf([request.scope, request.budgetId, body])}`
    || canonicalJson(feedback.sourceRefs) !== canonicalJson([body.originalOperationId, body.rejectionRef,
      body.rejectionFactRef, body.reservationId, body.referenceContractRef])) return fail();

  const knowledge = body.knowledge;
  if (!isCorrectionKnowledge(knowledge, body.reason)) return fail();

  if (body.interpretation !== (body.reason === CENTRAL_DERIVED_INTENT_CITATION_REJECTION_REASON ? citationInterpretation
    : knowledge.kind === "typed_structure_rejection" ? structureInterpretation : interpretation)) return fail();

  const original = materials.find(row => row.ref === body.rejectionRef);
  if (original === undefined || contentHashOf(original.text) !== body.rejectionHash) return fail();

  if (knowledge.kind === "typed_structure_rejection" || knowledge.kind === "typed_citation_rejection"
    || body.reason === CENTRAL_DERIVED_INTENT_CITATION_REJECTION_REASON) {
    let refusal: unknown;

    try { refusal = JSON.parse(original.text); } catch { return fail(); }

    if (typeof refusal !== "object" || refusal === null
      || !("operationId" in refusal) || refusal.operationId !== body.originalOperationId
      || !("reason" in refusal) || refusal.reason !== body.reason
      || Object.hasOwn(refusal, "reservationId") && (!("reservationId" in refusal) || refusal.reservationId !== body.reservationId)) return fail();

    if (knowledge.kind === "typed_structure_rejection" && (!("reservationId" in refusal) || refusal.reservationId !== body.reservationId
      || !("structureRejection" in refusal) || canonicalJson(refusal.structureRejection) !== canonicalJson(knowledge.value))) return fail();

    if (knowledge.kind === "typed_citation_rejection" && (!("reservationId" in refusal) || refusal.reservationId !== body.reservationId
      || !("citationRejection" in refusal) || canonicalJson(refusal.citationRejection) !== canonicalJson(knowledge.value))) return fail();

    if (body.reason === CENTRAL_DERIVED_INTENT_CITATION_REJECTION_REASON && knowledge.kind === "legacy_reason_only"
      && (Object.hasOwn(refusal, "citationRejection") || Object.hasOwn(refusal, "semanticRejection") || Object.hasOwn(refusal, "structureRejection"))) return fail();
  }

  return { feedbackRef: feedback.ref, capabilityRef: descriptor.contractRef, rejectionRef: body.rejectionRef };
}

/** Authentication for packing only. The later quote separately checks the
 * actually rendered version/dictionary; a descriptor alone never enables it. */
export function centralActionCorrectionMandatoryRefs(request: CentralDeliberationRequest,
  materials: readonly CentralRuntimeMaterial[]): ReadonlySet<string> {
  const bindings = assertCentralActionCorrectionDelivery({ ...request, materials, organization: [] },
    CENTRAL_REFERENCE_SELECTION_CONTRACT_SPEC.inputVersion, CENTRAL_REFERENCE_SELECTION_CONTRACT_REF);
  return new Set(bindings === undefined ? [] : [bindings.feedbackRef, bindings.capabilityRef, bindings.rejectionRef]);
}
