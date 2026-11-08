import type { CentralCompletedOperation, CentralDeliberationRequest, CentralLearningConfiguration, CentralLearningIntentDraft, CentralLearningOperation,
  CentralLearningRuntimeState, CentralRuntimeMaterial } from "../../learning/central/runtime/contracts.js";
import type { CentralRuntimeHistory } from "../../learning/central/runtime/records.js";
import type { CentralBudgetProjection } from "../../learning/control/central-budget-contract.js";
import { centralOperationSignature } from "../../learning/central/runtime/records.js";
import { CENTRAL_RESOURCE_WAIT_PREFIX, isLocalResourceWait } from "../../learning/central/runtime/resource-waits.js";
import { isCentralCompletedOperation, isCentralLearningOperation, isCentralRuntimeMaterial } from "../../learning/central/runtime/validation.js";
import { isCentralGenerationLimits } from "../../learning/central/runtime/generation.js";
import { isCentralLearningResources } from "../../learning/control/central-learning-resources.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { fields, identity, sequence } from "../../validation/json-shape.js";
import { isCompleteCentralOutputCapacityRejection } from "./deliberation-output-diagnostics.js";
import { centralDeliberationReservation } from "./deliberation-prompt.js";
import { CENTRAL_OUTPUT_CAPACITY_INCREASE_PREFIX, CENTRAL_OUTPUT_CAPACITY_INCREASE_FEEDBACK_PREFIX,
  centralOutputCapacityIncreaseOperationId, isCentralOutputCapacityIncreaseOperation } from "./runtime-output-capacity-increase-identity.js";

export { isCentralOutputCapacityIncreaseOperation } from "./runtime-output-capacity-increase-identity.js";

export interface CentralOutputCapacityIncreaseAdmission {
  readonly kind: "output_capacity_increase"; readonly originalOperationId: string; readonly waitRef: string; readonly lineageRef: string;
}

type Configuration = Pick<CentralLearningConfiguration, "configurationRef" | "rootRef" | "generationLimits" | "generationRef">;

export interface CentralOutputCapacityIncreaseInput {
  readonly state: CentralLearningRuntimeState; readonly history: CentralRuntimeHistory;
  readonly budget: CentralBudgetProjection; readonly configuration: Configuration; readonly waitRef?: string;
  readonly lookupMaterial: (ref: string, factRef: string) => Promise<CentralRuntimeMaterial | undefined>;
  readonly lookupCompleted: (operationId: string, factRef: string) => Promise<CentralCompletedOperation | undefined>;
}

export interface CentralOutputCapacityIncrease {
  readonly intent: CentralLearningIntentDraft | null;
  readonly operation: Extract<CentralLearningOperation, { readonly kind: "think" }>;
  readonly materials: readonly CentralRuntimeMaterial[];
  readonly admission: CentralOutputCapacityIncreaseAdmission;
}

type ProofHistory = Pick<CentralRuntimeHistory, "operations" | "materials">;

interface Lineage {
  readonly schemaVersion: 1; readonly role: "authenticated_output_capacity_increase";
  readonly scope: string; readonly budgetId: string; readonly originalOperationId: string;
  readonly operationSignature: string; readonly completedFactRef: string; readonly originalCompleted: CentralCompletedOperation;
  readonly waitRef: string; readonly waitFactRef: string; readonly originalBlock: CentralRuntimeMaterial;
  readonly reservationId: string; readonly originalRequestedOutputTokens: number; readonly requestedOutputTokens: number;
}

const LINEAGE_KEYS = ["schemaVersion", "role", "scope", "budgetId", "originalOperationId", "operationSignature", "completedFactRef",
  "originalCompleted", "waitRef", "waitFactRef", "originalBlock", "reservationId", "originalRequestedOutputTokens", "requestedOutputTokens"];
// A serializable lineage is an audit record, not self-issued authority. Only a
// fresh read of its original Board facts grants this in-process admission.
const verifiedLineages = new WeakMap<CentralRuntimeMaterial, string>();
// Checkpoint persistence replaces material objects before packing. The actual
// selected operation remains the same object throughout this one computation.
const verifiedOperations = new WeakMap<CentralLearningOperation, string>();

function readLineage(material: CentralRuntimeMaterial): Lineage | undefined {
  if (!isCentralRuntimeMaterial(material) || material.kind !== "feedback") return undefined;

  let value: unknown;

  try { value = JSON.parse(material.text); } catch { return undefined; }

  if (!fields(value, LINEAGE_KEYS) || value.schemaVersion !== 1 || value.role !== "authenticated_output_capacity_increase"
    || ![value.scope, value.budgetId, value.originalOperationId, value.operationSignature, value.completedFactRef,
      value.waitRef, value.waitFactRef, value.reservationId].every(identity)
    || !isCentralCompletedOperation(value.originalCompleted) || !isCentralRuntimeMaterial(value.originalBlock)
    || !sequence(value.originalRequestedOutputTokens) || !sequence(value.requestedOutputTokens)
    || material.text !== canonicalJson(value)
    || material.ref !== `${CENTRAL_OUTPUT_CAPACITY_INCREASE_FEEDBACK_PREFIX}${contentHashOf(value)}`) return undefined;

  // The guard above validates every field; rebuild instead of trusting a persistence cast.
  return { schemaVersion: 1, role: "authenticated_output_capacity_increase", scope: String(value.scope), budgetId: String(value.budgetId),
    originalOperationId: String(value.originalOperationId), operationSignature: String(value.operationSignature), completedFactRef: String(value.completedFactRef),
    originalCompleted: value.originalCompleted, waitRef: String(value.waitRef), waitFactRef: String(value.waitFactRef), originalBlock: value.originalBlock,
    reservationId: String(value.reservationId), originalRequestedOutputTokens: value.originalRequestedOutputTokens, requestedOutputTokens: value.requestedOutputTokens };
}

function blockAddress(ref: string, operationId: string): boolean {
  const base = `${CENTRAL_RESOURCE_WAIT_PREFIX}${contentHashOf(operationId)}`;
  return ref === base || ref.startsWith(`${base}:`) && /^[a-f0-9]{64}$/.test(ref.slice(base.length + 1));
}

function readOriginalCapacity(material: CentralRuntimeMaterial, operationId: string, reservationId: string): number | undefined {
  const base = `${CENTRAL_RESOURCE_WAIT_PREFIX}${contentHashOf(operationId)}`;
  if (!isCentralRuntimeMaterial(material) || material.kind !== "feedback"
    || material.ref !== base && material.ref !== `${base}:${contentHashOf(material.text)}`
    || material.sourceRefs.length !== 1 || material.sourceRefs[0] !== operationId) return undefined;

  let body: unknown;

  try { body = JSON.parse(material.text); } catch { return undefined; }

  const optional = typeof body === "object" && body !== null
    ? ["generationRef", "priorWaitRef", "providerConnectionRef"].filter(key => Object.hasOwn(body, key)) : [];
  if (!fields(body, ["interpretation", "operationId", "configurationRef", "limits", "available", "failureClass", "reason",
    "reservationId", "outputDiagnostics", ...optional]) || material.text !== canonicalJson(body)
    || body.interpretation !== "explicit_failure_requires_actual_condition_change_not_extra_paid_deliberation"
    || body.operationId !== operationId || !identity(body.configurationRef)
    || !isCentralLearningResources(body.limits) || !isCentralLearningResources(body.available)
    || body.failureClass !== "transport" && body.failureClass !== "resources"
    || body.reason !== "central_deliberation_incomplete" || body.reservationId !== reservationId
    || !isCompleteCentralOutputCapacityRejection(body.outputDiagnostics)
    || Object.hasOwn(body, "generationRef") && !identity(body.generationRef)
    || Object.hasOwn(body, "providerConnectionRef") && !identity(body.providerConnectionRef)
    || Object.hasOwn(body, "priorWaitRef") && (typeof body.priorWaitRef !== "string" || !blockAddress(body.priorWaitRef, operationId))) return undefined;

  return body.outputDiagnostics.requestedOutputTokens ?? undefined;
}

function activeIntent(state: CentralLearningRuntimeState, completed: CentralCompletedOperation): CentralLearningIntentDraft | null | undefined {
  if (completed.intentId === "central:agenda") return null;
  const intent = state.intents.find(row => row.intentId === completed.intentId);
  return intent === undefined || intent.continuation.kind === "ended" ? undefined : intent;
}

function slotUsed(state: CentralLearningRuntimeState, history: ProofHistory, operationId: string): boolean {
  return history.operations.some(row => row.operationId === operationId)
    || [...state.completed, ...state.running].some(row => row.operation.operationId === operationId);
}

function proofValid(state: CentralLearningRuntimeState, history: ProofHistory, budget: CentralBudgetProjection,
  configuration: Configuration, proof: Lineage): boolean {
  const root = configuration.rootRef, original = proof.originalCompleted, operation = original.operation;
  if (root === undefined || budget.budget.scope !== state.scope || proof.scope !== state.scope || proof.budgetId !== budget.budget.budgetId
    || root.scope !== state.scope || root.budgetId !== proof.budgetId || root.openedSequence !== budget.budget.openedSequence
    || root.authorizationRef !== budget.budget.authorizationRef || !identity(configuration.configurationRef)
    || !isCentralGenerationLimits(configuration.generationLimits) || proof.requestedOutputTokens !== configuration.generationLimits.maxOutputTokens
    || original.outcome !== "failed" || operation.kind !== "think" || operation.operationId !== proof.originalOperationId
    || operation.operationId.startsWith(CENTRAL_OUTPUT_CAPACITY_INCREASE_PREFIX)
    || proof.operationSignature !== centralOperationSignature(operation) || activeIntent(state, original) === undefined
    || !history.operations.some(row => row.operationId === operation.operationId && row.intentId === original.intentId
      && row.signature === proof.operationSignature && row.factRef === proof.completedFactRef)
    || !history.materials.some(row => row.ref === proof.waitRef && row.factRef === proof.waitFactRef)
    || proof.originalBlock.ref !== proof.waitRef) return false;

  const latestWait = [...state.materials].reverse().find(isLocalResourceWait);
  if (latestWait !== undefined && latestWait.ref !== proof.waitRef) return false;

  const reservationId = centralDeliberationReservation({ scope: state.scope, budgetId: proof.budgetId, operationId: operation.operationId });
  const accounting = budget.budget.accounting?.find(row => row.reservationId === reservationId);
  const originalCap = readOriginalCapacity(proof.originalBlock, operation.operationId, reservationId);

  return originalCap !== undefined && proof.originalRequestedOutputTokens === originalCap && proof.requestedOutputTokens > originalCap
    && (operation.maxOutputTokens === undefined || operation.maxOutputTokens === originalCap)
    && proof.reservationId === reservationId && accounting?.owner.kind === "central_deliberation"
    && accounting.owner.ownerId === proof.budgetId && accounting.state === "settled" && accounting.usage.kind === "reported"
    && typeof accounting.usage.outputTokens === "number" && Number.isSafeInteger(accounting.usage.outputTokens)
    && accounting.usage.outputTokens === originalCap;
}

function increaseOperation(proof: Lineage, lineageRef: string): Extract<CentralLearningOperation, { readonly kind: "think" }> {
  return { kind: "think", operationId: centralOutputCapacityIncreaseOperationId(proof.scope, proof.budgetId, proof.originalOperationId),
    purpose: proof.originalCompleted.operation.purpose,
    expectedChange: proof.originalCompleted.operation.expectedChange,
    maxOutputTokens: proof.requestedOutputTokens,
    sourceRefs: [...new Set([proof.originalOperationId, proof.budgetId, lineageRef, proof.waitRef, proof.waitFactRef,
      ...proof.originalCompleted.operation.sourceRefs])] };
}

/** Read original negative evidence only. The lineage is control feedback, never a
 * new business observation, semantic result, budget change or permission grant. */
export async function readCentralOutputCapacityIncrease(input: CentralOutputCapacityIncreaseInput): Promise<CentralOutputCapacityIncrease | undefined> {
  const { state, history, budget, configuration } = input;

  if (!isCentralGenerationLimits(configuration.generationLimits)) return undefined;

  const latestWait = [...state.materials].reverse().find(isLocalResourceWait);
  const waitRef = input.waitRef ?? latestWait?.ref;
  if (input.waitRef !== undefined && latestWait !== undefined && input.waitRef !== latestWait.ref) return undefined;

  for (const head of [...history.operations].reverse()) {
    if (head.operationId.startsWith(CENTRAL_OUTPUT_CAPACITY_INCREASE_PREFIX)) continue;

    const operationId = centralOutputCapacityIncreaseOperationId(state.scope, budget.budget.budgetId, head.operationId);
    if (slotUsed(state, history, operationId)) continue;

    const completed = await input.lookupCompleted(head.operationId, head.factRef);
    if (completed === undefined || !isCentralCompletedOperation(completed) || completed.outcome !== "failed" || completed.operation.kind !== "think") continue;

    const liveCompleted = state.completed.find(row => row.operation.operationId === head.operationId);
    if (liveCompleted !== undefined && canonicalJson(liveCompleted) !== canonicalJson(completed)) continue;

    const locator = [...history.materials].reverse().find(row => blockAddress(row.ref, head.operationId) && (waitRef === undefined || row.ref === waitRef));
    if (locator === undefined) continue;

    const block = await input.lookupMaterial(locator.ref, locator.factRef);
    if (block === undefined) continue;

    const liveBlock = state.materials.find(row => row.ref === locator.ref);
    if (liveBlock !== undefined && canonicalJson(liveBlock) !== canonicalJson(block)) continue;

    const reservationId = centralDeliberationReservation({ scope: state.scope, budgetId: budget.budget.budgetId, operationId: head.operationId });
    const originalCap = readOriginalCapacity(block, head.operationId, reservationId);
    if (originalCap === undefined) continue;

    const proof: Lineage = { schemaVersion: 1, role: "authenticated_output_capacity_increase", scope: state.scope,
      budgetId: budget.budget.budgetId, originalOperationId: head.operationId, operationSignature: head.signature,
      completedFactRef: head.factRef, originalCompleted: completed, waitRef: locator.ref, waitFactRef: locator.factRef, originalBlock: block,
      reservationId, originalRequestedOutputTokens: originalCap, requestedOutputTokens: configuration.generationLimits.maxOutputTokens };
    if (!proofValid(state, history, budget, configuration, proof)) continue;

    const lineageRef = `${CENTRAL_OUTPUT_CAPACITY_INCREASE_FEEDBACK_PREFIX}${contentHashOf(proof)}`;
    const material: CentralRuntimeMaterial = { ref: lineageRef, kind: "feedback", text: canonicalJson(proof),
      sourceRefs: [...new Set([proof.originalOperationId, proof.waitRef, proof.waitFactRef, proof.completedFactRef, proof.reservationId])] };
    const operation = increaseOperation(proof, lineageRef);
    if (!isCentralRuntimeMaterial(material) || !isCentralLearningOperation(operation)) continue;

    verifiedLineages.set(material, material.text);
    verifiedOperations.set(operation, material.text);

    return { intent: activeIntent(state, completed) ?? null, operation, materials: [material],
      admission: { kind: "output_capacity_increase", originalOperationId: proof.originalOperationId, waitRef: proof.waitRef, lineageRef } };
  }

  return undefined;
}

/** Recheck the actual selected operation against original history and accounting;
 * neither a caller's admission object nor larger numbers alone open the wait. */
export function authenticatedCentralOutputCapacityIncrease(state: CentralLearningRuntimeState,
  history: ProofHistory, budget: CentralBudgetProjection, configuration: Configuration, operation: CentralLearningOperation): boolean {
  if (!isCentralOutputCapacityIncreaseOperation(state.scope, operation) || slotUsed(state, history, operation.operationId)) return false;

  const material = state.materials.find(row => row.ref === operation.sourceRefs[2]);
  if (material === undefined || verifiedLineages.get(material) !== material.text) return false;

  const proof = material === undefined ? undefined : readLineage(material);

  return proof !== undefined && proofValid(state, history, budget, configuration, proof)
    && canonicalJson(increaseOperation(proof, material!.ref)) === canonicalJson(operation)
    && canonicalJson(material!.sourceRefs) === canonicalJson([...new Set([proof.originalOperationId, proof.waitRef, proof.waitFactRef,
      proof.completedFactRef, proof.reservationId])]);
}

/** Packing inherits the original control contracts only after the driver has
 * authenticated these exact original facts. This does not authorize a call or
 * turn the increased operation back into an action correction. */
export function centralOutputCapacityIncreaseOriginalOperation(request: Pick<CentralDeliberationRequest, "scope" | "budgetId" | "operation">,
  materials: readonly CentralRuntimeMaterial[]): CentralLearningOperation | undefined {
  if (!isCentralOutputCapacityIncreaseOperation(request.scope, request.operation)) return;

  const material = materials.find(row => row.ref === request.operation.sourceRefs[2]);
  if (material === undefined || verifiedOperations.get(request.operation) !== material.text) return;

  const proof = readLineage(material);
  if (proof === undefined || proof.scope !== request.scope || proof.budgetId !== request.budgetId
    || canonicalJson(increaseOperation(proof, material.ref)) !== canonicalJson(request.operation)) return;

  return proof.originalCompleted.operation;
}
