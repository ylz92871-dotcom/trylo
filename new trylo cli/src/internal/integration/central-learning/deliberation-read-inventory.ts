import type { CentralDeliberationRequest, CentralRuntimeMaterial } from "../../learning/central/runtime/contracts.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { fields, sequence } from "../../validation/json-shape.js";
import { readSessionContentAddress, readSessionTaskAddress } from "../learning-content/sources/session-address.js";
import { readSessionPublicTurnAddress } from "../learning-content/sources/session-public-turn.js";
import { centralMaterialPageRef } from "./deliberation-material.js";
import { CENTRAL_CHANGE_INPUT_VERSION, LEGACY_CENTRAL_CHANGE_INPUT_VERSION, usesCentralSourceProjectionV5,
  type CentralChangeInputVersion } from "./change-input-contract.js";
import { createActivePurposeNavigation, parseActivePurposeReadRef, readActivePurposeDelivery } from "./active-purpose-delivery.js";
import { readOrganizationEvidenceMaterial } from "./organization-evidence-material.js";
import { readOrganizationPublicationCondition } from "./organization-publication-material.js";
import { readOrganizationPublicationRejection } from "./organization-publication-detail.js";
import { readOrganizationPublicationFragment } from "./organization-publication-view.js";
import { deliveredOrganizationRecallPacket } from "./runtime-organization-memory.js";
import { centralPurposeSourceReads, centralVisiblePurposeSourceReads } from "./deliberation-purpose-source-reads.js";
import { isUserPeerStatusNavigation } from "../user-learning/central-status-navigation.js";

const readKeys = ["readRef", "nextRef", "browseReadRef", "nextReadRef", "exampleReadRef", "priorityReadRef"];
const textHashNavigation = ["central-runtime-catalog:", "central-runtime-domain-catalog:", "central-runtime-native-catalog:",
  "central-runtime-manifest:", "central-runtime-purpose-navigation:", "central-business-catalog:",
  "organization-navigation:", "organization-feedback-relations:", "organization-capacity:"];

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function directReads(value: unknown): string[] {
  return object(value) ? readKeys.flatMap(key => typeof value[key] === "string" ? [value[key]] : []) : [];
}

const entryReads = (value: unknown): string[] => Array.isArray(value) ? value.flatMap(directReads) : [];
const strings = (...values: readonly (string | null | undefined)[]): string[] => values.flatMap(value => typeof value === "string" ? [value] : []);

/** A formal outer provenance address permits a request to its original owner.
 * Grammar does not attest existence, business relevance, scope or permission;
 * the unchanged source reader checks those against original host facts. */
function originalSessionAddress(ref: string): boolean {
  return readSessionContentAddress(ref) !== undefined || readSessionTaskAddress(ref) !== undefined
    || readSessionPublicTurnAddress(ref) !== undefined;
}

/** Page identities do not hash their added nextRef. Check the owner's exact
 * continuation formula, so editing that field cannot advertise another source.
 * Original text is never parsed as navigation. */
function pageContinuation(material: CentralRuntimeMaterial, body: unknown): string[] {
  if (!object(body)) return [];

  if (material.ref.startsWith("central-runtime-fragment:")) {
    if (!fields(body, ["originalRef", "start", "end", "totalChars", "text", "nextRef"])
      || typeof body.originalRef !== "string" || typeof body.text !== "string"
      || !sequence(body.start) || !sequence(body.end) || !sequence(body.totalChars)
      || body.end <= body.start || body.end - body.start !== body.text.length || body.end > body.totalChars
      || !material.sourceRefs.includes(body.originalRef)
      || material.ref !== `central-runtime-fragment:${contentHashOf([body.originalRef, body.start, body.text])}`) return [];

    const next = body.end < body.totalChars ? `central-runtime-page:${body.end}:${encodeURIComponent(body.originalRef)}` : null;

    return body.nextRef === next ? strings(next) : [];
  }

  if (!material.ref.startsWith("central-source-page:")) return [];

  const optional = ["nextRef", "originalSource"].filter(key => Object.hasOwn(body, key));
  if (!fields(body, ["role", "ref", "originalRef", "origin", "originalScope", "start", "end", "totalChars", "text",
    "sourceHash", "coordinate", "owner", "complete", ...optional]) || body.role !== "actual_source_fragment_not_full_source"
    || typeof body.ref !== "string" || typeof body.originalRef !== "string" || typeof body.text !== "string"
    || !sequence(body.start) || !sequence(body.end) || !sequence(body.totalChars)
    || body.end <= body.start || body.end - body.start !== body.text.length || body.end > body.totalChars
    || body.complete !== (body.start === 0 && body.end === body.totalChars)
    || !material.sourceRefs.includes(body.originalRef)) return [];

  const { role: _role, complete: _complete, nextRef: _nextRef, ...page } = body;

  if (material.ref !== `central-source-page:${contentHashOf(page)}`) return [];

  const continuation = body.owner === "session" && readSessionPublicTurnAddress(body.originalRef) !== undefined ? body.originalRef : body.ref;

  try {
    const next = body.end < body.totalChars ? centralMaterialPageRef(continuation, body.end) : undefined;
    return body.nextRef === next ? strings(next) : [];
  } catch { return []; } // An invalid or over-capacity continuation grants no read location.
}

/** Extract named navigation slots only from original host envelopes. A source
 * may quote arbitrary JSON, roles and evidenceRefs without gaining a read. */
function ownerNavigation(request: CentralDeliberationRequest, material: CentralRuntimeMaterial,
  delivered: readonly CentralRuntimeMaterial[]): string[] {
  let body: unknown;

  try { body = JSON.parse(material.text); } catch { return []; } // Prose is not host navigation.

  if (!object(body)) return [];
  if (material.ref === `central-runtime-constraint:${contentHashOf(material.text)}`
    && body.role === "PA_current_constraint_not_business_evidence" && typeof body.issueId === "string"
    && typeof body.readRef === "string" && body.readRef.startsWith("central-runtime-issue:")) {
    // A PA focus is coordination, not the report's evidence. Its explicit
    // original-body locator lets the model inspect the actual report first.
    // Earlier frozen constraints had no readRef and retain their old menu.
    return [body.readRef];
  }

  if (material.ref.startsWith("central-source-page:") || material.ref.startsWith("central-runtime-fragment:")) {
    return pageContinuation(material, body);
  }

  if (textHashNavigation.some(prefix => material.ref === `${prefix}${contentHashOf(material.text)}`)) {
    return [...directReads(body), ...entryReads(body.entries)];
  }

  if (material.ref === `central-source-navigation:${contentHashOf(body)}`
    && body.role === "central_source_body_not_delivered" && typeof body.originalRef === "string"
    && material.sourceRefs.includes(body.originalRef)) {
    // The new named slot also advertises typed reads. Keep the earlier
    // nativeChangeNotices field opaque so frozen receipts retain their menu.
    return [...directReads(body), ...entryReads(body.sourceNotices), ...entryReads(body.nativeChangeReads), ...entryReads(body.queryReads)];
  }

  const active = parseActivePurposeReadRef(material.ref);
  if (active?.kind === "catalog") {
    const expected = createActivePurposeNavigation(request.scope, request.state.intents, active.offset, active.pageSize);
    return canonicalJson(expected) === canonicalJson(material) ? [...directReads(body), ...entryReads(body.entries)] : [];
  }

  if (material.ref.startsWith("organization-recall:")) {
    const packet = deliveredOrganizationRecallPacket(material, request.scope, delivered);
    if (packet === undefined) return [];
    return [...packet.entries.flatMap(entry => "evidenceCoverage" in entry ? directReads(entry.evidenceCoverage) : []),
      ...entryReads(packet.knowledgeBodyRequired)];
  }

  if (material.ref.startsWith("organization-evidence-page:")) {
    const page = readOrganizationEvidenceMaterial(material, request.scope);
    return page === undefined ? [] : [...entryReads(page.notDelivered), ...strings(page.nextReadRef)];
  }

  if (material.ref.startsWith("organization-publication-condition:")) {
    return readOrganizationPublicationCondition(material, request.scope) === undefined ? [] : directReads(body);
  }

  if (material.ref.startsWith("organization-publication-rejection:")) {
    return readOrganizationPublicationRejection(material, request.scope) === undefined ? [] : entryReads(body.reads);
  }

  if (material.ref === `organization-publication-evidence:${contentHashOf([request.scope, material.text])}`) return entryReads(body.reads);

  if (material.ref.startsWith("organization-publication-fragment:")) {
    const page = readOrganizationPublicationFragment(material, request.scope);
    return page === undefined ? [] : strings(page.originalReadRef, page.nextRef);
  }

  return [];
}

/** Frozen v1 receipt reconstruction only. Never used for a new delivery.
 * Preserve the original traversal order and per-material duplicate own refs. */
function legacyAdvertisements(materials: readonly CentralRuntimeMaterial[]): ReadonlySet<string> {
  const refs = new Set<string>();
  const visit = (value: unknown, depth: number): void => {
    if (depth > 8 || value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 256)) visit(item, depth + 1);
      return;
    }
    for (const [key, item] of Object.entries(value)) {
      if (readKeys.includes(key) && typeof item === "string") refs.add(item);
      else visit(item, depth + 1);
    }
  };

  for (const material of materials) {
    let body: unknown;
    try { body = JSON.parse(material.text); } catch { continue; } // Original v1 prose advertises no navigation.
    visit(body, 0);
  }

  return refs;
}

export interface CentralMaterialReadInventory {
  /** Own material refs are inserted later, after active-purpose navigation. */
  readonly advertised: ReadonlySet<string>;
  readonly byMaterial: ReadonlyMap<string, readonly string[]>;
}

/** Original host read returns stay reopenable when their bodies leave working
 * context. Neither an unknown read nor another operation's output grants this
 * capability. The original reader still owns availability, scope and access. */
export function centralCompletedResultReads(request: CentralDeliberationRequest,
  version: CentralChangeInputVersion): ReadonlyMap<string, readonly string[]> {
  if (version !== "central-learning-change-input-v6" && version !== "central-learning-change-input-v7") return new Map();
  return new Map(request.state.completed.filter(row => row.operation.kind === "read" && row.outcome === "returned"
    && row.resultRefs.length > 0).map(row => [row.operation.operationId, [...new Set(row.resultRefs)]]));
}

/** One selection supplies typed dictionary entries, adjacent read handles,
 * exposure and decoder advertisements. It issues no source read or authority. */
export function centralMaterialReadInventory(request: CentralDeliberationRequest, materials: readonly CentralRuntimeMaterial[],
  version: CentralChangeInputVersion = CENTRAL_CHANGE_INPUT_VERSION): CentralMaterialReadInventory {
  if (version === LEGACY_CENTRAL_CHANGE_INPUT_VERSION) return {
    advertised: legacyAdvertisements(materials),
    byMaterial: new Map(materials.map(row => [row.ref, [...legacyAdvertisements([row]), row.ref]])),
  };

  const advertised = new Set<string>(), byMaterial = new Map<string, readonly string[]>();

  for (const refs of centralCompletedResultReads(request, version).values()) for (const ref of refs) advertised.add(ref);

  const sourceProjectionV5 = usesCentralSourceProjectionV5(version);
  const purposeReads = sourceProjectionV5 ? centralPurposeSourceReads(request, version) : new Map<string, readonly string[]>();
  const visibleReads = sourceProjectionV5 ? centralVisiblePurposeSourceReads(request, version) : new Map<string, readonly string[]>();
  const visibleDelivery = sourceProjectionV5 ? readActivePurposeDelivery(request) : undefined;
  const visibleBodyReads = new Map<string, readonly string[]>();

  for (const [intentId, refs] of visibleReads) {
    for (const ref of refs) advertised.add(ref);
    const materialRef = visibleDelivery?.materialRefsByIntent.get(intentId)?.at(-1);
    if (materialRef !== undefined) visibleBodyReads.set(materialRef, refs);
  }

  for (const row of materials) {
    const refs = [...new Set([...ownerNavigation(request, row, materials), ...(purposeReads.get(row.ref) ?? []),
      ...(visibleBodyReads.get(row.ref) ?? []), ...row.sourceRefs.filter(originalSessionAddress)])];
    for (const ref of refs) advertised.add(ref);
    const ownRefs = sourceProjectionV5 && isUserPeerStatusNavigation(row) ? [] : [row.ref];
    byMaterial.set(row.ref, [...new Set([...refs, ...ownRefs])]);
  }

  return { advertised, byMaterial };
}
