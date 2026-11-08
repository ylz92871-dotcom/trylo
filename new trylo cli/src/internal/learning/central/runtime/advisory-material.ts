import type { CentralRuntimeMaterial } from "./contracts.js";
import { canonicalJson, contentHashOf } from "../../control/hash.js";
import { coordinationScopeValid } from "../../control/coordination-scope.js";
import { isCentralRuntimeMaterial } from "./validation.js";
import { fields, identity, sequence, text } from "../../../validation/json-shape.js";

export const CENTRAL_ADVISORY_CATALOG_ROLE = "central_advisory_publication_catalog_not_read_body";
export const CENTRAL_ADVISORY_RESULT_ROLE = "central_advisory_handoff_result_not_business_evidence";
export const CENTRAL_ADVISORY_CATALOG_PREFIX = "central-advisory-catalog:";
export const CENTRAL_ADVISORY_RESULT_MATERIAL_PREFIX = "central-advisory-result-view:";
export const CENTRAL_ADVISORY_CONTEXT_ENTRIES = 16;

export interface CentralAdvisoryCatalogBody {
  readonly schemaVersion: 1;
  readonly role: typeof CENTRAL_ADVISORY_CATALOG_ROLE;
  readonly scope: string;
  /** The observed original prefix, not a new business source version. */
  readonly boardSequence: number;
  readonly entries: readonly { readonly version: string; readonly readRef: string; readonly id: string;
    readonly intentId: string; readonly knowledgeHash: string; readonly status: "current" }[];
}

export interface CentralAdvisoryResultBody {
  readonly schemaVersion: 1;
  readonly role: typeof CENTRAL_ADVISORY_RESULT_ROLE;
  readonly scope: string;
  readonly resultRef: string;
  readonly decisionRef: string;
  readonly deliveryRef: string;
  readonly appliedStateRef: string;
  readonly entries: readonly { readonly index: number; readonly kind: "publish" | "withdraw";
    readonly intentId: string | null; readonly status: "published" | "withdrawn" | "rejected" | "superseded";
    readonly publicationRef: string | null; readonly reason: string | null }[];
}

const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const address = (value: unknown, prefix: string): value is string => typeof value === "string"
  && value.startsWith(prefix) && hash(value.slice(prefix.length));
const publication = (value: unknown): value is string => address(value, "central-advisory-publication:");
const dense = (value: unknown): value is unknown[] => Array.isArray(value) && value.length > 0
  && value.length <= CENTRAL_ADVISORY_CONTEXT_ENTRIES && Reflect.ownKeys(value).length === value.length + 1;

function catalogBody(value: unknown): value is CentralAdvisoryCatalogBody {
  return fields(value, ["schemaVersion", "role", "scope", "boardSequence", "entries"])
    && value.schemaVersion === 1 && value.role === CENTRAL_ADVISORY_CATALOG_ROLE && coordinationScopeValid(value.scope)
    && sequence(value.boardSequence) && dense(value.entries) && value.entries.every(entry => fields(entry,
      ["version", "readRef", "id", "intentId", "knowledgeHash", "status"]) && publication(entry.version)
      && entry.readRef === entry.version && address(entry.id, "central-advisory:") && identity(entry.intentId)
      && hash(entry.knowledgeHash) && entry.status === "current")
    && new Set(value.entries.map(entry => (entry as { readonly version: string }).version)).size === value.entries.length;
}

function resultEntry(value: unknown, index: number): boolean {
  if (!fields(value, ["index", "kind", "intentId", "status", "publicationRef", "reason"]) || value.index !== index
    || !(value.kind === "publish" || value.kind === "withdraw") || !(value.intentId === null || identity(value.intentId))) return false;
  if (value.status === "published" || value.status === "withdrawn") return value.reason === null && publication(value.publicationRef)
    && value.kind === (value.status === "published" ? "publish" : "withdraw") && value.intentId !== null;
  return (value.status === "rejected" || value.status === "superseded") && value.publicationRef === null && text(value.reason, 256);
}

function resultBody(value: unknown): value is CentralAdvisoryResultBody {
  return fields(value, ["schemaVersion", "role", "scope", "resultRef", "decisionRef", "deliveryRef", "appliedStateRef", "entries"])
    && value.schemaVersion === 1 && value.role === CENTRAL_ADVISORY_RESULT_ROLE && coordinationScopeValid(value.scope)
    && address(value.resultRef, "central-advisory-result:") && identity(value.decisionRef)
    && address(value.deliveryRef, "central-deliberation-delivery:") && address(value.appliedStateRef, "central-runtime-state:")
    && dense(value.entries) && value.entries.every(resultEntry);
}

function body(material: CentralRuntimeMaterial, prefix: string): unknown {
  if (!isCentralRuntimeMaterial(material) || Reflect.ownKeys(material).length !== 4 || material.kind !== "source"
    || material.ref !== `${prefix}${contentHashOf(material.text)}`) return undefined;
  try {
    const value: unknown = JSON.parse(material.text);
    return material.text === canonicalJson(value) ? value : undefined;
  } catch { return undefined; } // A malformed optional envelope confers no control identity.
}

export function readCentralAdvisoryCatalogMaterial(material: CentralRuntimeMaterial): CentralAdvisoryCatalogBody | undefined {
  const value = body(material, CENTRAL_ADVISORY_CATALOG_PREFIX);
  return catalogBody(value) && canonicalJson(material.sourceRefs) === canonicalJson(value.entries.map(entry => entry.version)) ? value : undefined;
}

export function readCentralAdvisoryResultMaterial(material: CentralRuntimeMaterial): CentralAdvisoryResultBody | undefined {
  const value = body(material, CENTRAL_ADVISORY_RESULT_MATERIAL_PREFIX);
  return resultBody(value) && canonicalJson(material.sourceRefs) === canonicalJson([value.resultRef]) ? value : undefined;
}

/** Presentation role only. Access ancestry separately authenticates the exact
 * original Board material; this guard grants neither body access nor evidence. */
export function isCentralAdvisoryContextMaterial(material: CentralRuntimeMaterial): boolean {
  return readCentralAdvisoryCatalogMaterial(material) !== undefined || readCentralAdvisoryResultMaterial(material) !== undefined;
}
