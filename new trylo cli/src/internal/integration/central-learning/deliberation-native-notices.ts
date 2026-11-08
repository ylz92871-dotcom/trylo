import type { CentralRuntimeMaterial } from "../../learning/central/runtime/contracts.js";
import { CENTRAL_LEARNING_AGENT_DOMAINS } from "../../learning/control/coordination-contract.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { fields, text } from "../../validation/json-shape.js";
import type { ContentDomainFeedbackChange } from "../learning-content/sources/domain-feedback-contract.js";

export interface CentralNativeChangeNotice {
  readonly noticeRef: string;
  readonly readRef: string;
  readonly issueId: string;
  readonly domain: ContentDomainFeedbackChange["domain"];
  readonly kind: ContentDomainFeedbackChange["kind"];
}

type CatalogEntry = ContentDomainFeedbackChange & { readonly readRef: string };

const kinds = ["delivery", "adoption", "quality", "correction", "approval", "dependency"];

function isEntry(value: unknown): value is CatalogEntry {
  if (!fields(value, ["domain", "issueId", "factRef", "unitRef", "revisionRef", "kind", "sourceRefs", "readRef"])
    || !CENTRAL_LEARNING_AGENT_DOMAINS.some(domain => domain === value.domain) || !kinds.includes(String(value.kind))
    || ![value.issueId, value.factRef, value.unitRef, value.revisionRef].every(ref => text(ref, 512))
    || !Array.isArray(value.sourceRefs) || !value.sourceRefs.every(ref => text(ref, 512))) return false;
  const { readRef, ...change } = value;
  return readRef === `central-runtime-native-change:${contentHashOf(change)}`;
}

/** A displayed change notice is a read address, never the native feedback body
 * or a verdict about adoption or benefit. Match the original catalog envelope. */
export function selectedCentralNativeNotices(material: CentralRuntimeMaterial,
  selectedRefs: readonly string[]): readonly CentralNativeChangeNotice[] {
  if (material.kind !== "feedback" || material.text.length > 32768
    || material.ref !== `central-runtime-native-catalog:${contentHashOf(material.text)}`) return [];

  let value: unknown;

  try { value = JSON.parse(material.text); } catch { return []; } // Prose is not an original native catalog.

  if (!fields(value, ["role", "entries"]) || value.role !== "original_native_feedback_change_catalog_not_read_body"
    || !Array.isArray(value.entries) || value.entries.length < 1 || value.entries.length > 16 || !value.entries.every(isEntry)
    || canonicalJson(value) !== material.text) return [];

  const entries = value.entries;
  if (new Set(entries.map(row => row.readRef)).size !== entries.length
    || canonicalJson(material.sourceRefs) !== canonicalJson([...new Set(entries.flatMap(row =>
      [row.revisionRef, row.factRef, row.issueId, row.unitRef]))])) return [];

  const selected = new Set(selectedRefs);

  return entries.filter(row => selected.has(row.revisionRef)).map(row => ({ noticeRef: row.revisionRef,
    readRef: row.readRef, issueId: row.issueId, domain: row.domain, kind: row.kind }));
}
