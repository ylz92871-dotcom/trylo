import type { CentralDeliberationRequest } from "../../learning/central/runtime/contracts.js";
import type { JsonObject, JsonValue } from "../../protocol/envelope.js";
import type { CentralChangeInputDictionary } from "./change-input-contract.js";
import { centralLearningChangeSchema } from "./change-schema.js";
import { CENTRAL_SINGLE_ACTION_FIELDS, type CentralSingleAction } from "./change-single-action-contract.js";
import { centralSingleActionGrammarText } from "./change-single-action-grammar-text.js";
import { CENTRAL_RUNTIME_LIMITS } from "../../learning/central/runtime/validation.js";
import { CENTRAL_ADVISORY_PUBLICATION_PREFIX } from "./central-advisory-contracts.js";

type Schema = Record<string, JsonValue>;

const invalid = (): never => { throw new Error("central_action_tool_schema_invalid"); };

function node(value: JsonValue | undefined): Schema {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return invalid();
  return value as Schema;
}

const fields = (schema: JsonObject): Schema => node(schema.properties);
const reference = (name: string): JsonObject => ({ $ref: `#/definitions/${name}` });
const closed = (properties: JsonObject, required: readonly string[]): JsonObject =>
  ({ type: "object", properties, required, additionalProperties: false });

function required(schema: JsonObject): readonly string[] {
  if (!Array.isArray(schema.required) || schema.required.some(value => typeof value !== "string")) return invalid();
  return schema.required as readonly string[];
}

function select(properties: JsonObject, names: readonly string[]): Schema {
  const selected: Schema = {};
  for (const name of names) {
    if (properties[name] === undefined) return invalid();
    selected[name] = properties[name]!;
  }
  return selected;
}

/** Translate reference spelling once; definitions stay shared on the native
 * draft-7 wire rather than being expanded into every action alternative. */
function draftSeven(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(draftSeven);

  if (typeof value !== "object" || value === null) return value;

  const result: Schema = {};

  for (const [key, member] of Object.entries(value)) result[key === "$defs" ? "definitions" : key] =
    key === "$ref" && typeof member === "string" && member.startsWith("#/$defs/")
      ? member.replace("#/$defs/", "#/definitions/") : draftSeven(member);

  return result;
}

function define(definitions: Schema, name: string, schema: JsonObject): JsonObject {
  if (definitions[name] !== undefined) return invalid();
  definitions[name] = schema;
  return reference(name);
}

/** The canonical advert supplies scoped leaves and capability gates. Its next
 * advert is intentionally flat; here its existing tagged parser shapes become
 * explicit alternatives for both the text and the non-strict tool advert. */
function preciseNext(definitions: Schema): void {
  if (definitions.next === undefined) return;

  const properties = fields(node(definitions.next)), kinds = node(properties.kind).enum;
  if (!Array.isArray(kinds)) return invalid();

  const allowance = define(definitions, "allowance", node(properties.allowance));
  const destination = define(definitions, "destination", node(properties.destination));
  const leaves = { ...properties, allowance, destination }, alternatives: JsonObject[] = [];
  const add = (kind: string, name: string, mandatory: readonly string[], optional: readonly string[] = [], overrides: JsonObject = {}) => {
    if (!kinds.includes(kind)) return;
    const names = ["kind", ...mandatory, ...optional];
    alternatives.push(define(definitions, name, closed({ ...select(leaves, names), kind: { type: "string", enum: [kind] }, ...overrides },
      ["kind", ...mandatory])));
  };
  const meaning = ["purpose", "expectedChange", "sources"];

  add("think", "nextThink", meaning, properties.maxOutputTokens === undefined ? [] : ["maxOutputTokens"]);
  add("read", "nextRead", [...meaning, "refs", "maximumChars"]);
  add("query", "nextQueryKnowledge", [...meaning, "plane", "query", "maximumChars"], [], { plane: { type: "string", enum: ["knowledge"] } });
  add("query", "nextQueryOrganization", [...meaning, "plane", "query", "maximumChars"], ["offset"], { plane: { type: "string", enum: ["organization"] } });
  add("consult", "nextConsult", [...meaning, "allowance"]);
  add("dispatch", "nextDispatch", [...meaning, "allowance"], ["destination"]);
  add("wait", "nextWait", ["for", "sources", "reason"]);
  add("wait_until", "nextWaitUntil", ["at", "sources", "reason"]);
  add("end", "nextEnd", ["goalState", "reason"]);
  definitions.next = { anyOf: alternatives };
}

function variants(schema: JsonObject): Schema[] {
  if (schema.items === undefined) return [];
  const choices = node(schema.items).anyOf;
  if (!Array.isArray(choices)) return invalid();
  return choices.map(node);
}

function tagged(schema: JsonObject, kind: string): boolean {
  const values = node(fields(schema).kind).enum;
  return Array.isArray(values) && values.includes(kind);
}

function allowHostKey(schema: Schema): void {
  schema.required = required(schema).filter(name => name !== "key");
}

function requireCentralGrounding(schema: Schema): void {
  // This is the parser's existing central-subject requirement, not a host
  // judgement about whether a native opportunity should become central.
  schema.allOf = [{ if: { properties: { subject: { const: "central" } }, required: ["subject"] }, then: { required: ["grounding"] } }];
}

/** Only v5's representation omits repeated citation parents. Expansion binds
 * each actual citation source before the unchanged canonical compiler runs. */
function sourceAnchoredGrounding(definitions: Schema): void {
  if (definitions.grounding === undefined) return;
  const grounding = node(definitions.grounding);
  grounding.required = required(grounding).filter(name => name !== "parents");
}

function intentVariants(top: Schema, definitions: Schema): Map<string, Schema> {
  const changes = node(top.changes), byKind = new Map<string, Schema>(), refs: JsonObject[] = [];

  for (const variant of variants(changes)) {
    const kind = ["create", "revise", "end"].find(candidate => tagged(variant, candidate));
    if (kind === undefined) return invalid();
    if (kind === "create") {
      allowHostKey(variant);
      requireCentralGrounding(variant);
    }
    if (kind === "revise") fields(variant).set = define(definitions, "intentFields", node(fields(variant).set));
    byKind.set(kind, variant);
    refs.push(define(definitions, `intent${kind[0]!.toUpperCase()}${kind.slice(1)}`, variant));
  }

  if (refs.length > 0) changes.items = { anyOf: refs };

  return byKind;
}

function organizationDefinitions(top: Schema, definitions: Schema): void {
  if (top.organizationUse !== undefined) top.organizationUse = define(definitions, "organizationUse", node(top.organizationUse));

  if (top.organizationKnowledge === undefined) return;

  const changes = node(top.organizationKnowledge), refs: JsonObject[] = [];

  for (const variant of variants(changes)) {
    const propose = tagged(variant, "propose");
    if (propose) allowHostKey(variant);
    refs.push(define(definitions, propose ? "organizationPropose" : "organizationReviseOrWithdraw", variant));
  }

  changes.items = { anyOf: refs };
  top.organizationKnowledge = define(definitions, "organizationKnowledge", changes);
}

/** A v4 presentation operation expands to the original canonical knowledge
 * array. Advanced deltas keep their existing whole-array contract. */
function knowledgeEditFields(definitions: Schema): JsonObject {
  const entry = define(definitions, "intentKnowledgeEntry", node(node(definitions.knowledge).items));
  const why: JsonObject = { type: "string", minLength: 1 }, target: JsonObject = { type: "integer", minimum: 0 };
  const edits = [
    closed({ kind: { const: "append" }, entry, why }, ["kind", "entry", "why"]),
    closed({ kind: { const: "revise" }, target, entry, why }, ["kind", "target", "entry", "why"]),
    closed({ kind: { const: "withdraw" }, target, why }, ["kind", "target", "why"]),
  ];
  const original = node(definitions.intentFields);

  return define(definitions, "intentKnowledgeEditFields", {
    ...original, properties: { ...fields(original), knowledgeEdits: { type: "array", minItems: 1, items: { anyOf: edits } } },
    not: { required: ["knowledge", "knowledgeEdits"] },
  });
}

function actionBranches(top: Schema, definitions: Schema, intents: ReadonlyMap<string, Schema>, dictionary: CentralChangeInputDictionary): JsonObject[] {
  const branches: JsonObject[] = [], common: Schema = { why: { type: "string" }, checkpoint: reference("checkpoint") };
  const handoffFields: Schema = {
    knowledge: { type: "array", minItems: 1, maxItems: CENTRAL_RUNTIME_LIMITS.statements, uniqueItems: true,
      items: { type: "integer", minimum: 0 } },
    whenRelevant: { type: "string", minLength: 1, maxLength: CENTRAL_RUNTIME_LIMITS.textChars },
    uncertainty: { type: "string", minLength: 1, maxLength: CENTRAL_RUNTIME_LIMITS.textChars },
  };
  const handoff = define(definitions, "knowledgeHandoff", closed(handoffFields, Object.keys(handoffFields)));
  const add = (action: CentralSingleAction, source: JsonObject, mandatory: readonly string[]) => {
    const properties: Schema = { action: { type: "string", enum: [action] }, ...common };
    for (const name of CENTRAL_SINGLE_ACTION_FIELDS[action]) if (source[name] !== undefined) properties[name] = source[name]!;
    if (action === "create" || action === "revise") properties.handoff = handoff;
    const branch = node(closed(properties, ["action", "why", ...mandatory]));
    if (action === "create") requireCentralGrounding(branch);
    branches.push(define(definitions, `action${action[0]!.toUpperCase()}${action.slice(1)}`, branch));
  };

  if (top.inspect !== undefined) {
    const inspection = node(top.inspect), inspectionFields = fields(inspection);
    inspectionFields.refs = { ...node(inspectionFields.refs), minItems: 1 };
    add("read", inspectionFields, ["refs"]);
    add("inspect", inspectionFields, ["refs"]);
    top.inspect = define(definitions, "inspection", inspection);
  }

  for (const kind of ["create", "revise", "end"] as const) {
    const variant = intents.get(kind);
    if (variant === undefined) continue;
    const actionFields = kind === "revise" ? { ...fields(variant), set: knowledgeEditFields(definitions) } : fields(variant);
    add(kind, actionFields, required(variant).filter(name => !["kind", "why", "key"].includes(name)));
    if (kind === "revise") add("continue", { target: fields(variant).target!, next: reference("next") }, ["target", "next"]);
  }

  add("none", {}, []);
  add("organize", top, []);
  const targets = dictionary.selectionHandles?.("intent") ?? [];
  if (targets.length > 0) branches.push(define(definitions, "actionHandoff", closed({
    action: { const: "handoff" }, ...common, target: { type: "string", enum: [...targets] }, ...handoffFields,
  }, ["action", "why", "target", ...Object.keys(handoffFields)])));

  const publications = dictionary.entries.filter(entry => entry.kind === "source" || entry.kind === "read").map(entry => entry.handle)
    .filter(handle => (dictionary.source(handle) ?? dictionary.read(handle))?.startsWith(CENTRAL_ADVISORY_PUBLICATION_PREFIX));
  if (publications.length > 0) branches.push(define(definitions, "actionWithdrawHandoff", closed({
    action: { const: "withdraw_handoff" }, ...common, publication: { type: "string", enum: publications },
  }, ["action", "why", "publication"])));

  return branches;
}

/** Remove only unreachable schema aliases, never a delivered capability. */
function reachableDefinitions(root: JsonObject, definitions: Schema): Schema {
  const result: Schema = {};
  const visit = (value: JsonValue): void => {
    if (Array.isArray(value)) {
      for (const member of value) visit(member);
      return;
    }

    if (typeof value !== "object" || value === null) return;

    const schema = value as JsonObject;
    if (typeof schema.$ref === "string") {
      const prefix = "#/definitions/";
      if (!schema.$ref.startsWith(prefix)) return invalid();

      const name = schema.$ref.slice(prefix.length);
      if (result[name] === undefined) {
        if (definitions[name] === undefined) return invalid();
        result[name] = definitions[name]!;
        visit(definitions[name]!);
      }
    }

    for (const member of Object.values(schema)) visit(member);
  };

  visit(root);
  return result;
}

/** One request-scoped structural AST serves typed text and a native, non-strict
 * function schema. The original compiler remains final authority for meaning,
 * evidence, lifecycle, permission and all canonical numeric/size limits. */
export function centralSingleActionGrammar(request: CentralDeliberationRequest,
  dictionary: CentralChangeInputDictionary): { readonly schema: JsonObject; readonly text: string } {
  dictionary.assertRequest(request);
  const canonical = node(draftSeven(centralLearningChangeSchema(request, dictionary, "central-learning-change-input-v4")));
  const top = fields(canonical), definitions = canonical.definitions === undefined ? {} : node(canonical.definitions);

  sourceAnchoredGrounding(definitions);
  preciseNext(definitions);
  const intents = intentVariants(top, definitions);

  organizationDefinitions(top, definitions);

  if (top.checkpoint === undefined) return invalid();

  top.checkpoint = define(definitions, "checkpoint", node(top.checkpoint));
  const branches = actionBranches(top, definitions, intents, dictionary);
  const advanced = closed(top, required(canonical).filter(name => name !== "checkpoint"));

  branches.push(define(definitions, "advanced", advanced));
  const root: JsonObject = { type: "object", anyOf: branches };
  const schema: JsonObject = { ...root, definitions: reachableDefinitions(root, definitions) };

  return { schema, text: centralSingleActionGrammarText(schema) };
}
