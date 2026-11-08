import { isRedactedTopicData } from "../learning-topics/confidentiality.js";
import { isLearningIssue, coordinationScopeValid } from "../../learning/control/coordination-parse.js";
import { isContentBatch, isContentPacketInput } from "../../learning/central/content/material-parse.js";
import { readContentPacket } from "../../learning/central/content/material.js";
import type { ContentMaterialBatch, ContentPacketInput } from "../../learning/central/content/material-contract.js";
import { fields } from "../../validation/json-shape.js";
import { isContentSourceContextSafe } from "./content-confidentiality-context.js";
import { isContentValueCredentialSafe } from "./content-confidentiality-leaf.js";
import { isContentHostRecordSafe } from "./content-confidentiality-host.js";
import { contentAssetConfidentialityView } from "./content-confidentiality-asset.js";

export { isContentSourceContextSafe } from "./content-confidentiality-context.js";
export { isContentValueCredentialSafe } from "./content-confidentiality-leaf.js";

export interface TrustedContentIdentity { readonly scope: string }

/** Canonical structural metadata is checked separately from prose. Only the exact
 * trusted scope is admitted at validated scope fields; arbitrary JSON strings are never parsed. */
export function isContentDataSafe(value: unknown, trusted: TrustedContentIdentity, secrets: readonly string[]): boolean {
  if (!coordinationScopeValid(trusted.scope) || !isContentValueCredentialSafe(trusted.scope, secrets)
    || !isContentValueCredentialSafe(value, secrets)) return false;

  const active = new Set<object>();
  return safe(value);

  function safe(current: unknown): boolean {
    if (isContentPacketInput(current)) return packet(current);

    const persisted = readContentPacket(current);
    if (persisted.ok) return packet(persisted.value);

    if (isContentBatch(current) && fields(current, ["records", "requirements", "answers", "materials",
      ...(Object.hasOwn(current, "aliases") ? ["aliases"] : [])])) return batch(current);

    if (isLearningIssue(current)) return current.scope === trusted.scope
      && isRedactedTopicData({ ...current, scope: "[canonical_scope]" }, secrets);

    if (current !== null && typeof current === "object") {
      if (active.has(current)) return false;
      active.add(current);
      const result = Array.isArray(current) ? current.every(safe) : Object.entries(current)
        .every(([key, member]) => isRedactedTopicData(key, secrets) && safe(member));
      active.delete(current);
      return result;
    }

    return isRedactedTopicData(current, secrets);
  }

  function packet(current: ContentPacketInput): boolean {
    if (current.scope !== trusted.scope || current.focus !== undefined && current.focus.scope !== trusted.scope || !batch(current)) return false;
    // Only these validated authority slots are substituted for the path check. The
    // input itself and its source/citation identity are never rewritten.
    return isRedactedTopicData({ ...current, scope: "[canonical_scope]", records: [], requirements: [], answers: [], materials: [],
      ...(current.focus === undefined ? {} : { focus: { ...current.focus, scope: "[canonical_scope]" } }) }, secrets);
  }

  function batch(current: ContentMaterialBatch): boolean {
    const sourceView = contentAssetConfidentialityView(current, trusted, secrets);
    if (sourceView === undefined) return false;

    current = sourceView;

    if (current.records.some(record => record.scope !== trusted.scope)
      || current.materials.some(material => !isContentSourceContextSafe(material.context, material, current.records, trusted, secrets))) return false;

    if (current.records.some(record => !isContentHostRecordSafe(record, trusted, secrets))) return false;

    return isRedactedTopicData({ records: current.records.map(record => ({ ...record, scope: "[canonical_scope]", text: "[checked_source_text]" })),
      requirements: current.requirements, answers: current.answers,
      materials: current.materials.map(material => ({ ...material, context: "[checked_source_context]" })),
      ...(current.aliases === undefined ? {} : { aliases: current.aliases }) }, secrets);
  }
}
