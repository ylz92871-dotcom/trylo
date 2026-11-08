import type { CentralDeliberationRequest, CentralLearningIntentDraft, CentralLearningOperation, CentralLearningSubject } from "../../learning/central/runtime/contracts.js";
import type { JsonObject } from "../../protocol/envelope.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import type { CentralInputDictionary, CentralInputKind } from "./deliberation-input-dictionary.js";
import { centralInputHandle } from "./deliberation-input-dictionary.js";
import { readActivePurposeDelivery } from "./active-purpose-delivery.js";
import { isCentralGenerationLimits } from "../../learning/central/runtime/generation.js";
import { CENTRAL_CHANGE_INPUT_VERSION, usesCentralShortReferenceHandles, usesCentralSourceProjectionV5,
  type CentralChangeInputVersion } from "./change-input-contract.js";
import { centralVisiblePurposeSourceReads } from "./deliberation-purpose-source-reads.js";
import { centralCompletedResultReads } from "./deliberation-read-inventory.js";

export interface CentralInputPresentedMaterial {
  readonly handle: string;
  readonly kind: string;
  readonly delivery: "body" | "navigation" | "control";
  readonly text: string;
  readonly sources: readonly string[];
  readonly reads: readonly { readonly handle: string; readonly address: string }[];
  readonly capabilities: readonly { readonly handle: string; readonly kind: "recall" | "knowledge" | "feedback";
    readonly factId: string; readonly knowledgeId?: string }[];
  readonly intents?: readonly { readonly handle: string; readonly intentId: string;
    readonly authority: "delivered_archive" | "current_live_state" }[];
  readonly excerpt?: { readonly handle: string; readonly start: number; readonly end: number };
}

/** Identity fields are shortened structurally. Prose and source text are never
 * searched/replaced, so a coincidental identifier inside a quotation survives. */
export function renderCentralChangeData(request: CentralDeliberationRequest, table: CentralInputDictionary,
  materials: readonly CentralInputPresentedMaterial[], inputVersion: CentralChangeInputVersion = CENTRAL_CHANGE_INPUT_VERSION): JsonObject {
  const activeDelivery = readActivePurposeDelivery(request), navigation = activeDelivery.navigationData;
  const visibleSourceReads = usesCentralSourceProjectionV5(inputVersion) ? centralVisiblePurposeSourceReads(request, inputVersion) : undefined;
  const completedReads = centralCompletedResultReads(request, inputVersion);
  const known = (kind: CentralInputKind, ref: string) => centralInputHandle(table, kind, ref);
  const referenceHandles = new Map<string, string>();

  for (const entry of table.entries) if (!referenceHandles.has(entry.ref)) referenceHandles.set(entry.ref, entry.handle);

  for (const kind of ["reference", "source"] as const) for (const entry of table.entries) {
    if (entry.kind === kind) referenceHandles.set(entry.ref, entry.handle);
  }

  const reference = (ref: string): string => {
    const handle = referenceHandles.get(ref);
    if (handle === undefined) throw new Error("central_input_render_reference_unbound");
    return handle;
  };
  const refs = (values: readonly string[]) => values.map(reference);
  const subject = (value: CentralLearningSubject) => value.plane === "agent"
    ? { plane: value.plane, domain: value.domain, issue: reference(value.issueId) }
    : value.plane === "user" ? { plane: value.plane, ledger: reference(value.ledgerRef), question: reference(value.questionRef) }
      : { plane: value.plane, question: reference(value.questionRef) };
  const operation = (value: CentralLearningOperation) => ({ ...value, operationId: known("operation", value.operationId),
    sourceRefs: refs(value.sourceRefs), ...(value.kind === "read" ? { refs: value.refs.map(ref =>
      table.entries.some(row => row.kind === "read" && row.ref === ref) ? known("read", ref) : reference(ref)) } : {}) });
  const intent = (value: CentralLearningIntentDraft) => ({ ...value, intentId: known("intent", value.intentId), subject: subject(value.subject),
    sourceRefs: refs(value.sourceRefs), knowledge: value.knowledge.map(row => ({ ...row, sourceRefs: refs(row.sourceRefs) })),
    ...(visibleSourceReads === undefined ? {} : { sourceReads: (visibleSourceReads.get(value.intentId) ?? []).map(ref => ({
      sourceRef: reference(ref), handle: known("read", ref), address: ref })) }),
    ...(value.derivation === undefined ? {} : { derivation: { ...value.derivation, parentRefs: refs(value.derivation.parentRefs),
      citations: value.derivation.citations.map(row => ({ ...row, evidenceRef: reference(row.evidenceRef) })) } }),
    continuation: value.continuation.kind === "ready" ? { kind: "ready", operation: operation(value.continuation.operation) }
      : value.continuation.kind === "waiting" ? { kind: "waiting", wait: { ...value.continuation.wait,
        sourceRefs: refs(value.continuation.wait.sourceRefs) } } : value.continuation });
  // The new presentation omits only duplicate host metadata and previews of
  // complete originals already beside their editing handles in material bodies.
  // Read addresses retain their original version binding. Old receipts select
  // v1 and therefore keep their exact historical navigation bytes below.
  const navigationRead = (readRef: string) => ({ handle: known("read", readRef), address: readRef });
  const agendaNavigation = navigation === undefined ? undefined
    : request.activePurposeDelivery?.version === "active-purpose-navigation-v2" ? {
      role: navigation.role, total: navigation.total,
      entries: navigation.entries.filter(row => !activeDelivery.materialRefsByIntent.has(row.intentId)).map(row => ({
        intentId: row.intentId, goal: row.goal, status: row.status, read: navigationRead(row.readRef) })),
      next: navigation.nextRef === null ? null : navigationRead(navigation.nextRef), interpretation: navigation.interpretation,
    } : { ...navigation,
      entries: navigation.entries.map(row => ({ ...row, read: navigationRead(row.readRef) })),
      next: navigation.nextRef === null ? null : navigationRead(navigation.nextRef) };
  const value = {
    role: "central_learning_public_input", checkpoint: table.selectionCode ?? table.checkpoint,
    ...(table.referenceSelectionContractRef === undefined ? {} : { referenceSelection: {
      contractRef: table.referenceSelectionContractRef, binding: "single_selection_code_bound_to_private_checkpoint" } }),
    resources: { ...request.resources, budgetId: reference(request.budgetId) },
    authorization: { allowance: request.configuration.allowance, thoughtMaxTokens: request.configuration.thoughtMaxTokens ?? null },
    ...(usesCentralShortReferenceHandles(inputVersion) && isCentralGenerationLimits(request.configuration.generationLimits)
      ? { generationLimits: request.configuration.generationLimits } : {}),
    current: operation(request.operation),
    ...(request.state.agendaRead === undefined ? {} : { pendingRead: { ...operation(request.state.agendaRead),
      addresses: request.state.agendaRead.refs, interpretation: "Original queued read, not a learning purpose or a delivered body. Do not issue it again." } }),
    // In navigation mode an opened original is already present once in its
    // material body, with its exact current intent handle beside that body.
    agenda: activeDelivery.navigation ? [] : request.state.intents.map(intent),
    ...(agendaNavigation === undefined ? {} : { agendaNavigation }),
    opportunities: request.opportunities.map(row => ({ handle: known("opportunity", `central-input-opportunity:${contentHashOf(row)}`),
      subject: subject(row.subject), description: row.description, constraints: row.constraints })),
    completed: request.state.completed.map(row => ({ ...row, intentId: reference(row.intentId), operation: operation(row.operation),
      resultRefs: refs(row.resultRefs), ...(completedReads.has(row.operation.operationId)
        ? { resultReads: completedReads.get(row.operation.operationId)!.map(navigationRead) } : {}),
      ...(row.wait === undefined ? {} : { wait: { ...row.wait, sourceRefs: refs(row.wait.sourceRefs) } }) })),
    running: request.state.running.map(row => ({ intent: reference(row.intentId), operation: operation(row.operation),
      work: reference(row.workRef), status: "running", frame: "retained_by_original_host_not_delivered" })),
    materials,
    handleKinds: "b:delivered body; s:displayed exact excerpt; r:read address; i:intent; o:operation; p:opportunity; c:recall; f:feedback fact; v:knowledge fact; e:reference only. Use the handles beside the actual item; a reference is not a readable address or a quotation.",
    interpretation: "Only body text is delivered quotation evidence; navigation, control, previews and hashes do not prove business facts. Empty opportunities do not prevent source-grounded central purposes. Handles grant only their named capability in this checkpoint; original permissions, availability and resources govern dispatch."
  };

  // This is our own JSON-only projection, not an external deserialization boundary.
  return JSON.parse(canonicalJson(value));
}
