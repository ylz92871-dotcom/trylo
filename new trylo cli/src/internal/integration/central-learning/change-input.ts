import type { CentralDeliberationRequest, CentralRuntimeMaterial } from "../../learning/central/runtime/contracts.js";
import { isCentralUnreadNavigationMaterial } from "../../learning/central/runtime/material-role.js";
import { identifyDeliveredArchivedIntentClaims } from "../../learning/central/runtime/archived-intents.js";
import { centralJudgmentControlRefs } from "../../learning/central/runtime/judgment.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import type { CentralInputEntryInput, CentralInputKind } from "./deliberation-input-dictionary.js";
import { bindCentralInputDictionary, centralInputHandle, createCentralInputDictionary } from "./deliberation-input-dictionary.js";
import { centralInputMaterials, centralOrganizationInputInventory } from "./deliberation-input-sources.js";
import { isUserPeerStatusNavigation, projectUserPeerStatusMaterials } from "../user-learning/central-status-navigation.js";
import { CENTRAL_CHANGE_INPUT_VERSION, usesCentralShortReferenceHandles, usesCentralSourceProjectionV5, type CentralChangeInputVersion,
  type CentralChangeExposure, type CentralChangeInput, type CentralChangeInputDictionary } from "./change-input-contract.js";
import { centralMaterialReadInventory } from "./deliberation-read-inventory.js";
import { renderCentralChangeData, type CentralInputPresentedMaterial } from "./change-input-render.js";
import { readActivePurposeDelivery } from "./active-purpose-delivery.js";
import { centralReferenceKinds, readCentralReferenceSelectionCapability,
  type CentralChangeReferenceCategory } from "./change-reference-contract.js";
import { centralActionCorrectionMandatoryRefs } from "./runtime-action-correction.js";

export { CENTRAL_CHANGE_INPUT_VERSION } from "./change-input-contract.js";
export type { CentralChangeInput, CentralChangeInputDictionary, CentralChangeExposure } from "./change-input-contract.js";

const control = (row: CentralRuntimeMaterial) => row.ref.startsWith("central-semantic-attempt:")
  || row.ref.startsWith("central-read-refusal:");

/** Only authenticated correction refs and host wrappers around them are controls.
 * Ordinary source JSON cannot acquire host metadata by naming an originalRef. */
function boundRuntimeControl(row: CentralRuntimeMaterial, refs: ReadonlySet<string>): boolean {
  if (refs.has(row.ref)) return true;

  if (!row.ref.startsWith("central-source-page:") && !row.ref.startsWith("central-runtime-fragment:")) return false;

  let body: unknown;

  try { body = JSON.parse(row.text); } catch { return false; } // An unparseable wrapper carries no bound control identity.

  return typeof body === "object" && body !== null
    && ("originalRef" in body && typeof body.originalRef === "string" && refs.has(body.originalRef)
      || "ref" in body && typeof body.ref === "string" && refs.has(body.ref));
}

/** A default quote is offered only for a source-owned actual fragment whose
 * literal text is unique in this exact delivered material. No directory,
 * report summary, escaped reconstruction or entire arbitrary source qualifies. */
function excerpt(row: CentralRuntimeMaterial, exposure: CentralChangeExposure["kind"]): string | undefined {
  if (exposure !== "body" || !row.ref.startsWith("central-source-page:")) return undefined;

  let value: unknown;

  try { value = JSON.parse(row.text); } catch { return undefined; } // Plain text has no authenticated fragment descriptor.

  if (typeof value !== "object" || value === null || !("text" in value) || typeof value.text !== "string"
    || !value.text.trim() || value.text.length > 32768 || row.text.indexOf(value.text) < 0
    || row.text.indexOf(value.text) !== row.text.lastIndexOf(value.text)) return undefined;

  return value.text;
}

/** This consumes only the original packer's final selection. It performs no
 * source reads, funding, discovery, archival writes or learning decisions. */
export function createCentralChangeView(request: CentralDeliberationRequest,
  inputVersion: CentralChangeInputVersion = CENTRAL_CHANGE_INPUT_VERSION): CentralChangeInput {
  const rawMaterials = centralInputMaterials(request), sourceProjectionV5 = usesCentralSourceProjectionV5(inputVersion);
  const materials = sourceProjectionV5 ? projectUserPeerStatusMaterials(rawMaterials) : rawMaterials;
  const shortHandles = usesCentralShortReferenceHandles(inputVersion);
  const judgmentRefs = centralJudgmentControlRefs(materials);
  const judgment = (row: CentralRuntimeMaterial) => judgmentRefs.has(row.ref);
  const runtimeControlRefs = shortHandles ? new Set([...centralActionCorrectionMandatoryRefs(request, materials),
    ...materials.filter(row => readCentralReferenceSelectionCapability(row) !== undefined).map(row => row.ref)]) : new Set<string>();
  const runtimeControl = (row: CentralRuntimeMaterial) => shortHandles && boundRuntimeControl(row, runtimeControlRefs);
  const delivery = (row: CentralRuntimeMaterial): CentralChangeExposure["kind"] => control(row) || runtimeControl(row) || judgment(row) ? "control"
    : (sourceProjectionV5 && isUserPeerStatusNavigation(row) || isCentralUnreadNavigationMaterial(row)) ? "navigation" : "body";
  const organizationRequest = shortHandles || judgmentRefs.size > 0 ? {
    ...request, materials: request.materials.filter(row => !runtimeControl(row) && !judgment(row)),
    organization: request.organization.filter(row => !runtimeControl(row) && !judgment(row)),
    state: { ...request.state, materials: request.state.materials.filter(row => !runtimeControl(row) && !judgment(row)) },
  } : request;
  const organization = centralOrganizationInputInventory(organizationRequest);
  const activeDelivery = readActivePurposeDelivery(request);
  const visibleIntentIds = new Set(activeDelivery.visibleIntents.map(intent => intent.intentId));
  const liveIntentIds = new Set(request.state.intents.map(row => row.intentId));
  // Presentation identifies a delivered original, never authority to resume it.
  // The original history validator still decides whether its identity is current.
  const archivedClaims = [...identifyDeliveredArchivedIntentClaims(request).values()].filter(claim =>
    claim.intent.continuation.kind === "ended" && claim.intent.continuation.goalState !== "withdrawn"
      && (!activeDelivery.navigation || !liveIntentIds.has(claim.intent.intentId) || visibleIntentIds.has(claim.intent.intentId)));
  const intentIndex = new Map(archivedClaims.map(claim => [claim.intent.intentId, claim.intent]));

  for (const row of activeDelivery.visibleIntents) intentIndex.set(row.intentId, row);

  const entries: CentralInputEntryInput[] = [];
  const add = (kind: CentralInputKind, ref: string) => entries.push({ kind, ref });
  const reference = (ref: string) => add("reference", ref);
  const references = (refs: readonly string[]) => refs.forEach(reference);
  const readInventory = centralMaterialReadInventory(request, materials, inputVersion);
  const readRefs = new Set(readInventory.advertised), excerpts = new Map<string, string>();

  if (activeDelivery.navigationData !== undefined) {
    for (const row of activeDelivery.navigationData.entries) {
      reference(row.intentId);
      readRefs.add(row.readRef);
    }
    if (activeDelivery.navigationData.nextRef !== null) readRefs.add(activeDelivery.navigationData.nextRef);
  }

  for (const row of materials) {
    reference(row.ref);
    references(row.sourceRefs);
    // A derived status view is already complete navigation, not an archived body address.
    if (!sourceProjectionV5 || !isUserPeerStatusNavigation(row)) readRefs.add(row.ref);
    if (delivery(row) === "body") add("source", row.ref);
    const text = excerpt(row, delivery(row));
    if (text !== undefined) {
      excerpts.set(row.ref, text);
      add("span", row.ref);
    }
  }

  for (const ref of readRefs) add("read", ref);

  for (const ref of organization.feedback) add("organization_feedback", ref);

  for (const [factId, knowledgeId] of organization.knowledge) {
    reference(factId);
    reference(knowledgeId);
    if (organization.knowledgeBodies.has(factId)) add("organization_revision", factId);
  }

  for (const ref of organization.recalls.keys()) add("organization_recall", ref);

  references([request.scope, request.budgetId, request.stateRef, request.configuration.configurationRef, request.configuration.authorizationRef]);
  const subject = (value: CentralDeliberationRequest["state"]["intents"][number]["subject"]) => references(value.plane === "agent"
    ? [value.issueId] : value.plane === "user" ? [value.ledgerRef, value.questionRef] : [value.questionRef]);
  const operation = (value: CentralDeliberationRequest["operation"]) => { add("operation", value.operationId);
  references(value.sourceRefs);
    if (value.kind === "read") references(value.refs); };

  operation(request.operation);

  if (request.state.agendaRead !== undefined) operation(request.state.agendaRead);

  const opportunities = new Map(request.opportunities.map(row => [`central-input-opportunity:${contentHashOf(row)}`, row]));

  for (const [ref, row] of opportunities) {
    add("opportunity", ref);
    reference(row.sourceRef);
    subject(row.subject);
  }

  for (const row of intentIndex.values()) {
    add("intent", row.intentId);
    reference(row.intentId);
    subject(row.subject);
    references(row.sourceRefs);
    for (const knowledge of row.knowledge) references(knowledge.sourceRefs);
    if (row.derivation !== undefined) {
      references(row.derivation.parentRefs);
      references(row.derivation.citations.map(citation => citation.evidenceRef));
    }
    if (row.continuation.kind === "ready") operation(row.continuation.operation);
    else if (row.continuation.kind === "waiting") references(row.continuation.wait.sourceRefs);
  }

  for (const row of request.state.completed) { reference(row.intentId);
  operation(row.operation);
  references(row.resultRefs);
    if (row.wait !== undefined) references(row.wait.sourceRefs); }

  for (const row of request.state.running) {
    reference(row.intentId);
    reference(row.workRef);
    operation(row.operation);
  }

  const table = createCentralInputDictionary(request, entries, shortHandles ? "typed_decimal" : "checkpoint");
  const entryIndex = new Map(table.entries.map(row => [row.handle, row]));
  const lookup = (handle: string, kinds: readonly CentralInputKind[]): string | undefined => {
    const entry = entryIndex.get(handle);
    // This private index was built from this renderer's authenticated frozen
    // table. The compiler checks the request once through assertRequest.
    return entry !== undefined && kinds.includes(entry.kind) ? entry.ref : undefined;
  };
  const materialIndex = new Map(materials.map(row => [row.ref, row]));
  const sourceKinds = centralReferenceKinds("source");
  const dictionary: CentralChangeInputDictionary = Object.freeze({ checkpoint: table.checkpoint, entries: table.entries,
    ...(table.referenceSelectionContractRef === undefined ? {} : { referenceSelectionContractRef: table.referenceSelectionContractRef }),
    ...(table.selectionCode === undefined ? {} : { selectionCode: table.selectionCode }),
    handleKind: (handle: string) => entryIndex.get(handle)?.kind,

    selectionHandles: (category: CentralChangeReferenceCategory) => {
      const kinds = centralReferenceKinds(category);
      return table.entries.filter(entry => kinds.includes(entry.kind)).map(entry => entry.handle);
    },

    assertRequest: (current: CentralDeliberationRequest) => { bindCentralInputDictionary(current, table); },
    source: (handle: string) => { const ref = lookup(handle, sourceKinds);
      return ref !== undefined && entryIndex.get(handle)?.kind === "opportunity" ? opportunities.get(ref)?.sourceRef : ref; },
    read: (handle: string) => lookup(handle, ["read"]),

    intent: (handle: string) => {
      const ref = lookup(handle, ["intent"]);
      return ref === undefined ? undefined : intentIndex.get(ref);
    },

    opportunity: (handle: string) => {
      const ref = lookup(handle, ["opportunity"]);
      return ref === undefined ? undefined : opportunities.get(ref);
    },

    citation: (handle: string, quote?: string) => {
      const ref = lookup(handle, ["source", "span"]), row = ref === undefined ? undefined : materialIndex.get(ref);
      if (row === undefined || delivery(row) !== "body") return undefined;
      const selected = quote ?? (entryIndex.get(handle)?.kind === "span" ? excerpts.get(row.ref) : undefined);
      if (selected === undefined || !selected.trim() || selected.length > 32768 || row.text.indexOf(selected) < 0
        || row.text.indexOf(selected) !== row.text.lastIndexOf(selected)) return undefined;
      return { evidenceRef: row.ref, quote: selected };
    },

    recall: (handle: string) => lookup(handle, ["organization_recall"]),
    knowledge: (handle: string) => { const ref = lookup(handle, ["organization_revision"]);
      const knowledge = ref === undefined ? undefined : organization.knowledgeBodies.get(ref);
      return ref === undefined || knowledge === undefined ? undefined : { factId: ref, knowledge }; },
    feedback: (handle: string) => lookup(handle, ["organization_feedback"]) });
  const archivedLinks = new Map<string, NonNullable<CentralInputPresentedMaterial["intents"]>[number][]>();

  for (const claim of archivedClaims) {
    const links = archivedLinks.get(claim.materialRef) ?? [];
    links.push({ handle: centralInputHandle(table, "intent", claim.intent.intentId), intentId: claim.intent.intentId,
      authority: liveIntentIds.has(claim.intent.intentId) ? "current_live_state" : "delivered_archive" });
    archivedLinks.set(claim.materialRef, links);
  }

  // This links an already presented live capability through an original body
  // relationship; it neither recognizes an archive nor grants a hidden target.
  for (const material of materials) if (delivery(material) === "body") for (const ref of material.sourceRefs) {
    if (!liveIntentIds.has(ref) || !visibleIntentIds.has(ref)) continue;
    const links = archivedLinks.get(material.ref) ?? [];
    if (!links.some(row => row.intentId === ref)) links.push({ handle: centralInputHandle(table, "intent", ref),
      intentId: ref, authority: "current_live_state" });
    archivedLinks.set(material.ref, links);
  }

  if (activeDelivery.navigation) for (const intent of activeDelivery.visibleIntents) {
    const bodyRefs = activeDelivery.materialRefsByIntent.get(intent.intentId) ?? [], ref = bodyRefs[bodyRefs.length - 1];
    if (ref === undefined) continue;
    const links = archivedLinks.get(ref) ?? [];
    if (!links.some(row => row.intentId === intent.intentId)) links.push({ handle: centralInputHandle(table, "intent", intent.intentId),
      intentId: intent.intentId, authority: "current_live_state" });
    archivedLinks.set(ref, links);
  }

  const presented: CentralInputPresentedMaterial[] = materials.map(row => ({ handle: centralInputHandle(table,
    delivery(row) === "body" ? "source" : "reference", row.ref), kind: judgment(row) ? "decision_progress" : row.kind, delivery: delivery(row), text: row.text,
    sources: row.sourceRefs.map(ref => centralInputHandle(table, "reference", ref)),
    reads: readInventory.byMaterial.get(row.ref)!.map(ref => ({ handle: centralInputHandle(table, "read", ref), address: ref })),
    capabilities: [
      ...[...organization.byMaterial.get(row.ref)?.feedback ?? []].map(factId => ({ kind: "feedback" as const, factId,
        handle: centralInputHandle(table, "organization_feedback", factId) })),
      ...[...organization.byMaterial.get(row.ref)?.knowledge ?? []].map(factId => ({ kind: "knowledge" as const, factId,
        knowledgeId: organization.knowledge.get(factId)!, handle: centralInputHandle(table, "organization_revision", factId) })),
      ...[...organization.byMaterial.get(row.ref)?.recalls ?? []].map(ref => ({ kind: "recall" as const, factId: ref,
        handle: centralInputHandle(table, "organization_recall", ref) })),
    ],
    ...(archivedLinks.has(row.ref) ? { intents: archivedLinks.get(row.ref)! } : {}),
    ...(excerpts.has(row.ref) ? { excerpt: { handle: centralInputHandle(table, "span", row.ref),
      start: row.text.indexOf(excerpts.get(row.ref)!), end: row.text.indexOf(excerpts.get(row.ref)!) + excerpts.get(row.ref)!.length } } : {}) }));
  const view = renderCentralChangeData(request, table, presented, inputVersion);

  return Object.freeze({ version: inputVersion, checkpoint: table.checkpoint, view, dictionary,
    messages: Object.freeze([{ role: "user" as const, content: canonicalJson(view) }]),
    exposure: Object.freeze(materials.map(row => Object.freeze({ ref: row.ref, kind: delivery(row), textHash: contentHashOf(row.text),
      readRefs: Object.freeze([...readInventory.byMaterial.get(row.ref)!]) }))) });
}
