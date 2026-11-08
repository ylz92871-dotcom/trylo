import type { CentralDeliberationRequest, CentralLearningIntentDraft, CentralRuntimeMaterial } from "../../learning/central/runtime/contracts.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { fields } from "../../validation/json-shape.js";

const BODY = "central-active-purpose:";
const CATALOG = "central-active-purpose-catalog:";
const FRAGMENT = "central-runtime-fragment:";
const VERSIONS = ["active-purpose-navigation-v1", "active-purpose-navigation-v2"] as const;
const maximumPageSize = 32;

type Delivery = NonNullable<CentralDeliberationRequest["activePurposeDelivery"]>;

export interface ActivePurposeNavigationData {
  readonly role: "central_active_purpose_navigation";
  readonly scope: string;
  readonly agendaVersion: string;
  readonly offset: number;
  readonly pageSize: number;
  readonly total: number;
  readonly entries: readonly {
    readonly intentId: string;
    readonly intentVersion: string;
    readonly goal: string;
    readonly status: CentralLearningIntentDraft["continuation"]["kind"];
    readonly readRef: string;
  }[];
  readonly nextRef: string | null;
  readonly interpretation: string;
}

export type ActivePurposeReadAddress = { readonly kind: "body"; readonly identityHash: string }
  | { readonly kind: "catalog"; readonly identityHash: string; readonly offset: number; readonly pageSize: number };

export const activePurposeVersion = (intent: CentralLearningIntentDraft): string => contentHashOf(intent);
/** Ordering and ended rows remain part of the original complete agenda identity. */
export const activePurposeAgendaVersion = (intents: readonly CentralLearningIntentDraft[]): string => contentHashOf(intents);
export const activePurposeReadRef = (scope: string, intent: CentralLearningIntentDraft): string =>
  `${BODY}${contentHashOf({ scope, intentId: intent.intentId, intentVersion: activePurposeVersion(intent) })}`;
export const ownsActivePurposeReadRef = (ref: string): boolean => ref.startsWith(BODY) || ref.startsWith(CATALOG);

function page(offset: number, pageSize: number): boolean {
  return Number.isSafeInteger(offset) && offset >= 0 && Number.isSafeInteger(pageSize) && pageSize >= 1 && pageSize <= maximumPageSize;
}

export function activePurposeCatalogRef(scope: string, intents: readonly CentralLearningIntentDraft[], offset: number, pageSize: number): string {
  if (!page(offset, pageSize)) throw new Error("central_active_purpose_page_invalid");
  return `${CATALOG}${contentHashOf({ scope, agendaVersion: activePurposeAgendaVersion(intents) })}:${offset}:${pageSize}`;
}

/** The hash is opaque. Source owners must match a builder against their verified current scope and intents. */
export function parseActivePurposeReadRef(ref: string): ActivePurposeReadAddress | undefined {
  if (ref.startsWith(BODY)) {
    const identityHash = ref.slice(BODY.length);
    return /^[a-f0-9]{64}$/.test(identityHash) ? { kind: "body", identityHash } : undefined;
  }

  if (!ref.startsWith(CATALOG)) return undefined;

  const match = /^([a-f0-9]{64}):(0|[1-9]\d*):([1-9]\d*)$/.exec(ref.slice(CATALOG.length));
  if (match === null) return undefined;

  const identityHash = match[1]!, offset = Number(match[2]), pageSize = Number(match[3]);

  return page(offset, pageSize) ? { kind: "catalog", identityHash, offset, pageSize } : undefined;
}

function goalExcerpt(goal: string): string {
  const excerpt = goal.slice(0, 256);
  return /[\ud800-\udbff]$/.test(excerpt) ? excerpt.slice(0, -1) : excerpt;
}

export function createActivePurposeNavigationData(scope: string, intents: readonly CentralLearningIntentDraft[],
  offset: number, pageSize: number): ActivePurposeNavigationData {
  if (!page(offset, pageSize)) throw new Error("central_active_purpose_page_invalid");

  const active = intents.filter(intent => intent.continuation.kind !== "ended");
  const selected = active.slice(offset, offset + pageSize), nextOffset = offset + selected.length;

  return { role: "central_active_purpose_navigation", scope, agendaVersion: activePurposeAgendaVersion(intents), offset, pageSize,
    total: active.length, entries: selected.map(intent => ({ intentId: intent.intentId, intentVersion: activePurposeVersion(intent),
      goal: goalExcerpt(intent.goal), status: intent.continuation.kind, readRef: activePurposeReadRef(scope, intent) })),
    nextRef: nextOffset < active.length ? activePurposeCatalogRef(scope, intents, nextOffset, pageSize) : null,
    interpretation: "Navigation only: goal excerpts are incomplete, not new observations or permission to change a purpose. Read its current complete original first." };
}

/** A real source-read page only. Initial wire navigation uses the pure data above, never a material/notice. */
export function createActivePurposeNavigation(scope: string, intents: readonly CentralLearningIntentDraft[],
  offset: number, pageSize: number): CentralRuntimeMaterial {
  return { ref: activePurposeCatalogRef(scope, intents, offset, pageSize), kind: "knowledge", sourceRefs: [],
    text: canonicalJson(createActivePurposeNavigationData(scope, intents, offset, pageSize)) };
}

export function createActivePurposeOriginal(scope: string, intent: CentralLearningIntentDraft): CentralRuntimeMaterial {
  return { ref: activePurposeReadRef(scope, intent), kind: "work_result", sourceRefs: [intent.intentId],
    text: canonicalJson({ role: "central_active_purpose_original", scope, intentVersion: activePurposeVersion(intent), intent }) };
}

export function isActivePurposeDelivery(value: unknown, intents: readonly CentralLearningIntentDraft[]): value is Delivery {
  return fields(value, ["version", "agendaVersion", "maximumEntries"]) && VERSIONS.some(version => value.version === version)
    && value.agendaVersion === activePurposeAgendaVersion(intents) && typeof value.maximumEntries === "number"
    && page(0, value.maximumEntries);
}

function purposeMaterialValue(material: CentralRuntimeMaterial): unknown {
  if (!material.ref.startsWith(BODY) && !material.ref.startsWith(FRAGMENT)) return undefined;
  try { return JSON.parse(material.text); }
  catch { return undefined; } // Unparseable material has no original-purpose capability.
}

interface PurposeFragment { readonly start: number; readonly end: number; readonly materialRef: string }

function originalFragment(material: CentralRuntimeMaterial, value: unknown, original: CentralRuntimeMaterial): PurposeFragment | undefined {
  if (!fields(value, ["originalRef", "start", "end", "totalChars", "text", "nextRef"]) || value.originalRef !== original.ref
    || typeof value.start !== "number" || !Number.isSafeInteger(value.start) || value.start < 0
    || typeof value.end !== "number" || !Number.isSafeInteger(value.end) || value.end <= value.start || value.end > original.text.length
    || value.totalChars !== original.text.length || typeof value.text !== "string" || value.text !== original.text.slice(value.start, value.end)
    || value.nextRef !== (value.end === original.text.length ? null : `central-runtime-page:${value.end}:${encodeURIComponent(original.ref)}`)
    || material.ref !== `${FRAGMENT}${contentHashOf([original.ref, value.start, value.text])}`) return undefined;
  return { start: value.start, end: value.end, materialRef: material.ref };
}

function completeFragmentRefs(fragments: readonly PurposeFragment[], totalChars: number): readonly string[] | undefined {
  let covered = 0;
  const refs: string[] = [];

  for (const fragment of [...fragments].sort((a, b) => a.start - b.start || b.end - a.end)) {
    if (fragment.start > covered) return undefined;
    if (fragment.end <= covered) continue;
    covered = fragment.end;
    refs.push(fragment.materialRef);
    if (covered === totalChars) return refs;
  }

  return undefined;
}

/** Display/capability projection only. The caller's canonical agenda is never changed or shortened. */
export function readActivePurposeDelivery(request: CentralDeliberationRequest): {
  readonly navigation: boolean;
  readonly visibleIntents: readonly CentralLearningIntentDraft[];
  readonly materialRefsByIntent: ReadonlyMap<string, readonly string[]>;
  readonly navigationData?: ActivePurposeNavigationData;
} {
  const materialRefsByIntent = new Map<string, readonly string[]>();

  if (request.activePurposeDelivery === undefined) return { navigation: false, visibleIntents: request.state.intents, materialRefsByIntent };

  if (!isActivePurposeDelivery(request.activePurposeDelivery, request.state.intents)) throw new Error("central_active_purpose_delivery_invalid");

  const current = new Map(request.state.intents.map(intent => [activePurposeReadRef(request.scope, intent), intent]));
  const originals = new Map<string, CentralRuntimeMaterial>(), fragments = new Map<string, PurposeFragment[]>();

  for (const material of [...request.materials, ...request.state.materials, ...request.organization]) {
    const body = purposeMaterialValue(material);
    const ref = fields(body, ["originalRef", "start", "end", "totalChars", "text", "nextRef"]) && typeof body.originalRef === "string"
      ? body.originalRef : material.ref;
    const intent = current.get(ref);
    if (intent === undefined) continue;

    const original = originals.get(ref) ?? createActivePurposeOriginal(request.scope, intent);
    originals.set(ref, original);

    if (material.ref === ref && canonicalJson(body) === original.text) {
      materialRefsByIntent.set(intent.intentId, [material.ref]);
      continue;
    }

    const fragment = originalFragment(material, body, original);
    if (fragment !== undefined) fragments.set(ref, [...(fragments.get(ref) ?? []), fragment]);
  }

  for (const [ref, pages] of fragments) {
    const intent = current.get(ref)!;
    if (materialRefsByIntent.has(intent.intentId)) continue;
    const refs = completeFragmentRefs(pages, originals.get(ref)!.text.length);
    if (refs !== undefined) materialRefsByIntent.set(intent.intentId, refs);
  }

  return { navigation: true, visibleIntents: request.state.intents.filter(intent => materialRefsByIntent.has(intent.intentId)), materialRefsByIntent,
    navigationData: createActivePurposeNavigationData(request.scope, request.state.intents, 0, request.activePurposeDelivery.maximumEntries) };
}
