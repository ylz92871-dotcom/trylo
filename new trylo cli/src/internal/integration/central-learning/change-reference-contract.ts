import type { CentralRuntimeMaterial } from "../../learning/central/runtime/contracts.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { fields } from "../../validation/json-shape.js";
import type { CentralInputKind } from "./deliberation-input-dictionary.js";

export type CentralChangeReferenceCategory = "source" | "read" | "intent" | "opportunity"
  | "citation" | "recall" | "knowledge" | "feedback";

const referenceKinds: Readonly<Record<CentralChangeReferenceCategory, readonly CentralInputKind[]>> = Object.freeze({
  source: Object.freeze(["source", "reference", "span", "intent", "operation", "opportunity",
    "organization_recall", "organization_feedback", "organization_revision", "organization_knowledge"] as const),
  read: Object.freeze(["read"] as const),
  intent: Object.freeze(["intent"] as const),
  opportunity: Object.freeze(["opportunity"] as const),
  citation: Object.freeze(["source", "span"] as const),
  recall: Object.freeze(["organization_recall"] as const),
  knowledge: Object.freeze(["organization_revision"] as const),
  feedback: Object.freeze(["organization_feedback"] as const),
});

/** These are the existing accessor capabilities, not evidence or permission grants. */
export function centralReferenceKinds(category: CentralChangeReferenceCategory): readonly CentralInputKind[] {
  return referenceKinds[category];
}

type ReferenceKind = CentralInputKind | "checkpoint";

const kinds: readonly ReferenceKind[] = ["source", "read", "intent", "operation", "opportunity", "organization_recall",
  "organization_feedback", "organization_knowledge", "organization_revision", "reference", "span", "checkpoint"];
const causes = ["unknown_handle", "kind_mismatch", "quote_not_exact", "quote_required", "checkpoint_missing",
  "checkpoint_mismatch", "unavailable_handle"] as const;
const fieldTokens = new Set(["checkpoint", "changes", "inspect", "refs", "sources", "subject", "target", "set", "next",
  "grounding", "parents", "citations", "source", "quote", "knowledge", "support", "counterexamples",
  "organizationKnowledge", "organizationUse", "recall"]);
const decimal = /^(?:0|[1-9]\d*)$/;
const handleFormat = /^[briopcfkves](?:[1-9]\d*|[a-f0-9]{12}_[1-9a-z][0-9a-z]*)$/;
const referenceKind = (value: unknown): value is ReferenceKind => typeof value === "string" && kinds.some(kind => kind === value);

export interface CentralChangeReferenceRejection {
  readonly schemaVersion: 1;
  /** A host-generated JSON pointer with fixed field tokens and array indices. */
  readonly field: string;
  readonly expected: readonly ReferenceKind[];
  readonly actual: ReferenceKind | "unknown";
  readonly cause: typeof causes[number];
  /** The caller may include only a handle found in the original bound dictionary. */
  readonly handle?: string;
}

function referenceField(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 256 || !value.startsWith("/")) return false;
  return value.slice(1).split("/").every(token => fieldTokens.has(token) || decimal.exec(token)?.[0] === token);
}

/** No caller values, quotations, parser prose or unknown extensions are admitted. */
export function isCentralChangeReferenceRejection(value: unknown): value is CentralChangeReferenceRejection {
  const optional = typeof value === "object" && value !== null && Object.hasOwn(value, "handle") ? ["handle"] : [];
  const keys = ["schemaVersion", "field", "expected", "actual", "cause", ...optional];
  if (!fields(value, keys) || Reflect.ownKeys(value).length !== keys.length || value.schemaVersion !== 1
    || !referenceField(value.field) || !Array.isArray(value.expected) || value.expected.length < 1 || value.expected.length > 11
    || Reflect.ownKeys(value.expected).length !== value.expected.length + 1
    || !Array.from(value.expected).every(referenceKind) || new Set(value.expected).size !== value.expected.length
    || !(value.actual === "unknown" || referenceKind(value.actual)) || !causes.some(cause => cause === value.cause)) return false;

  return optional.length === 0 || typeof value.handle === "string" && value.handle.length <= 256
    && handleFormat.exec(value.handle)?.[0] === value.handle;
}

export const CENTRAL_REFERENCE_SELECTION_CONTRACT_SPEC = Object.freeze({
  schemaVersion: 1,
  role: "host_reference_selection_contract_not_business_evidence",
  inputVersion: "central-learning-change-input-v4",
  encoding: "typed_decimal_per_kind",
  binding: "single_selection_code_bound_to_private_checkpoint",
  selectionCode: "checkpoint_prefix_12hex_once",
  schemaSelection: "current_typed_enums",
  rejection: "host_field_kind_no_raw_values",
} as const);

export const CENTRAL_REFERENCE_SELECTION_CONTRACT_REF =
  `central-runtime-constraint:reference-selection:${contentHashOf(CENTRAL_REFERENCE_SELECTION_CONTRACT_SPEC)}`;

/** Wire encoding only; the original dictionary authority still binds the request. */
export function centralReferenceSelectionCode(dictionary: { readonly checkpoint: string;
  readonly referenceSelectionContractRef?: string }): string | undefined {
  if (dictionary.referenceSelectionContractRef !== CENTRAL_REFERENCE_SELECTION_CONTRACT_REF
    || typeof dictionary.checkpoint !== "string") return undefined;
  const checkpoint = /^central-input-checkpoint:([a-f0-9]{64})$/.exec(dictionary.checkpoint);
  return checkpoint !== null && checkpoint[0] === dictionary.checkpoint ? checkpoint[1]!.slice(0, 12) : undefined;
}

export type CentralReferenceSelectionDescriptor = typeof CENTRAL_REFERENCE_SELECTION_CONTRACT_SPEC & {
  readonly contractRef: string;
};

/** This host constraint explains reference selection; it is not business grounding. */
export function createCentralReferenceSelectionCapability(): CentralRuntimeMaterial {
  return { ref: CENTRAL_REFERENCE_SELECTION_CONTRACT_REF, kind: "source", sourceRefs: [],
    text: canonicalJson({ ...CENTRAL_REFERENCE_SELECTION_CONTRACT_SPEC, contractRef: CENTRAL_REFERENCE_SELECTION_CONTRACT_REF }) };
}

export function readCentralReferenceSelectionCapability(material: CentralRuntimeMaterial): CentralReferenceSelectionDescriptor | undefined {
  if (!fields(material, ["ref", "kind", "sourceRefs", "text"]) || Reflect.ownKeys(material).length !== 4
    || !Array.isArray(material.sourceRefs) || material.sourceRefs.length !== 0 || Reflect.ownKeys(material.sourceRefs).length !== 1) return undefined;
  try {
    if (canonicalJson(material) !== canonicalJson(createCentralReferenceSelectionCapability())) return undefined;
  } catch { return undefined; } // A malformed material cannot claim the host descriptor.
  return { ...CENTRAL_REFERENCE_SELECTION_CONTRACT_SPEC, contractRef: CENTRAL_REFERENCE_SELECTION_CONTRACT_REF };
}
