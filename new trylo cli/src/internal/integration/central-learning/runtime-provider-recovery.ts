import type { ProviderErrorClass, ProviderRecoveryHint } from "../../ports/provider.js";
import { PROVIDER_ERROR_CLASSES } from "../../ports/provider.js";
import { isProviderRecoveryHint, isProviderRecoveryMilliseconds as date } from "../../domain/provider-recovery.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import type { CentralLearningOperation, CentralLearningRuntimeState, CentralRuntimeMaterial } from "../../learning/central/runtime/contracts.js";
import { fields, sequence } from "../../validation/json-shape.js";
import type { CentralDeliberationProviderFailure } from "./deliberation-contract.js";
import { isProviderResourceWait } from "../../learning/central/runtime/resource-waits.js";
import type { CentralRuntimeHistory } from "../../learning/central/runtime/records.js";
import { CentralDeliberationError } from "./deliberation-contract.js";

type Backoff = { readonly kind: "local_backoff"; readonly delayMs: number };

export type ProviderRecoveryState =
  | { readonly kind: "until"; readonly cause: ProviderErrorClass; readonly observedAt: number;
      readonly at: number; readonly basis: ProviderRecoveryHint | Backoff }
  | { readonly kind: "external_change"; readonly cause: ProviderErrorClass }
  | { readonly kind: "exhausted"; readonly cause: ProviderErrorClass; readonly notBefore?: number };

export interface ProviderResourceCondition {
  readonly blocked: boolean;
  readonly reason?: string;
  readonly wakeAt?: number;
  readonly material?: CentralRuntimeMaterial;
  readonly recovery?: { readonly intentId: string; readonly operation: CentralLearningOperation };
}

const retryId = (waitRef: string) => `central-provider-recovery:${contentHashOf(waitRef)}`;
const cause = (value: unknown): value is ProviderErrorClass => typeof value === "string"
  && PROVIDER_ERROR_CLASSES.some(item => item === value);

export function isProviderRecoveryAttempt(state: CentralLearningRuntimeState, operation: CentralLearningOperation): boolean {
  return state.materials.some(row => isProviderResourceWait(row)
    && operation.operationId === retryId(row.ref) && operation.sourceRefs.includes(row.ref));
}

function deadline(basis: ProviderRecoveryHint | Backoff, now: number): number | undefined {
  const relative = basis.kind === "at" ? now : now + basis.delayMs;
  const at = basis.kind === "at" || basis.kind === "all" ? Math.max(relative, basis.atMs) : relative;
  return date(now) && date(at) ? at : undefined;
}

function validRecovery(value: unknown): value is ProviderRecoveryState {
  if (fields(value, ["kind", "cause"])) return (value.kind === "external_change" || value.kind === "exhausted") && cause(value.cause);

  if (fields(value, ["kind", "cause", "notBefore"])) return value.kind === "exhausted" && cause(value.cause) && date(value.notBefore);

  if (!fields(value, ["kind", "cause", "observedAt", "at", "basis"]) || value.kind !== "until"
    || value.cause !== "rate_limit" && value.cause !== "quota"
    || !date(value.observedAt) || !date(value.at)) return false;

  const basis = value.basis;

  return (isProviderRecoveryHint(basis) || value.cause === "rate_limit" && isBackoff(basis))
    && deadline(basis, value.observedAt) === value.at;
}

function isBackoff(value: unknown): value is Backoff {
  return fields(value, ["kind", "delayMs"]) && value.kind === "local_backoff" && sequence(value.delayMs) && value.delayMs > 0;
}

function providerFailure(error: unknown): CentralDeliberationProviderFailure | undefined {
  const failure = error instanceof Error && "providerFailure" in error ? error.providerFailure : undefined;
  if (typeof failure !== "object" || failure === null || !("class" in failure) || !cause(failure.class)
    || !("retryable" in failure) || typeof failure.retryable !== "boolean") return undefined;
  return { class: failure.class, retryable: failure.retryable,
    ...("recovery" in failure && isProviderRecoveryHint(failure.recovery) ? { recovery: failure.recovery } : {}) };
}

/** A deadline permits one new funded computation; it never proves provider recovery. */
export function providerRecoveryForFailure(state: CentralLearningRuntimeState, operation: CentralLearningOperation,
  error: unknown, now: number, backoffMs: number, positiveAdmission?: true): ProviderRecoveryState | undefined {
  const typed = providerFailure(error);

  if (positiveAdmission === true) {
    if (typed !== undefined && typed.class !== "auth" && typed.class !== "quota") {
      const basis = typed.recovery ?? (typed.class === "rate_limit" && typed.retryable
        ? { kind: "local_backoff" as const, delayMs: backoffMs } : undefined);
      const notBefore = basis === undefined ? undefined : deadline(basis, now);
      return { kind: "exhausted", cause: typed.class, ...(notBefore === undefined ? {} : { notBefore }) };
    }

    if (error instanceof CentralDeliberationError && error.reason === "central_deliberation_timeout" && error.delivery === "unknown") {
      return { kind: "exhausted", cause: "timeout" };
    }

    if (error instanceof CentralDeliberationError && error.delivery === "unknown" && error.failureClass === "transport") {
      return { kind: "exhausted", cause: "unknown" };
    }
  }

  if (isProviderRecoveryAttempt(state, operation)) return { kind: "exhausted", cause: typed?.class ?? "unknown" };

  if (typed === undefined || typed.class !== "rate_limit" && typed.class !== "quota" && typed.class !== "auth") return undefined;

  const hint = "recovery" in typed && isProviderRecoveryHint(typed.recovery) ? typed.recovery : undefined;
  const basis = typed.class === "auth" ? undefined : hint ?? (typed.class === "rate_limit" && typed.retryable
    ? { kind: "local_backoff" as const, delayMs: backoffMs } : undefined);
  const at = basis === undefined ? undefined : deadline(basis, now);

  return basis === undefined || at === undefined ? { kind: "external_change", cause: typed.class }
    : { kind: "until", cause: typed.class, observedAt: now, at, basis };
}

export function readProviderRecovery(value: unknown): ProviderRecoveryState {
  if (!validRecovery(value)) throw new Error("central_provider_recovery_corrupt");
  return value;
}

export function providerResourceCondition(state: CentralLearningRuntimeState, record: CentralRuntimeMaterial,
  recovery: ProviderRecoveryState, operationId: string, now: number,
  history?: Pick<CentralRuntimeHistory, "operations">): ProviderResourceCondition {
  if (recovery.kind !== "until") return { blocked: true, reason: recovery.kind === "exhausted"
    ? "provider_recovery_exhausted" : "provider_wait_for_actual_external_change" };

  const operation = state.completed.find(row => row.operation.operationId === operationId);
  const recovered = state.completed.find(row => row.operation.operationId === retryId(record.ref));
  const body = { priorWaitRef: record.ref, notBefore: recovery.at, basis: recovery.basis,
    interpretation: "provider_not_before_reached_one_bounded_attempt_not_confirmed_capacity" };
  const material: CentralRuntimeMaterial = { ref: `central-provider-recovery-due:${contentHashOf(body)}`, kind: "source",
    text: canonicalJson(body), sourceRefs: [record.ref, operationId] };
  if (recovered?.outcome === "returned" || state.consumedSourceRefs.includes(material.ref)) return { blocked: false };

  if (recovered !== undefined || history?.operations.some(row => row.operationId === retryId(record.ref))) {
    return { blocked: true, reason: "provider_recovery_exhausted" };
  }

  if (now < recovery.at) return { blocked: true, reason: "provider_wait_until_not_before", wakeAt: recovery.at };

  if (operation === undefined) return { blocked: true, reason: "provider_recovery_context_missing" };

  const intent = state.intents.find(row => row.intentId === operation.intentId);
  if (intent?.continuation.kind === "ended") return { blocked: true, reason: "provider_recovery_purpose_ended" };

  return { blocked: false, material, recovery: { intentId: operation.intentId, operation: { kind: "think",
    operationId: retryId(record.ref), purpose: operation.operation.purpose,
    expectedChange: "通信等待时点已到；仅重新计算一次原目的，远端容量尚未确认。保留旧未知费用，再次失败即等待真实外部恢复。",
    sourceRefs: [...new Set([record.ref, material.ref, operationId, ...operation.operation.sourceRefs])] } } };
}
