import type { CentralLearningConfiguration, CentralLearningRuntimeState, CentralRuntimeMaterial } from "../../learning/central/runtime/contracts.js";
import { centralOperationSignature, type CentralRuntimeHistory } from "../../learning/central/runtime/records.js";
import { CENTRAL_RESOURCE_WAIT_PREFIX } from "../../learning/central/runtime/resource-waits.js";
import { isCentralRuntimeMaterial } from "../../learning/central/runtime/validation.js";
import type { CentralBudgetProjection } from "../../learning/control/central-budget-contract.js";
import { isCentralLearningResources } from "../../learning/control/central-learning-resources.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { fields, identity } from "../../validation/json-shape.js";
import { isCompleteCentralOutputCapacityRejection } from "./deliberation-output-diagnostics.js";
import { centralDeliberationReservation } from "./deliberation-prompt.js";

interface RecoveryInput {
  readonly state: CentralLearningRuntimeState;
  readonly history: CentralRuntimeHistory;
  readonly budget: CentralBudgetProjection;
  readonly configuration: Pick<CentralLearningConfiguration, "configurationRef" | "generationRef" | "rootRef">;
  readonly lookupMaterial: (ref: string, factRef: string) => Promise<CentralRuntimeMaterial | undefined>;
}

function blockAddress(ref: string, base: string): boolean {
  return ref === base || ref.startsWith(`${base}:`) && /^[a-f0-9]{64}$/.test(ref.slice(base.length + 1));
}

function originalBlock(material: CentralRuntimeMaterial, operationId: string, reservationId: string): Record<string, unknown> | undefined {
  const base = `${CENTRAL_RESOURCE_WAIT_PREFIX}${contentHashOf(operationId)}`;
  if (!isCentralRuntimeMaterial(material) || material.kind !== "feedback"
    || material.ref !== base && material.ref !== `${base}:${contentHashOf(material.text)}`
    || material.sourceRefs.length !== 1 || material.sourceRefs[0] !== operationId) return undefined;

  let body: unknown;

  try { body = JSON.parse(material.text); } catch { return undefined; }

  const optional = typeof body === "object" && body !== null
    ? ["generationRef", "priorWaitRef", "providerConnectionRef"].filter(key => Object.hasOwn(body, key)) : [];
  if (!fields(body, ["interpretation", "operationId", "configurationRef", "limits", "available", "failureClass", "reason",
    "reservationId", "outputDiagnostics", ...optional])
    || body.interpretation !== "explicit_failure_requires_actual_condition_change_not_extra_paid_deliberation"
    || body.operationId !== operationId || !identity(body.configurationRef)
    || !isCentralLearningResources(body.limits) || !isCentralLearningResources(body.available)
    || body.failureClass !== "transport" && body.failureClass !== "resources"
    || body.reason !== "central_deliberation_incomplete" || body.reservationId !== reservationId
    || !isCompleteCentralOutputCapacityRejection(body.outputDiagnostics)
    || Object.hasOwn(body, "generationRef") && !identity(body.generationRef)
    || Object.hasOwn(body, "providerConnectionRef") && !identity(body.providerConnectionRef)
    || Object.hasOwn(body, "priorWaitRef") && (typeof body.priorWaitRef !== "string" || !blockAddress(body.priorWaitRef, base))) return undefined;

  return body;
}

/** Reclassify only a verified original negative result. This performs no source
 * acknowledgement, interpretation, accounting mutation or provider request. */
export async function recoverCentralOutputCapacityFailures(input: RecoveryInput): Promise<{
  readonly state: CentralLearningRuntimeState; readonly sourceRefs: readonly string[];
} | undefined> {
  const { state, history, budget, configuration } = input;

  if (budget.budget.scope !== state.scope || configuration.generationRef !== undefined && !identity(configuration.generationRef)) return undefined;

  const root = configuration.rootRef;
  if (root !== undefined && (root.scope !== state.scope || root.budgetId !== budget.budget.budgetId
    || root.openedSequence !== budget.budget.openedSequence || root.authorizationRef !== budget.budget.authorizationRef)) return undefined;

  let next = state;
  const sourceRefs = new Set<string>();

  for (const completed of state.completed) {
    if (completed.outcome !== "unknown" || completed.operation.kind !== "think") continue;

    const operationId = completed.operation.operationId;
    if (!history.operations.some(row => row.operationId === operationId && row.intentId === completed.intentId
      && row.signature === centralOperationSignature(completed.operation))) continue;

    const reservationId = centralDeliberationReservation({ scope: state.scope, budgetId: budget.budget.budgetId, operationId });
    const accounting = budget.budget.accounting?.find(row => row.reservationId === reservationId);
    if (accounting?.owner.kind !== "central_deliberation" || accounting.owner.ownerId !== budget.budget.budgetId
      || accounting.state !== "settled" || accounting.usage.kind !== "reported") continue;

    const base = `${CENTRAL_RESOURCE_WAIT_PREFIX}${contentHashOf(operationId)}`;
    const locator = [...history.materials].reverse().find(row => blockAddress(row.ref, base));
    if (locator === undefined) continue;

    const material = state.materials.find(row => row.ref === locator.ref) ?? await input.lookupMaterial(locator.ref, locator.factRef);
    if (material === undefined || material.ref !== locator.ref) continue;

    const body = originalBlock(material, operationId, reservationId);
    if (body === undefined) continue;

    // Old blocks did not persist delivery. Require the formal root owner and
    // the observed output component to corroborate this exact exhausted call.
    if (!isCompleteCentralOutputCapacityRejection(body.outputDiagnostics)
      || accounting.usage.outputTokens !== body.outputDiagnostics.requestedOutputTokens) continue;

    const generationRef = typeof body.generationRef === "string" ? body.generationRef
      : body.configurationRef === configuration.configurationRef ? configuration.generationRef : undefined;
    const text = canonicalJson({ ...body, failureClass: "resources", priorWaitRef: material.ref,
      ...(generationRef === undefined ? {} : { generationRef }) });
    const block: CentralRuntimeMaterial = { ref: `${base}:${contentHashOf(text)}`, kind: "feedback", text, sourceRefs: [operationId] };
    const waitRefs = [material.ref, reservationId, operationId];

    next = { ...next,
      completed: next.completed.map(row => row.operation.operationId === operationId ? { ...row, outcome: "failed" as const,
        publicResult: "central_deliberation_output_capacity_exhausted：原完整 length 响应没有可用语义决定，原预约已有 reported 结算；等待真实生成配置或研究输入变化。" } : row),
      intents: next.intents.map(intent => intent.intentId === completed.intentId && intent.continuation.kind === "ready"
        && intent.continuation.operation.operationId === operationId ? { ...intent, continuation: { kind: "waiting" as const,
          wait: { kind: "resources" as const, reason: "central_deliberation_output_capacity_exhausted", sourceRefs: waitRefs } } } : intent),
      materials: [...next.materials, ...(next.materials.some(row => row.ref === material.ref) ? [] : [material]), block] };

    for (const ref of [material.ref, block.ref, reservationId, operationId]) sourceRefs.add(ref);
  }

  return next === state ? undefined : { state: next, sourceRefs: [...sourceRefs] };
}
