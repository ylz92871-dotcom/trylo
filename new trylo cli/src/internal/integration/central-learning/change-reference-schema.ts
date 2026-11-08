import type { JsonObject, JsonValue } from "../../protocol/envelope.js";
import type { CentralChangeInputDictionary } from "./change-input-contract.js";
import { CENTRAL_REFERENCE_SELECTION_CONTRACT_REF, centralReferenceKinds, centralReferenceSelectionCode,
  type CentralChangeReferenceCategory } from "./change-reference-contract.js";

type MutableJsonObject = Record<string, JsonValue>;

function node(value: unknown): MutableJsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("central_reference_schema_invalid");
  return value as MutableJsonObject;
}

const properties = (value: JsonObject): MutableJsonObject => node(value.properties);
const array = (items: JsonObject): JsonObject => ({ type: "array", items });
const object = (fields: JsonObject, required = Object.keys(fields)): JsonObject =>
  ({ type: "object", properties: fields, required, additionalProperties: false });
const kinds = (value: JsonObject): readonly unknown[] => {
  const possible = node(properties(value).kind).enum;
  return Array.isArray(possible) ? possible : [];
};

/** Replace reference slots only. Semantic prose, user keys and the original
 * action meanings remain the same; legacy schemas never enter this function. */
export function scopeCentralChangeReferenceSchema(schema: JsonObject, dictionary: CentralChangeInputDictionary): JsonObject {
  const code = centralReferenceSelectionCode(dictionary);
  if (code === undefined || dictionary.referenceSelectionContractRef !== CENTRAL_REFERENCE_SELECTION_CONTRACT_REF
    || dictionary.selectionHandles === undefined || dictionary.handleKind === undefined) throw new Error("central_reference_schema_unavailable");

  const result = node(structuredClone(schema)), top = properties(result), definitions = result.$defs === undefined ? {} : node(result.$defs);
  const menus = new Map<CentralChangeReferenceCategory, readonly string[]>();
  const names: Readonly<Record<CentralChangeReferenceCategory, string>> = { source: "sourceHandle", read: "readHandle", intent: "intentHandle",
    opportunity: "opportunityHandle", citation: "citationHandle", recall: "recallHandle", knowledge: "knowledgeHandle", feedback: "feedbackHandle" };

  for (const category of Object.keys(names) as CentralChangeReferenceCategory[]) {
    const choices = dictionary.selectionHandles(category), allowed = centralReferenceKinds(category);
    if (new Set(choices).size !== choices.length || choices.some(handle => {
      const kind = dictionary.handleKind!(handle);
      return kind === undefined || !allowed.includes(kind);
    })) throw new Error("central_reference_schema_unavailable");
    menus.set(category, choices);
    if (choices.length > 0) definitions[names[category]] = { type: "string", enum: [...choices] };
  }

  const choices = (category: CentralChangeReferenceCategory) => menus.get(category)!;
  const reference = (category: CentralChangeReferenceCategory): JsonObject => {
    if (choices(category).length === 0) throw new Error("central_reference_schema_empty");
    return { $ref: `#/$defs/${names[category]}` };
  };
  const references = (category: CentralChangeReferenceCategory): JsonObject => choices(category).length === 0
    ? { type: "array", maxItems: 0 } : array(reference(category));
  const scopeSources = (value: JsonObject) => { properties(value).sources = references("source"); };
  const variants = (value: JsonObject): JsonObject[] => {
    if (value.items === undefined) return [];
    const alternatives = node(value.items).anyOf;
    return Array.isArray(alternatives) ? alternatives.map(node) : [];
  };
  const scopedChanges: JsonObject[] = [];

  for (const change of variants(node(top.changes))) {
    const fields = properties(change), selected = kinds(change);
    if (selected.includes("create")) {
      const subjects: JsonObject[] = [];
      if (choices("citation").length > 0) subjects.push({ const: "central" });
      if (choices("opportunity").length > 0) subjects.push(reference("opportunity"));
      if (subjects.length === 0) continue;
      fields.subject = subjects.length === 1 ? subjects[0]! : { anyOf: subjects };
      fields.sources = references("source");
    } else {
      if (choices("intent").length === 0) continue;
      fields.target = reference("intent");
      if (selected.includes("revise")) scopeSources(node(fields.set));
    }

    scopedChanges.push(change);
  }

  top.changes = scopedChanges.length === 0 ? { type: "array", maxItems: 0 } : array({ anyOf: scopedChanges });
  top.checkpoint = { type: "string", enum: [code] };
  result.required = ["checkpoint", ...(Array.isArray(result.required) ? result.required.filter(value => value !== "checkpoint") : [])];
  top.sources = references("source");

  // Top-level next also accepts a new local key from this response, so it must
  // not be restricted to the existing-intent menu.
  if (top.next !== undefined) node(top.next).description = "An advertised intent handle or a new purpose key from this response.";

  if (top.inspect !== undefined) {
    if (choices("read").length === 0) delete top.inspect;
    else {
      const inspect = node(top.inspect);
      scopeSources(inspect);
      properties(inspect).refs = references("read");
    }
  }

  if (definitions.next !== undefined) {
    const next = node(definitions.next), fields = properties(next);
    scopeSources(next);
    fields.refs = references("read");
    if (choices("read").length === 0) {
      const kind = node(fields.kind);
      if (Array.isArray(kind.enum)) kind.enum = kind.enum.filter(value => value !== "read");
    }
  }

  if (definitions.knowledge !== undefined) scopeSources(node(node(definitions.knowledge).items));

  if (definitions.grounding !== undefined) {
    const grounding = properties(node(definitions.grounding));
    grounding.parents = references("source");
    const citations: JsonObject[] = [];
    const bodies = choices("citation").filter(handle => dictionary.handleKind!(handle) === "source");
    const spans = choices("citation").filter(handle => dictionary.handleKind!(handle) === "span");

    if (bodies.length > 0) {
      definitions.citationBodyHandle = { type: "string", enum: bodies };
      citations.push(object({ source: { $ref: "#/$defs/citationBodyHandle" }, quote: { type: "string" } }));
    }

    if (spans.length > 0) {
      definitions.citationSpanHandle = { type: "string", enum: spans };
      citations.push(object({ source: { $ref: "#/$defs/citationSpanHandle" }, quote: { type: "string" } }, ["source"]));
    }

    grounding.citations = citations.length === 0 ? { type: "array", maxItems: 0 } : array({ anyOf: citations });
  }

  if (top.organizationUse !== undefined) {
    if (choices("recall").length === 0 || choices("knowledge").length === 0) delete top.organizationUse;
    else {
      const use = properties(node(top.organizationUse));
      use.recall = reference("recall");
      properties(node(node(use.changes).items)).knowledge = reference("knowledge");
    }
  }

  const organizationChanges: JsonObject[] = [];

  if (top.organizationKnowledge !== undefined) {
    for (const change of variants(node(top.organizationKnowledge))) {
      const fields = properties(change);

      if (kinds(change).includes("propose")) {
        if (choices("feedback").length === 0) continue;
        fields.support = references("feedback");
        fields.counterexamples = references("feedback");
      } else {
        if (choices("knowledge").length === 0) continue;
        fields.target = reference("knowledge");
      }

      organizationChanges.push(change);
    }
    if (organizationChanges.length === 0) delete top.organizationKnowledge;
    else top.organizationKnowledge = array({ anyOf: organizationChanges });
  }

  if (definitions.organizationFields !== undefined) {
    const fields = properties(node(definitions.organizationFields));
    fields.support = references("feedback");
    fields.counterexamples = references("feedback");
  }

  result.$defs = definitions;

  return result;
}
