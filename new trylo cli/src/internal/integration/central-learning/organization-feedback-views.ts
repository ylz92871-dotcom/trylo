import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import type { CentralRuntimeMaterial } from "../../learning/central/runtime/contracts.js";
import type { OrganizationFeedback, OrganizationStored } from "../../learning/central/organization/contracts.js";
import { createOrganizationFeedbackMaterial } from "./organization-feedback-material.js";

export type OrganizationFeedbackRelation = "produced_by" | "selected_by" | "related_background";

export interface OrganizationFeedbackBinding {
  readonly row: OrganizationStored<OrganizationFeedback>;
  readonly relation: OrganizationFeedbackRelation;
}

/** The same original unit across decisions is one source observation. Deliver
 * one complete canonical body; other immutable projections have exact read refs. */
export function organizationFeedbackViews(scope: string, bindings: readonly OrganizationFeedbackBinding[]): readonly CentralRuntimeMaterial[] {
  const groups = new Map<string, OrganizationFeedbackBinding[]>();

  for (const binding of bindings) {
    const { decisionRef: _decision, supersedes: _revision, ...unit } = binding.row.value;
    const key = canonicalJson(unit), rows = groups.get(key) ?? [];
    rows.push(binding);
    groups.set(key, rows);
  }

  const materials: CentralRuntimeMaterial[] = [];
  const rank = { produced_by: 0, selected_by: 1, related_background: 2 } as const;

  for (const rows of groups.values()) {
    rows.sort((a, b) => rank[a.relation] - rank[b.relation] || a.row.sequence - b.row.sequence);
    const representative = rows[0]!;

    materials.push(createOrganizationFeedbackMaterial(scope, representative.row.factId, representative.row.value));

    for (let offset = 0; offset < rows.length; offset += 16) {
      const entries = rows.slice(offset, offset + 16).map(({ row, relation }) => ({ decisionRef: row.value.decisionRef,
        relation, factId: row.factId, readRef: row.factId }));
      const text = canonicalJson({ role: "organization_feedback_relationship_catalog_not_read_body",
        unitRef: representative.row.value.unitRef, resultKind: representative.row.value.result.kind,
        representativeFactId: representative.row.factId, entries,
        interpretation: "These are original source relationships, not separate executions, independent samples, causal credit or identified net benefit. Only the complete delivered canonical body establishes its feedback citation identity; read another fact before citing it." });

      materials.push({ ref: `organization-feedback-relations:${contentHashOf(text)}`, kind: "organization", text,
        sourceRefs: [...new Set(entries.map(entry => entry.factId))] });
    }
  }

  return materials;
}

/** Related issue membership is background only. It does not duplicate a source
 * unit or turn every later thought into a producer of an earlier artifact. */
export function organizationFeedbackBackground(issueId: string, decisionRefs: readonly string[]): readonly CentralRuntimeMaterial[] {
  const materials: CentralRuntimeMaterial[] = [];

  for (let offset = 0; offset < decisionRefs.length; offset += 16) {
    const entries = decisionRefs.slice(offset, offset + 16).map(decisionRef => ({ decisionRef, relation: "related_background" }));
    const text = canonicalJson({ role: "organization_feedback_relationship_catalog_not_read_body", issueId, entries,
      interpretation: "The original issue is relevant background for these decisions. Membership alone proves no artifact ownership, adoption by that decision, causal contribution or net benefit." });
    materials.push({ ref: `organization-feedback-relations:${contentHashOf(text)}`, kind: "organization", text, sourceRefs: [issueId] });
  }

  return materials;
}
