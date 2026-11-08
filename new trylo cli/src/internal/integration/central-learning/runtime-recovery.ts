import { contentHashOf, canonicalJson } from "../../learning/control/hash.js";
import { fields, identity, sequence } from "../../validation/json-shape.js";
import type { CentralLearningConfiguration, CentralLearningOperation, CentralLearningRuntimeState, CentralRuntimeMaterial } from "../../learning/central/runtime/contracts.js";
import type { CentralBudgetProjection } from "../../learning/control/central-budget-contract.js";
import { providerRecoveryForFailure, providerResourceCondition, readProviderRecovery, type ProviderResourceCondition } from "./runtime-provider-recovery.js";
import { CENTRAL_PROVIDER_WAIT_PREFIX, CENTRAL_RESOURCE_WAIT_PREFIX, isLocalResourceWait } from "../../learning/central/runtime/resource-waits.js";
import type { CentralRuntimeHistory } from "../../learning/central/runtime/records.js";
import { CentralDeliberationError, isCentralDeliberationInputCapacity } from "./deliberation-contract.js";
import { isCentralDeliberationOutputDiagnostics, isCompleteCentralOutputCapacityRejection } from "./deliberation-output-diagnostics.js";
import { isCentralChangeReferenceRejection } from "./change-reference-contract.js";
import { isCentralChangeStructureRejection } from "./change-structure-rejection.js";
import { isCentralCitationRejection } from "../../learning/central/runtime/citation-rejection.js";
import { isCentralActionCorrectionOperation } from "./runtime-action-correction-identity.js";
import { latestProviderWait } from "./runtime-provider-positive.js";
import { authenticatedCentralOutputCapacityIncrease, isCentralOutputCapacityIncreaseOperation } from "./runtime-output-capacity-increase.js";

type Attempt = { readonly type: "central_semantic_attempt"; readonly operationId: string; readonly issuedAt: number;
  readonly recoveryAt: number; readonly recoveryDepth: number; readonly previousOperationId: string | null };

const PREFIX = "central-semantic-attempt:";

function attempts(state: CentralLearningRuntimeState): readonly Attempt[] {
  return state.materials.filter(row => row.ref.startsWith(PREFIX)).map(row => {
    const raw: unknown = JSON.parse(row.text);
    if (!fields(raw, ["type", "operationId", "issuedAt", "recoveryAt", "recoveryDepth", "previousOperationId"])
      || raw.type !== "central_semantic_attempt" || typeof raw.operationId !== "string"
      || !sequence(raw.issuedAt) || !sequence(raw.recoveryAt) || !sequence(raw.recoveryDepth)
      || !(raw.previousOperationId === null || typeof raw.previousOperationId === "string")) throw new Error("central_semantic_attempt_corrupt");
    return raw as Attempt;
  });
}

export function semanticAttemptMaterial(state: CentralLearningRuntimeState, operation: CentralLearningOperation,
  now: number, recoveryDelayMs: number): CentralRuntimeMaterial {
  const previous = operation.operationId.startsWith("central-recover-thought:")
    ? attempts(state).find(row => operation.sourceRefs.includes(row.operationId)) : undefined;
  const body: Attempt = { type: "central_semantic_attempt", operationId: operation.operationId, issuedAt: now,
    recoveryAt: now + recoveryDelayMs, recoveryDepth: previous === undefined ? 0 : previous.recoveryDepth + 1,
    previousOperationId: previous?.operationId ?? null };

  return { ref: `${PREFIX}${contentHashOf(body)}`, kind: "work_result", text: canonicalJson(body),
    sourceRefs: [...new Set([operation.operationId, ...operation.sourceRefs])] };
}

export function unresolvedSemanticAttempts(state: CentralLearningRuntimeState) {
  return state.completed.filter(row => row.operation.kind === "think" && row.outcome === "unknown")
    .flatMap(completed => { const attempt = attempts(state).find(row => row.operationId === completed.operation.operationId);
      return attempt === undefined ? [] : [{ completed, attempt }]; });
}

export function semanticRecovery(state: CentralLearningRuntimeState, now: number): {
  readonly intentId: string; readonly operation: CentralLearningOperation;
} | null {
  const rows = unresolvedSemanticAttempts(state);
  const latest = rows.at(-1);
  if (latest === undefined || isCentralActionCorrectionOperation(state.scope, latest.completed.operation)
    || isCentralOutputCapacityIncreaseOperation(state.scope, latest.completed.operation)
    || state.materials.some(row => row.ref === recoveryBlockedRef(latest.attempt.operationId))
    || latest.attempt.recoveryDepth > 0 || latest.attempt.recoveryAt > now
    || attempts(state).some(row => row.previousOperationId === latest.attempt.operationId)) return null;

  return { intentId: latest.completed.intentId, operation: { kind: "think",
    operationId: `central-recover-thought:${contentHashOf(latest.attempt.operationId)}`,
    purpose: `从最后公开checkpoint恢复原目的；前次纯语义输出未知：${latest.completed.operation.purpose}`,
    expectedChange: "明确保留前次输出未知与费用，不重发旧reservation；重新推理一次尚有意义的原残余，连续失败后等待真实条件。",
    sourceRefs: [latest.attempt.operationId, ...latest.completed.operation.sourceRefs] } };
}

export function semanticRecoveryAt(state: CentralLearningRuntimeState, now: number): number | undefined {
  const rows = unresolvedSemanticAttempts(state), latest = rows.at(-1);
  return latest === undefined || isCentralActionCorrectionOperation(state.scope, latest.completed.operation)
    || isCentralOutputCapacityIncreaseOperation(state.scope, latest.completed.operation)
    || state.materials.some(row => row.ref === recoveryBlockedRef(latest.attempt.operationId))
    || latest.attempt.recoveryDepth > 0 || latest.attempt.recoveryAt <= now
    || attempts(state).some(row => row.previousOperationId === latest.attempt.operationId) ? undefined : latest.attempt.recoveryAt;
}

const recoveryBlockedRef = (operationId: string) => `${CENTRAL_RESOURCE_WAIT_PREFIX}${contentHashOf(operationId)}`;

function assertOutputDiagnostics(value: object): void {
  if ("outputDiagnostics" in value && (!isCentralDeliberationOutputDiagnostics(value.outputDiagnostics) || !("reservationId" in value)
    || value.reservationId !== null && !identity(value.reservationId))) throw new Error("central_deliberation_output_diagnostics_corrupt");

  if ("semanticRejection" in value && (!isCentralChangeReferenceRejection(value.semanticRejection) || !("reservationId" in value)
    || value.reservationId !== null && !identity(value.reservationId))) throw new Error("central_deliberation_semantic_rejection_corrupt");

  if ("structureRejection" in value && (!isCentralChangeStructureRejection(value.structureRejection) || !("reservationId" in value)
    || value.reservationId !== null && !identity(value.reservationId))) throw new Error("central_deliberation_structure_rejection_corrupt");

  if ("citationRejection" in value && (!isCentralCitationRejection(value.citationRejection) || !("reservationId" in value)
    || value.reservationId !== null && !identity(value.reservationId))) throw new Error("central_deliberation_citation_rejection_corrupt");
}

export function blocksAutomaticSemanticRecovery(error: unknown): boolean {
  // A later transport failure cannot turn an already rejected semantic result
  // into permission to buy another thought over the same original inputs.
  if (error instanceof CentralDeliberationError && error.outputDiagnostics !== undefined) return true;

  // The client's deadline/cancellation cannot prove the dispatched request did
  // not run. Preserve its unknown charge and await its receipt or real inputs.
  if (error instanceof CentralDeliberationError && error.delivery === "unknown"
    && (error.reason === "central_deliberation_timeout" || error.reason === "central_deliberation_cancelled")) return true;

  return error instanceof Error && "failureClass" in error && error.failureClass !== "transport";
}

export function semanticRecoveryBlock(operationId: string, error: unknown, budget: CentralBudgetProjection, configurationRef: string,
  context?: { readonly state: CentralLearningRuntimeState; readonly operation: CentralLearningOperation; readonly now: number;
    readonly recoveryDelayMs: number; readonly providerConnectionRef?: string; readonly generationRef?: string;
    readonly positiveAdmission?: true }): CentralRuntimeMaterial {
  const providerRecovery = context === undefined || isCentralActionCorrectionOperation(context.state.scope, context.operation)
    || isCentralOutputCapacityIncreaseOperation(context.state.scope, context.operation) ? undefined
    : providerRecoveryForFailure(context.state, context.operation, error, context.now, context.recoveryDelayMs, context.positiveAdmission);
  return { ref: providerRecovery === undefined ? recoveryBlockedRef(operationId)
    : `${CENTRAL_PROVIDER_WAIT_PREFIX}${contentHashOf(operationId)}`, kind: "feedback", text: canonicalJson({
    interpretation: providerRecovery?.kind === "until" ? "provider_not_before_then_one_new_funded_computation_not_confirmed_capacity"
      : providerRecovery?.kind === "exhausted" ? "provider_recovery_exhausted_requires_actual_external_change"
        : "explicit_failure_requires_actual_condition_change_not_extra_paid_deliberation",
    operationId, configurationRef, limits: budget.budget.limits, available: budget.available,
    failureClass: error instanceof Error && "failureClass" in error ? error.failureClass : "unknown",
    reason: error instanceof Error ? error.message : "central_deliberation_unconfirmed",
    ...(error instanceof CentralDeliberationError && (error.outputDiagnostics !== undefined || error.semanticRejection !== undefined
      || error.structureRejection !== undefined || error.citationRejection !== undefined)
      ? { reservationId: error.reservationId ?? null,
        ...(error.outputDiagnostics === undefined ? {} : { outputDiagnostics: error.outputDiagnostics }),
        ...(error.semanticRejection === undefined ? {} : { semanticRejection: error.semanticRejection }),
        ...(error.structureRejection === undefined ? {} : { structureRejection: error.structureRejection }),
        ...(error.citationRejection === undefined ? {} : { citationRejection: error.citationRejection }) } : {}),
    ...(error instanceof CentralDeliberationError && error.delivery === "returned"
      && isCompleteCentralOutputCapacityRejection(error.outputDiagnostics) && context?.generationRef !== undefined
      ? { generationRef: context.generationRef } : {}),
    ...(providerRecovery === undefined ? {} : { providerRecovery,
      ...(context?.providerConnectionRef === undefined ? {} : { providerConnectionRef: context.providerConnectionRef }) }) }), sourceRefs: [operationId] };
}

interface OutputCapacityContext extends Pick<CentralLearningConfiguration, "generationLimits" | "rootRef"> {
  /** Host-validated current admission only; not a durable retirement. */
  readonly admittedProviderWaitRef?: string;
  readonly generationRef?: string;
  readonly operation?: CentralLearningOperation;
  /** Original fresh sources or actual returned local/work results, never funds or timers. */
  readonly researchSourceRefs?: readonly string[];
}

/** Provider not-before permits one bounded attempt; it does not satisfy a
 * separate local resource wait, and local root funding cannot clear a provider wait. */
export function semanticResourceCondition(state: CentralLearningRuntimeState, budget: CentralBudgetProjection, configurationRef: string, now: number,
  history?: Pick<CentralRuntimeHistory, "operations"> & Partial<Pick<CentralRuntimeHistory, "materials" | "retiredProviderWaitRefs">>, providerConnectionRef?: string,
  outputCapacity?: OutputCapacityContext): ProviderResourceCondition {
  if (providerConnectionRef !== undefined && !identity(providerConnectionRef)) throw new Error("central_provider_connection_identity_invalid");

  const reversed = [...state.materials].reverse(), latest = latestProviderWait(state, history);
  const providerRecord = latest !== undefined && !history?.retiredProviderWaitRefs?.includes(latest.ref)
    && latest.ref !== outputCapacity?.admittedProviderWaitRef ? latest : undefined;
  let providerCondition: ProviderResourceCondition | undefined;

  if (providerRecord !== undefined) {
    const value: unknown = JSON.parse(providerRecord.text);
    if (typeof value !== "object" || value === null || !("providerRecovery" in value)) throw new Error("central_resource_wait_corrupt");

    assertOutputDiagnostics(value);
    const provider = readProviderRecovery(value.providerRecovery);

    if (!("configurationRef" in value) || typeof value.configurationRef !== "string" || !("operationId" in value)
      || typeof value.operationId !== "string") throw new Error("central_resource_wait_corrupt");

    const previousConnection = "providerConnectionRef" in value ? value.providerConnectionRef : undefined;
    if (previousConnection !== undefined && !identity(previousConnection)) throw new Error("central_resource_wait_corrupt");

    // Missing historical identity cannot prove that a different connection is
    // now in use. Its original deadline/exhaustion remains authoritative.
    providerCondition = previousConnection !== undefined && providerConnectionRef !== undefined && previousConnection !== providerConnectionRef
      ? resourceChange(providerRecord, budget, configurationRef, { previous: previousConnection, current: providerConnectionRef })
      : providerResourceCondition(state, providerRecord, provider, value.operationId, now, history);

    if (providerCondition.blocked) return providerCondition;
  }

  const record = reversed.find(row => {
    if (!isLocalResourceWait(row)) return false;
    const value: unknown = JSON.parse(row.text);
    // Preserve historical packing failures and completed-operation fences, but
    // do not make unrelated future thoughts wait for more money to fix input.
    // Their exact current wire must still fit before any reservation or call.
    return !(typeof value === "object" && value !== null && "reason" in value && isCentralDeliberationInputCapacity(value.reason));
  });
  const increasedOperation = outputCapacity?.operation?.kind === "think" && history?.materials !== undefined
    && authenticatedCentralOutputCapacityIncrease(state, { operations: history.operations, materials: history.materials }, budget,
      { configurationRef, ...outputCapacity }, outputCapacity.operation) ? outputCapacity.operation : undefined;
  const localCondition: ProviderResourceCondition = record === undefined ? { blocked: false }
    : localResourceCondition(record, budget, configurationRef, outputCapacity, increasedOperation);
  if (localCondition.blocked) return localCondition;

  return providerCondition?.recovery !== undefined ? providerCondition : { blocked: false,
    ...(providerCondition?.material !== undefined ? { material: providerCondition.material }
      : localCondition.material === undefined ? {} : { material: localCondition.material }) };
}

function localResourceCondition(record: CentralRuntimeMaterial, budget: CentralBudgetProjection, configurationRef: string,
  outputCapacity?: OutputCapacityContext, increasedOperation?: Extract<CentralLearningOperation, { readonly kind: "think" }>): ProviderResourceCondition {
  const value: unknown = JSON.parse(record.text);
  if (typeof value !== "object" || value === null) throw new Error("central_resource_wait_corrupt");

  assertOutputDiagnostics(value);
  const legacyRemote = "reason" in value && (value.reason === "central_deliberation_provider_rate_limit"
    || value.reason === "central_deliberation_provider_quota" || value.reason === "central_deliberation_provider_auth");
  if (!legacyRemote && (!("failureClass" in value) || value.failureClass !== "resources")) return { blocked: false };

  if (!("configurationRef" in value) || !("limits" in value) || !("available" in value)
    || !fields(value.limits, ["tokens", "calls", "steps"]) || !fields(value.available, ["tokens", "calls", "steps"])) throw new Error("central_resource_wait_corrupt");

  const oldLimits = value.limits, oldResources = value.available;

  if (legacyRemote) return { blocked: true, reason: "provider_connection_identity_unavailable" };

  if ("outputDiagnostics" in value && isCompleteCentralOutputCapacityRejection(value.outputDiagnostics)) {
    return outputCapacityCondition(record, value, budget, configurationRef, outputCapacity, increasedOperation);
  }

  const increased = ["tokens", "calls", "steps"].some(key => {
    const oldLimit = oldLimits[key], oldAvailable = oldResources[key];
    if (typeof oldLimit !== "number" || typeof oldAvailable !== "number") throw new Error("central_resource_wait_corrupt");
    const resource = key as "tokens" | "calls" | "steps";
    return budget.budget.limits[resource] > oldLimit || budget.available[resource] > oldAvailable;
  });
  if (configurationRef === value.configurationRef && !increased) return { blocked: true };

  return resourceChange(record, budget, configurationRef);
}

function outputCapacityCondition(record: CentralRuntimeMaterial, value: object, budget: CentralBudgetProjection,
  configurationRef: string, context?: OutputCapacityContext,
  increasedOperation?: Extract<CentralLearningOperation, { readonly kind: "think" }>): ProviderResourceCondition {
  if ("generationRef" in value && !identity(value.generationRef)) throw new Error("central_resource_wait_corrupt");

  const previous = "generationRef" in value ? value.generationRef : undefined;

  if (context?.generationRef !== undefined && !identity(context.generationRef)) throw new Error("central_generation_identity_invalid");

  const current = context?.generationRef, changed = previous !== undefined && current !== undefined && previous !== current;
  const fresh = context?.operation?.sourceRefs.filter(ref => context.researchSourceRefs?.includes(ref)
    && !ref.startsWith("central-resource-change:") && !ref.startsWith("central-wait-due:")) ?? [];
  if (!changed && fresh.length === 0 && increasedOperation === undefined) return { blocked: true, reason: "central_deliberation_output_capacity_requires_changed_generation_or_research_input" };

  const body = { configurationRef, budgetId: budget.budget.budgetId, priorWaitRef: record.ref,
    interpretation: increasedOperation !== undefined ? "authenticated_actual_requested_generation_cap_increase_not_new_business_evidence"
      : changed ? "actual_generation_configuration_changed_not_confirmed_capacity"
      : "actual_different_research_input_not_a_retry_of_exhausted_output",
    ...(increasedOperation !== undefined ? { actualRequestedCapIncrease: { operationId: increasedOperation.operationId,
        requestedOutputTokens: increasedOperation.maxOutputTokens } }
      : changed ? { generationChange: { previous, current } } : { researchSourceRefs: fresh }) };

  return { blocked: false, material: { ref: `central-resource-change:${contentHashOf(body)}`, kind: "source",
    text: canonicalJson(body), sourceRefs: [record.ref, ...fresh] } };
}

function resourceChange(record: CentralRuntimeMaterial, budget: CentralBudgetProjection, configurationRef: string,
  providerConnectionChange?: { readonly previous: string; readonly current: string }): ProviderResourceCondition {
  const body = { configurationRef, budgetId: budget.budget.budgetId, limits: budget.budget.limits, available: budget.available,
    priorWaitRef: record.ref, interpretation: providerConnectionChange === undefined ? "actual_resource_or_configuration_change_not_learning_gain"
      : "actual_provider_connection_changed_not_confirmed_capacity", ...(providerConnectionChange === undefined ? {} : { providerConnectionChange }) };
  return { blocked: false, material: { ref: `central-resource-change:${contentHashOf(body)}`, kind: "source", text: canonicalJson(body), sourceRefs: [record.ref, budget.budget.budgetId] } };
}
