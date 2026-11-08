import type { CentralLearningOperation, CentralLearningRuntimeState, CentralRuntimeMaterial } from "../../learning/central/runtime/contracts.js";
import { centralOperationSignature, type CentralRuntimeHistory } from "../../learning/central/runtime/records.js";
import { CENTRAL_PROVIDER_WAIT_PREFIX, CENTRAL_RESOURCE_WAIT_PREFIX, isProviderResourceWait } from "../../learning/central/runtime/resource-waits.js";
import { isCentralRuntimeMaterial } from "../../learning/central/runtime/validation.js";
import { isNormalProviderReturnObservation, isProviderPositiveAdmission, isProviderWaitDescriptor, isProviderWaitObservation, providerPositiveAdmissionRef,
  providerPositiveNoteRef, providerReturnMatchesCapture, TRANSIENT_PROVIDER_RECOVERY_CAUSES,
  type ProviderPositiveAdmission, type ProviderWaitDescriptor, type VerifiedProviderPositiveNote } from "../../learning/central/runtime/provider-positive.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { fields, identity, sequence } from "../../validation/json-shape.js";
import { readProviderRecovery, type ProviderRecoveryState } from "./runtime-provider-recovery.js";

const MATERIAL_ROLE = "original_provider_positive_admission_not_business_evidence";
const MATERIAL_PREFIX = "central-runtime-constraint:provider-positive:";

export interface ProviderPositiveAdmissionInput {
  readonly state: CentralLearningRuntimeState;
  readonly history: CentralRuntimeHistory;
  readonly scope: string;
  readonly budgetId: string;
  readonly connectionRef: string;
  readonly boardSequence: number;
  readonly now: number;
  readonly wait: { readonly material: CentralRuntimeMaterial; readonly factRef: string; readonly sequence: number };
  readonly selectedOperation: CentralLearningOperation | null;
  /** Already identified by the source owner and selector, never receipt/control refs. */
  readonly freshBusinessRefs: readonly string[];
  /** Original journal records have already been verified by their source owner. */
  readonly notes: readonly VerifiedProviderPositiveNote[];
}

function journalPoint(value: unknown): boolean {
  if (!fields(value, ["sequence", "at"]) || !sequence(value.sequence) || typeof value.at !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value.at)) return false;
  return Number.isFinite(Date.parse(value.at));
}

/** Verification of owner records happens before this boundary. These checks
 * cannot make arbitrary JSON into a provider receipt. */
function noteValid(note: VerifiedProviderPositiveNote): boolean {
  if (!fields(note, ["ref", "capture", "returned", "request", "finish"])
    || !isProviderWaitObservation(note.capture) || !isNormalProviderReturnObservation(note.returned)
    || !providerReturnMatchesCapture(note.capture, note.returned)
    || !journalPoint(note.request) || !journalPoint(note.finish) || note.request.sequence >= note.finish.sequence) return false;
  const { ref: _ref, ...body } = note;
  return note.ref === providerPositiveNoteRef(body);
}

function originalTransientWait(material: CentralRuntimeMaterial, history: CentralRuntimeHistory,
  connectionRef: string): ProviderRecoveryState | undefined {
  if (!isCentralRuntimeMaterial(material) || material.kind !== "feedback" || history.retiredProviderWaitRefs?.includes(material.ref)) return undefined;

  let body: unknown;

  try { body = JSON.parse(material.text); } catch { return undefined; }

  if (typeof body !== "object" || body === null || !("operationId" in body) || !identity(body.operationId)
    || body.operationId.startsWith("central-action-correction:")
    || !("failureClass" in body) || body.failureClass !== "transport" && body.failureClass !== "resources"
    || !("providerConnectionRef" in body) || body.providerConnectionRef !== connectionRef
    || !("providerRecovery" in body) || material.text !== canonicalJson(body)
    || material.sourceRefs.length !== 1 || material.sourceRefs[0] !== body.operationId) return undefined;

  const operationId = body.operationId;
  if (!history.operations.some(row => row.operationId === operationId)) return undefined;

  const base = `${material.ref.startsWith(CENTRAL_PROVIDER_WAIT_PREFIX) ? CENTRAL_PROVIDER_WAIT_PREFIX : CENTRAL_RESOURCE_WAIT_PREFIX}${contentHashOf(body.operationId)}`;
  if (material.ref !== base && material.ref !== `${base}:${contentHashOf(material.text)}`) return undefined;

  const recovery = readProviderRecovery(body.providerRecovery);

  return TRANSIENT_PROVIDER_RECOVERY_CAUSES.some(cause => cause === recovery.cause) ? recovery : undefined;
}

function waitValid(input: ProviderPositiveAdmissionInput): boolean {
  const { material, factRef, sequence: waitSequence } = input.wait;
  const latest = latestProviderWait(input.state, input.history);
  const locator = input.history.materials.find(row => row.ref === material.ref && row.factRef === factRef);
  if (!identity(factRef) || !sequence(waitSequence) || waitSequence > input.boardSequence || locator === undefined
    || latest === undefined || canonicalJson(latest) !== canonicalJson(material)
    || "sequence" in locator && locator.sequence !== undefined && locator.sequence !== waitSequence) return false;

  const recovery = originalTransientWait(material, input.history, input.connectionRef);

  return recovery !== undefined && (recovery.kind !== "until" || input.now >= recovery.at)
    && (recovery.kind !== "exhausted" || recovery.notBefore === undefined || input.now >= recovery.notBefore);
}

/** Retirement is checked only after choosing the latest original marker. An
 * older wait cannot return to life merely because its successor was retired. */
export function latestProviderWait(state: CentralLearningRuntimeState,
  history?: Partial<Pick<CentralRuntimeHistory, "materials">>): CentralRuntimeMaterial | undefined {
  let latest: CentralRuntimeMaterial | undefined, latestSequence = -1;

  for (const material of state.materials) {
    if (!isProviderResourceWait(material)) continue;

    const locator = history?.materials?.find(row => row.ref === material.ref);
    // A just-created condition has not reached the current prefix yet. It is
    // later than persisted originals; legacy fixtures without locators keep
    // their existing material order.
    const originalSequence = locator !== undefined && "sequence" in locator && sequence(locator.sequence) ? locator.sequence : Number.MAX_SAFE_INTEGER;
    if (latest === undefined || originalSequence >= latestSequence) {
      latest = material;
      latestSequence = originalSequence;
    }
  }

  return latest;
}

/** The scope owner can publish this original wait in its existing status reply.
 * Capture may precede not-before; only the later admission checks the deadline. */
export function providerWaitForPositiveObservation(state: CentralLearningRuntimeState, history: CentralRuntimeHistory,
  connectionRef: string, budgetId: string, boardSequence: number): ProviderWaitDescriptor | undefined {
  if (![state.scope, connectionRef, budgetId].every(identity) || !sequence(boardSequence)) return undefined;

  const material = latestProviderWait(state, history);
  if (material === undefined || originalTransientWait(material, history, connectionRef) === undefined) return undefined;

  const locator = history.materials.find(row => row.ref === material.ref);
  if (locator === undefined || !identity(locator.factRef) || !("sequence" in locator)
    || !sequence(locator.sequence) || locator.sequence > boardSequence) return undefined;

  const descriptor: ProviderWaitDescriptor = { scope: state.scope, budgetId, connectionRef,
    wait: { ref: material.ref, factRef: locator.factRef, boardSequence } };

  return isProviderWaitDescriptor(descriptor) ? descriptor : undefined;
}

/** This grants only mandatory delivery of an already authorized admission. */
export function readProviderPositiveAdmissionMaterial(material: CentralRuntimeMaterial, operation: CentralLearningOperation,
  scope: string): ProviderPositiveAdmission | undefined {
  if (!isCentralRuntimeMaterial(material) || material.kind !== "feedback" || !material.ref.startsWith(MATERIAL_PREFIX)) return undefined;

  let body: unknown;

  try { body = JSON.parse(material.text); } catch { return undefined; }

  if (!fields(body, ["role", "admission"]) || body.role !== MATERIAL_ROLE || !isProviderPositiveAdmission(body.admission)
    || operation.kind !== "think" || body.admission.scope !== scope || body.admission.operationId !== operation.operationId
    || body.admission.operationSignature !== centralOperationSignature(operation) || material.text !== canonicalJson(body)
    || material.ref !== `${MATERIAL_PREFIX}${contentHashOf(material.text)}`
    || canonicalJson(material.sourceRefs) !== canonicalJson([body.admission.waitRef, body.admission.noteRef])) return undefined;

  return body.admission;
}

/** Reusing a claim still requires the caller's original same-operation admission
 * proof. This renderer grants no note, funding or replay authority. */
export function providerPositiveAdmissionMaterial(admission: ProviderPositiveAdmission): CentralRuntimeMaterial {
  if (!isProviderPositiveAdmission(admission)) throw new Error("central_provider_positive_admission_invalid");
  const text = canonicalJson({ role: MATERIAL_ROLE, admission });
  return { ref: `${MATERIAL_PREFIX}${contentHashOf(text)}`, kind: "feedback", text,
    sourceRefs: [admission.waitRef, admission.noteRef] };
}

const controlRef = (ref: string) => /^(normal-provider-success:|central-provider-positive-admission:|central-resource-change:|central-wait-due:|central-provider-recovery-due:|central-action-correction-feedback:|central-runtime-constraint:)/.test(ref);

/** Release only an already selected fresh computation. The receipt is not a
 * business source or wake. Its admission is consumed by the original issued
 * snapshot; this pure function neither modifies that operation nor writes. */
export function selectProviderPositiveAdmission(input: ProviderPositiveAdmissionInput): {
  readonly admission: ProviderPositiveAdmission; readonly material: CentralRuntimeMaterial;
} | undefined {
  const operation = input.selectedOperation;
  if (input.state.scope !== input.scope || ![input.scope, input.budgetId, input.connectionRef].every(identity)
    || !sequence(input.boardSequence) || !sequence(input.now) || operation?.kind !== "think"
    || /^(central-action-correction:|central-provider-recovery:|central-recover-thought:)/.test(operation.operationId)
    || !operation.sourceRefs.some(ref => input.freshBusinessRefs.includes(ref) && !controlRef(ref))
    || !waitValid(input)) return undefined;

  const signature = centralOperationSignature(operation);
  if (input.history.operations.some(row => row.operationId === operation.operationId || row.signature === signature)) return undefined;

  const admissions = input.history.providerPositiveAdmissions ?? [];

  for (const row of admissions) if (!isProviderPositiveAdmission(row.admission) || !identity(row.factRef)
    || !sequence(row.sequence) || row.sequence > input.boardSequence) throw new Error("central_provider_positive_history_corrupt");

  const latestAdmission = Math.max(-1, ...admissions.filter(row => row.admission.waitRef === input.wait.material.ref).map(row => row.sequence));

  for (const note of input.notes) {
    if (!noteValid(note) || note.capture.scope !== input.scope || note.capture.budgetId !== input.budgetId
      || note.capture.connectionRef !== input.connectionRef || note.capture.wait.ref !== input.wait.material.ref
      || note.capture.wait.factRef !== input.wait.factRef || note.capture.wait.boardSequence < input.wait.sequence
      || note.capture.wait.boardSequence > input.boardSequence || note.capture.wait.boardSequence <= latestAdmission) continue;

    const ref = providerPositiveAdmissionRef(input.scope, note.ref);
    if (admissions.some(row => row.admission.ref === ref)) continue;

    const admission: ProviderPositiveAdmission = { schemaVersion: 1, ref, scope: input.scope, budgetId: input.budgetId,
      connectionRef: input.connectionRef, noteRef: note.ref, waitRef: input.wait.material.ref, waitFactRef: input.wait.factRef,
      observedBoardSequence: note.capture.wait.boardSequence, operationId: operation.operationId, operationSignature: signature };

    return { admission, material: providerPositiveAdmissionMaterial(admission) };
  }

  return undefined;
}
