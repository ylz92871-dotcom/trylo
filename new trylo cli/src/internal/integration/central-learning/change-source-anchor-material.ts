import type { CentralRuntimeMaterial } from "../../learning/central/runtime/contracts.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { isCentralCompletedOperation, isCentralLearningIntent, isCentralRuntimeMaterial } from "../../learning/central/runtime/validation.js";
import { CENTRAL_PROVIDER_WAIT_PREFIX, CENTRAL_RESOURCE_WAIT_PREFIX } from "../../learning/central/runtime/resource-waits.js";
import { fields, sequence } from "../../validation/json-shape.js";

// Reserved host identities, never keywords found inside ordinary business text.
// Native failure/use/organization feedback has its own original identity and is
// intentionally not excluded by kind or by the contents of its public prose.
const controlPrefixes = [CENTRAL_RESOURCE_WAIT_PREFIX, CENTRAL_PROVIDER_WAIT_PREFIX,
  "central-semantic-attempt:", "central-semantic-admission:", "central-read-refusal:",
  "central-action-correction-feedback:", "central-resource-change:", "central-runtime-constraint:",
  "normal-provider-success:", "central-provider-positive-admission:", "central-wait-due:", "central-provider-recovery-due:",
  "central-judgment-view-v1:", "central-deliberation-result:"] as const;
const hostControlRef = (ref: string, judgments: ReadonlySet<string>): boolean => judgments.has(ref)
  || controlPrefixes.some(prefix => ref.startsWith(prefix));

/** Additional v5 research-source qualification. Existing dictionary accessors
 * still own actual body exposure and exact quotation admission. Only validated
 * outer host transports are inspected; arbitrary user JSON is left untouched. */
export function isCentralSourceAnchorControl(material: CentralRuntimeMaterial, judgments: ReadonlySet<string>,
  originals: ReadonlyMap<string, CentralRuntimeMaterial>): boolean {
  if (hostControlRef(material.ref, judgments)) return true;

  const page = material.ref.startsWith("central-source-page:");
  const fragment = material.ref.startsWith("central-runtime-fragment:");
  const archive = material.ref.startsWith("central-runtime-archived:");
  if (!page && !fragment && !archive) return false;

  let value: unknown;

  try { value = JSON.parse(material.text); }
  catch { return true; } // A malformed reserved transport cannot grant body authority.

  if (page) {
    // The citation accessor's existing material-role guard verifies the full
    // source-page shape/hash. Recheck the identity before following its links.
    if (typeof value !== "object" || value === null || Array.isArray(value)
      || !("role" in value) || value.role !== "actual_source_fragment_not_full_source"
      || !("ref" in value) || typeof value.ref !== "string"
      || !("originalRef" in value) || typeof value.originalRef !== "string") return true;

    const original: Record<string, unknown> = { ...value };

    delete original.role;
    delete original.complete;
    delete original.nextRef;

    if (material.ref !== `central-source-page:${contentHashOf(original)}`) return true;

    return hostControlRef(value.ref, judgments) || hostControlRef(value.originalRef, judgments);
  }

  if (fragment) {
    if (!fields(value, ["originalRef", "start", "end", "totalChars", "text", "nextRef"])
      || typeof value.originalRef !== "string" || typeof value.text !== "string"
      || !sequence(value.start) || !sequence(value.end) || !sequence(value.totalChars)
      || value.end <= value.start || value.end - value.start !== value.text.length || value.end > value.totalChars
      || !(value.nextRef === null || typeof value.nextRef === "string")
      || material.text !== canonicalJson(value)
      || material.ref !== `central-runtime-fragment:${contentHashOf([value.originalRef, value.start, value.text])}`) return true;

    if (hostControlRef(value.originalRef, judgments)) return true;

    const original = originals.get(value.originalRef);
    if (original !== undefined) return isCentralSourceAnchorControl(original, judgments, originals);

    // A fragment cannot hide an unavailable outer transport's provenance. The
    // original body/page must be read before its source qualification is known.
    return /^(central-source-page:|central-runtime-fragment:|central-runtime-archived:)/.test(value.originalRef);
  }

  if (material.kind !== "work_result" || !fields(value, ["role", "factRef", "value"]) || value.role !== "exact_original_runtime_archive_not_new_evidence"
    || typeof value.factRef !== "string" || material.text !== canonicalJson(value)
    || !material.sourceRefs.includes(value.factRef)
    || material.ref !== `central-runtime-archived:${contentHashOf([value.factRef, value.value])}`) return true;

  if (isCentralRuntimeMaterial(value.value)) return isCentralSourceAnchorControl(value.value, judgments, originals);

  if (isCentralCompletedOperation(value.value)) return value.value.operation.kind === "think";

  return !isCentralLearningIntent(value.value) || value.value.continuation.kind !== "ended";
}
