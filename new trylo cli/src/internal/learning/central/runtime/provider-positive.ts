import { fields, identity, sequence } from "../../../validation/json-shape.js";
import { canonicalJson, contentHashOf } from "../../control/hash.js";

export const TRANSIENT_PROVIDER_RECOVERY_CAUSES = ["network", "timeout", "server", "rate_limit"] as const;

/** Original owner prefix, supplied through its existing status reply. */
export interface ProviderWaitDescriptor {
  readonly scope: string;
  readonly budgetId: string;
  readonly connectionRef: string;
  readonly wait: { readonly ref: string; readonly factRef: string; readonly boardSequence: number };
}

export interface ProviderWaitObservation {
  readonly schemaVersion: 1;
  readonly scope: string;
  readonly budgetId: string;
  readonly connectionRef: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly model: string;
  readonly wait: { readonly ref: string; readonly factRef: string; readonly boardSequence: number };
}

export interface NormalProviderReturnObservation {
  readonly schemaVersion: 1;
  readonly captureHash: string;
  readonly attemptId: string;
  readonly model: string;
  readonly finishReason: "stop" | "tool_calls";
  readonly reportedTotalTokens: number;
}

export interface VerifiedProviderPositiveNote {
  readonly ref: string;
  readonly capture: ProviderWaitObservation;
  readonly returned: NormalProviderReturnObservation;
  readonly request: { readonly sequence: number; readonly at: string };
  readonly finish: { readonly sequence: number; readonly at: string };
}

export interface ProviderPositiveAdmission {
  readonly schemaVersion: 1;
  readonly ref: string;
  readonly scope: string;
  readonly budgetId: string;
  readonly connectionRef: string;
  readonly noteRef: string;
  readonly waitRef: string;
  readonly waitFactRef: string;
  readonly observedBoardSequence: number;
  readonly operationId: string;
  readonly operationSignature: string;
}

export interface ProviderRecoveryUpdate {
  readonly admission?: ProviderPositiveAdmission;
  readonly retiredWaitRefs?: readonly string[];
}

const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

export function isProviderWaitDescriptor(value: unknown): value is ProviderWaitDescriptor {
  return fields(value, ["scope", "budgetId", "connectionRef", "wait"])
    && [value.scope, value.budgetId].every(identity)
    && typeof value.connectionRef === "string" && /^central-learning-provider-connection:[a-f0-9]{64}$/.test(value.connectionRef)
    && fields(value.wait, ["ref", "factRef", "boardSequence"]) && identity(value.wait.ref) && identity(value.wait.factRef) && sequence(value.wait.boardSequence);
}

export function isProviderWaitObservation(value: unknown): value is ProviderWaitObservation {
  return fields(value, ["schemaVersion", "scope", "budgetId", "connectionRef", "sessionId", "turnId", "model", "wait"])
    && value.schemaVersion === 1 && [value.scope, value.budgetId, value.connectionRef, value.sessionId, value.turnId, value.model].every(identity)
    && /^central-learning-provider-connection:[a-f0-9]{64}$/.test(String(value.connectionRef))
    && fields(value.wait, ["ref", "factRef", "boardSequence"]) && identity(value.wait.ref) && identity(value.wait.factRef) && sequence(value.wait.boardSequence);
}

export const providerWaitObservationHash = (value: ProviderWaitObservation): string => contentHashOf(value);

export function isNormalProviderReturnObservation(value: unknown): value is NormalProviderReturnObservation {
  return fields(value, ["schemaVersion", "captureHash", "attemptId", "model", "finishReason", "reportedTotalTokens"])
    && value.schemaVersion === 1 && hash(value.captureHash) && identity(value.attemptId) && identity(value.model)
    && (value.finishReason === "stop" || value.finishReason === "tool_calls") && sequence(value.reportedTotalTokens);
}

export const providerPositiveNoteRef = (note: Omit<VerifiedProviderPositiveNote, "ref">): string =>
  `normal-provider-success:${contentHashOf(note)}`;
export const providerPositiveAdmissionRef = (scope: string, noteRef: string): string =>
  `central-provider-positive-admission:${contentHashOf([scope, noteRef])}`;

export function isProviderPositiveAdmission(value: unknown): value is ProviderPositiveAdmission {
  return fields(value, ["schemaVersion", "ref", "scope", "budgetId", "connectionRef", "noteRef", "waitRef", "waitFactRef",
    "observedBoardSequence", "operationId", "operationSignature"]) && value.schemaVersion === 1
    && [value.ref, value.scope, value.budgetId, value.connectionRef, value.noteRef, value.waitRef, value.waitFactRef, value.operationId].every(identity)
    && hash(value.operationSignature) && sequence(value.observedBoardSequence)
    && value.ref === providerPositiveAdmissionRef(String(value.scope), String(value.noteRef));
}

export function isProviderRecoveryUpdate(value: unknown): value is ProviderRecoveryUpdate {
  if (typeof value !== "object" || value === null) return false;

  const keys = ["admission", "retiredWaitRefs"].filter(key => Object.hasOwn(value, key));
  if (keys.length === 0 || !fields(value, keys)) return false;

  return (!Object.hasOwn(value, "admission") || "admission" in value && isProviderPositiveAdmission(value.admission))
    && (!Object.hasOwn(value, "retiredWaitRefs") || "retiredWaitRefs" in value && Array.isArray(value.retiredWaitRefs)
      && value.retiredWaitRefs.length > 0 && value.retiredWaitRefs.length <= 8 && value.retiredWaitRefs.every(identity)
      && new Set(value.retiredWaitRefs).size === value.retiredWaitRefs.length);
}

export function providerReturnMatchesCapture(capture: ProviderWaitObservation, returned: NormalProviderReturnObservation): boolean {
  return returned.captureHash === providerWaitObservationHash(capture) && returned.model === capture.model;
}

export const sameProviderPositiveAdmission = (left: ProviderPositiveAdmission, right: ProviderPositiveAdmission): boolean =>
  canonicalJson(left) === canonicalJson(right);
