import type { CentralDeliberationRequest } from "../../learning/central/runtime/contracts.js";
import { centralJudgmentControlRefs } from "../../learning/central/runtime/judgment.js";
import { CENTRAL_RUNTIME_LIMITS } from "../../learning/central/runtime/validation.js";
import type { CentralChangeGrounding, CentralLearningChange } from "./change-contract.js";
import type { CentralChangeInputDictionary } from "./change-input-contract.js";
import { centralReferenceKinds } from "./change-reference-contract.js";
import { bindCentralChangeReference, validateCentralChangeSelection } from "./change-reference-resolve.js";
import { readCentralLearningChange } from "./change-parse.js";
import { CentralDeliberationError } from "./deliberation-contract.js";
import { centralInputMaterials } from "./deliberation-input-sources.js";
import { isCentralSourceAnchorControl } from "./change-source-anchor-material.js";

function record(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null) && Reflect.ownKeys(value).length === Object.keys(value).length;
}

/** Supply only v5's omitted optional context-parent array. Invalid supplied
 * values, unknown fields, sparse arrays and explicit quote presence survive for
 * the unchanged canonical shape guard rather than being repaired or erased. */
function optionalParents(value: unknown): unknown {
  if (!record(value) || !Array.isArray(value.changes)
    || Reflect.ownKeys(value.changes).length !== value.changes.length + 1) return value;

  for (let index = 0; index < value.changes.length; index++) if (!Object.hasOwn(value.changes, index)) return value;

  const grounding = (candidate: unknown): unknown => record(candidate) && !Object.hasOwn(candidate, "parents")
    ? { ...candidate, parents: [] } : candidate;

  return { ...value, changes: value.changes.map((change: unknown) => {
    if (!record(change)) return change;
    if (change.kind === "create" && Object.hasOwn(change, "grounding")) return { ...change, grounding: grounding(change.grounding) };
    if (change.kind === "revise" && record(change.set) && Object.hasOwn(change.set, "grounding")) {
      return { ...change, set: { ...change.set, grounding: grounding(change.set.grounding) } };
    }
    return change;
  }) };
}

/** v5 only: source-only citations are exact host anchors to the current supplied
 * material, not a model-selected literal quotation or proof of the hypothesis.
 * Original rawChange plus representationVersion retain that distinction. */
export function expandCentralSingleActionSourceAnchoring(value: unknown, request: CentralDeliberationRequest,
  dictionary: CentralChangeInputDictionary): CentralLearningChange {
  dictionary.assertRequest(request);
  const parsed = readCentralLearningChange(optionalParents(value));
  if (!parsed.ok) throw new CentralDeliberationError("central_learning_change_invalid", "returned",
    undefined, undefined, undefined, undefined, undefined, parsed.rejection);

  validateCentralChangeSelection(dictionary, parsed.value.checkpoint, "selection_code");
  const materials = centralInputMaterials(request), byRef = new Map(materials.map(material => [material.ref, material]));
  const judgments = centralJudgmentControlRefs(materials);
  const unavailable = (handle: string, field: string): never => {
    const actual = dictionary.handleKind?.(handle);
    throw new CentralDeliberationError("central_learning_change_handle_unbound", "returned", undefined, undefined, undefined, undefined,
      { schemaVersion: 1, field, expected: centralReferenceKinds("citation"), actual: actual ?? "unknown", cause: "unavailable_handle",
        ...(actual === undefined ? {} : { handle }) });
  };
  const grounding = (input: CentralChangeGrounding, field: string): CentralChangeGrounding => {
    const refs = new Set<string>(), parents: string[] = [];
    const parent = (handle: string, ref: string) => {
      if (refs.has(ref)) return;
      refs.add(ref);
      parents.push(handle);
      if (parents.length > CENTRAL_RUNTIME_LIMITS.references) throw new CentralDeliberationError("central_learning_change_invalid", "returned",
        undefined, undefined, undefined, undefined, undefined,
        { schemaVersion: 1, stage: "shape", field: `${field}/parents`, expected: "array", actual: "array", cause: "length" });
    };
    const citations = input.citations.map((citation, index) => {
      const at = `${field}/citations/${index}/source`, supplied = Object.hasOwn(citation, "quote");
      const ref = dictionary.source(citation.source), material = ref === undefined ? undefined : byRef.get(ref);
      if (material !== undefined && isCentralSourceAnchorControl(material, judgments, byRef)) return unavailable(citation.source, at);

      // Use only this final packed dictionary's authenticated b/s body. Looking
      // up a source ref does not grant quotation authority; the accessor below
      // rejects navigation, control, stale, deferred and reference-only handles.
      const quote = supplied ? citation.quote : dictionary.handleKind?.(citation.source) === "span" ? undefined : material?.text;
      const bound = bindCentralChangeReference(dictionary, dictionary.citation(citation.source, quote),
        { handle: citation.source, category: "citation", field: at, quoteProvided: supplied });

      parent(citation.source, bound.evidenceRef);

      return supplied ? citation : { ...citation, quote: bound.quote };
    });

    for (const [index, handle] of input.parents.entries()) {
      const ref = bindCentralChangeReference(dictionary, dictionary.source(handle),
        { handle, category: "source", field: `${field}/parents/${index}` });
      parent(handle, ref);
    }

    return { ...input, parents, citations };
  };
  const result = { ...parsed.value, changes: parsed.value.changes.map((change, index) => {
    const field = `/changes/${index}`;
    if (change.kind === "create" && change.grounding !== undefined) return { ...change, grounding: grounding(change.grounding, `${field}/grounding`) };
    if (change.kind === "revise" && change.set.grounding !== undefined) return { ...change,
      set: { ...change.set, grounding: grounding(change.set.grounding, `${field}/set/grounding`) } };
    return change;
  }) };

  dictionary.assertRequest(request);

  return result;
}
