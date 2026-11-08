import type { CentralCompletedOperation, CentralLearningOperation, CentralLearningRuntimeState, CentralRuntimeMaterial } from "../../learning/central/runtime/contracts.js";
import { centralOperationSignature, type CentralRuntimeHistory } from "../../learning/central/runtime/records.js";
import { CENTRAL_RESOURCE_WAIT_PREFIX } from "../../learning/central/runtime/resource-waits.js";
import { isCentralRuntimeMaterial } from "../../learning/central/runtime/validation.js";
import type { CentralBudgetProjection } from "../../learning/control/central-budget-contract.js";
import { isCentralLearningResources } from "../../learning/control/central-learning-resources.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { fields, identity } from "../../validation/json-shape.js";
import { isCentralChangeReferenceRejection, type CentralChangeReferenceRejection } from "./change-reference-contract.js";
import { isCentralDeliberationOutputDiagnostics } from "./deliberation-output-diagnostics.js";
import { centralDeliberationReservation } from "./deliberation-prompt.js";
import { isActionableCentralChangeStructureRejection, isCentralChangeStructureRejection,
  type CentralChangeStructureRejection } from "./change-structure-rejection.js";
import { CENTRAL_DERIVED_INTENT_CITATION_REJECTION_REASON, isCentralCitationRejection,
  type CentralCitationRejection } from "../../learning/central/runtime/citation-rejection.js";
import { CENTRAL_OUTPUT_CAPACITY_INCREASE_PREFIX } from "./runtime-output-capacity-increase-identity.js";

export const CENTRAL_ACTION_CORRECTION_PREFIX = "central-action-correction:";

export interface CentralActionRejection {
  readonly completed: CentralCompletedOperation;
  readonly operation: Extract<CentralLearningOperation, { readonly kind: "think" }>;
  readonly rejection: CentralRuntimeMaterial;
  readonly rejectionRef: string;
  readonly rejectionFactRef: string;
  readonly reservationId: string;
  readonly reason: "central_learning_change_handle_unbound" | "central_learning_change_invalid"
    | typeof CENTRAL_DERIVED_INTENT_CITATION_REJECTION_REASON;
  readonly semanticRejection?: CentralChangeReferenceRejection;
  readonly structureRejection?: CentralChangeStructureRejection;
  readonly citationRejection?: CentralCitationRejection;
}

export interface CentralActionRejectionInput {
  readonly state: CentralLearningRuntimeState;
  readonly history: CentralRuntimeHistory;
  readonly budget: CentralBudgetProjection;
  readonly lookupMaterial: (ref: string, factRef: string) => Promise<CentralRuntimeMaterial | undefined>;
  /** Keep caller-owned correction eligibility separate from durable rejection proof.
   * Declining a candidate continues the existing newest-first scan. */
  readonly canCorrect?: (rejection: CentralActionRejection) => boolean;
}

function blockAddress(ref: string, base: string): boolean {
  return ref === base || ref.startsWith(`${base}:`) && /^[a-f0-9]{64}$/.test(ref.slice(base.length + 1));
}

function readRejection(material: CentralRuntimeMaterial, operationId: string, reservationId: string):
  Pick<CentralActionRejection, "reason" | "semanticRejection" | "structureRejection" | "citationRejection"> | undefined {
  const base = `${CENTRAL_RESOURCE_WAIT_PREFIX}${contentHashOf(operationId)}`;
  if (!isCentralRuntimeMaterial(material) || material.kind !== "feedback"
    || material.ref !== base && material.ref !== `${base}:${contentHashOf(material.text)}`
    || material.sourceRefs.length !== 1 || material.sourceRefs[0] !== operationId) return undefined;

  let body: unknown;

  try { body = JSON.parse(material.text); } catch { return undefined; }

  const optional = typeof body === "object" && body !== null ? ["outputDiagnostics", "reservationId", "generationRef",
    "priorWaitRef", "providerConnectionRef", "semanticRejection", "structureRejection", "citationRejection"].filter(key => Object.hasOwn(body, key)) : [];
  if (!fields(body, ["interpretation", "operationId", "configurationRef", "limits", "available", "failureClass", "reason", ...optional])
    || material.text !== canonicalJson(body)
    || body.interpretation !== "explicit_failure_requires_actual_condition_change_not_extra_paid_deliberation"
    || body.operationId !== operationId || !identity(body.configurationRef) || body.failureClass !== "contract"
    || !isCentralLearningResources(body.limits) || !isCentralLearningResources(body.available)
    || Object.hasOwn(body, "reservationId") && body.reservationId !== reservationId
    || Object.hasOwn(body, "outputDiagnostics") && (!isCentralDeliberationOutputDiagnostics(body.outputDiagnostics)
      || body.reservationId !== reservationId)
    || Object.hasOwn(body, "generationRef") && !identity(body.generationRef)
    || Object.hasOwn(body, "providerConnectionRef") && !identity(body.providerConnectionRef)
    || Object.hasOwn(body, "priorWaitRef") && (typeof body.priorWaitRef !== "string" || !blockAddress(body.priorWaitRef, base))) return undefined;

  const semanticRejection = body.semanticRejection;
  if (Object.hasOwn(body, "semanticRejection") && !isCentralChangeReferenceRejection(semanticRejection)) return undefined;

  const structureRejection = body.structureRejection;
  if (Object.hasOwn(body, "structureRejection") && (!isCentralChangeStructureRejection(structureRejection)
    || body.reason !== "central_learning_change_invalid" || body.reservationId !== reservationId
    || Object.hasOwn(body, "semanticRejection"))) return undefined;

  const citationRejection = body.citationRejection;
  if (Object.hasOwn(body, "citationRejection") && (!isCentralCitationRejection(citationRejection)
    || body.reason !== CENTRAL_DERIVED_INTENT_CITATION_REJECTION_REASON || body.reservationId !== reservationId
    || Object.hasOwn(body, "semanticRejection") || Object.hasOwn(body, "structureRejection"))) return undefined;

  if (body.reason === CENTRAL_DERIVED_INTENT_CITATION_REJECTION_REASON) {
    if (Object.hasOwn(body, "semanticRejection") || Object.hasOwn(body, "structureRejection")) return undefined;
    return { reason: body.reason, ...(isCentralCitationRejection(citationRejection) ? { citationRejection } : {}) };
  }

  if (body.reason === "central_learning_change_invalid" && isActionableCentralChangeStructureRejection(structureRejection)) {
    return { reason: body.reason, structureRejection };
  }

  if (body.reason === "central_learning_change_handle_unbound") return { reason: body.reason,
    ...(isCentralChangeReferenceRejection(semanticRejection) ? { semanticRejection } : {}) };

  if (body.reason === "central_learning_change_invalid" && isCentralChangeReferenceRejection(semanticRejection)
    && (semanticRejection.cause === "checkpoint_missing" || semanticRejection.cause === "checkpoint_mismatch")) {
    return { reason: body.reason, semanticRejection };
  }

  return undefined;
}

/** Select an original compiler refusal, never a correction of a correction or
 * a reconstructed model claim. Funds, output bodies and source acknowledgements
 * remain with their original owners; missing legacy error values stay absent. */
export async function readCentralActionRejection(input: CentralActionRejectionInput): Promise<CentralActionRejection | undefined> {
  const { state, history, budget } = input;

  if (budget.budget.scope !== state.scope) return undefined;

  for (const completed of [...state.completed].reverse()) {
    const operation = completed.operation;
    if (completed.outcome !== "failed" || operation.kind !== "think" || operation.operationId.startsWith(CENTRAL_ACTION_CORRECTION_PREFIX)
      || operation.operationId.startsWith(CENTRAL_OUTPUT_CAPACITY_INCREASE_PREFIX)) continue;

    if (!history.operations.some(row => row.operationId === operation.operationId && row.intentId === completed.intentId
      && row.signature === centralOperationSignature(operation))) continue;

    const reservationId = centralDeliberationReservation({ scope: state.scope, budgetId: budget.budget.budgetId, operationId: operation.operationId });
    const accounting = budget.budget.accounting?.find(row => row.reservationId === reservationId);
    if (accounting?.owner.kind !== "central_deliberation" || accounting.owner.ownerId !== budget.budget.budgetId
      || accounting.state !== "settled" || accounting.usage.kind !== "reported") continue;

    const base = `${CENTRAL_RESOURCE_WAIT_PREFIX}${contentHashOf(operation.operationId)}`;
    const locator = [...history.materials].reverse().find(row => blockAddress(row.ref, base));
    if (locator === undefined) continue;

    const rejection = state.materials.find(row => row.ref === locator.ref) ?? await input.lookupMaterial(locator.ref, locator.factRef);
    if (rejection === undefined || rejection.ref !== locator.ref) continue;

    const evidence = readRejection(rejection, operation.operationId, reservationId);
    if (evidence === undefined) continue;

    const candidate: CentralActionRejection = { completed, operation, rejection, rejectionRef: rejection.ref,
      rejectionFactRef: locator.factRef, reservationId, ...evidence };
    if (input.canCorrect?.(candidate) === false) continue;

    return candidate;
  }

  return undefined;
}
