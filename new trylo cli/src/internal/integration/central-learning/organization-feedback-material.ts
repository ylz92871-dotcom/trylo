import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import type { CentralRuntimeMaterial } from "../../learning/central/runtime/contracts.js";
import type { OrganizationFeedback } from "../../learning/central/organization/contracts.js";
import { buildOrganizationRecord } from "../../learning/central/organization/records.js";
import { isOrganizationFeedback } from "../../learning/central/organization/validation.js";
import { fields, identity } from "../../validation/json-shape.js";

const PREFIX = "organization-feedback-material:";
const ROLE = "source_bound_organization_feedback_not_identified_economic_gain";

/** A source fact and its rendered view have distinct immutable identities. This
 * one renderer is shared by immediate returns, repair and late owner refresh. */
export function createOrganizationFeedbackMaterial(scope: string, factId: string, value: OrganizationFeedback): CentralRuntimeMaterial {
  if (buildOrganizationRecord(scope, value).id !== factId) throw new Error("organization_feedback_material_fact_mismatch");
  const text = canonicalJson({ role: ROLE, factId, value });
  return { ref: `${PREFIX}${contentHashOf({ scope, text })}`, kind: "organization", text,
    sourceRefs: [...new Set([factId, ...value.sourceRefs])] };
}

/** New canonical views prove only their original feedback identity, not an
 * additional sample. Legacy raw/sequence wrappers keep their existing readers. */
export function readOrganizationFeedbackMaterial(material: CentralRuntimeMaterial, scope: string):
  { readonly factId: string; readonly value: OrganizationFeedback } | undefined {
  if (material.kind !== "organization" || !material.ref.startsWith(PREFIX)) return undefined;

  let body: unknown;

  try { body = JSON.parse(material.text); }
  catch { return undefined; } // Incomplete/prose views cannot establish a fact.

  if (!fields(body, ["role", "factId", "value"]) || body.role !== ROLE || !identity(body.factId) || !isOrganizationFeedback(body.value)) return undefined;

  try {
    const expected = createOrganizationFeedbackMaterial(scope, body.factId, body.value);
    if (canonicalJson(material) !== canonicalJson(expected)) return undefined;
  } catch { return undefined; } // Shape-valid data may still exceed original fact capacity.

  return { factId: body.factId, value: body.value };
}
