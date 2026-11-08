import type { JsonObject, JsonValue } from "../../../../../../protocol/envelope.js";
import { isJsonValue, jsonBytes, recordOf } from "../../../../../domains/tool/evolution/parse.js";

export type SchemaSupportFailure = { readonly code: string; readonly path: string; readonly message: string };

export type SupportedSchema = { readonly ok: true; readonly schema: JsonObject; readonly hasStringBounds: boolean }
  | { readonly ok: false; readonly failure: SchemaSupportFailure };

const ANNOTATIONS = new Set(["title", "description", "$comment", "default", "examples", "deprecated", "readOnly", "writeOnly"]);
const KEYWORDS = new Set(["$schema", "$defs", "definitions", "$ref", "type", "enum", "const", "not", "anyOf", "oneOf", "allOf",
  "properties", "required", "additionalProperties", "items", "minItems", "maxItems", "minLength", "maxLength",
  "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"]);
const TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);
const OBJECT_KEYS = ["properties", "required", "additionalProperties"];
const ARRAY_KEYS = ["items", "minItems", "maxItems"];
const STRING_KEYS = ["minLength", "maxLength"];
const NUMBER_KEYS = ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"];

type Context = { readonly defs: Record<string, unknown>; readonly defsKey: "$defs" | "definitions"; nodes: number; hasStringBounds: boolean };

/** Zod's semi-experimental converter ignores some JSON Schema assertions. Admit only an audited subset. */
export function prepareSupportedSchema(raw: JsonObject): SupportedSchema {
  if (!recordOf(raw) || !isJsonValue(raw, 32) || jsonBytes(raw) > 65_536) return invalid("schema_input_invalid", "#", "schema must be bounded plain JSON");

  const { $id, ...schema } = raw;

  if (Object.hasOwn(raw, "$id") && !validRootIdentifier($id)) return invalid("schema_identifier_invalid", "#/$id",
    "root identity must be a bounded absolute URI without credentials or a fragment");

  const dialect = schema.$schema;
  if (dialect !== undefined && dialect !== "https://json-schema.org/draft/2020-12/schema" && dialect !== "http://json-schema.org/draft-07/schema#") {
    return invalid("schema_dialect_unsupported", "#/$schema", "only draft 2020-12 and draft 7 are supported");
  }

  const defsKey = dialect === "http://json-schema.org/draft-07/schema#" ? "definitions" : "$defs";
  if (Object.hasOwn(schema, defsKey === "$defs" ? "definitions" : "$defs")) return invalid("schema_reference_unsupported", "#", "definition vocabulary must match its schema dialect");

  const definitions = schema[defsKey];
  if (definitions !== undefined && !recordOf(definitions)) return invalid("schema_shape_invalid", `#/${defsKey}`, "definitions must be an object");

  const context: Context = { defs: definitions ?? {}, defsKey, nodes: 0, hasStringBounds: false };

  for (const [name, definition] of Object.entries(context.defs)) {
    const failed = visit(definition, `#/${defsKey}/${escapePointer(name)}`, context, new Set([name]));
    if (failed !== undefined) return { ok: false, failure: failed };
  }

  const checked = visit(schema, "#", context, new Set());

  return checked === undefined ? { ok: true, schema: normalize(schema), hasStringBounds: context.hasStringBounds } : { ok: false, failure: checked };
}

/** Root identity is trace metadata only; it must never establish a resolver base or an authorization source. */
function validRootIdentifier(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512
    || !/^[A-Za-z][A-Za-z0-9+.-]*:.+$/u.test(value)
    || !/^[A-Za-z0-9:\/?@!$&'()*+,;=._~%\[\]-]+$/u.test(value) || /%(?![A-Fa-f0-9]{2})/u.test(value)) return false;
  try {
    const identifier = new URL(value);
    return identifier.username.length === 0 && identifier.password.length === 0;
  } catch {
    return false; // Invalid metadata is oracle unavailability, never a structural verdict or a resolver request.
  }
}

function visit(value: unknown, path: string, context: Context, refs: ReadonlySet<string>): SchemaSupportFailure | undefined {
  context.nodes += 1;

  if (context.nodes > 512 || path.length > 2048) return issue("schema_complexity_exceeded", path, "schema graph exceeds its bounded conversion budget");

  if (typeof value === "boolean") return undefined;

  if (!recordOf(value)) return issue("schema_shape_invalid", path, "a schema must be an object or boolean");

  for (const key of Object.keys(value)) {
    if (!KEYWORDS.has(key) && !ANNOTATIONS.has(key)) return issue("schema_keyword_unsupported", `${path}/${escapePointer(key)}`, "this assertion is not implemented by the structural oracle");
  }

  if (path !== "#" && ["$schema", "$defs", "definitions"].some(key => Object.hasOwn(value, key))) {
    return issue("schema_reference_unsupported", path, "nested dialect or definition scopes are unsupported");
  }

  const reference = checkReference(value, path, context, refs);
  if (reference !== undefined || Object.hasOwn(value, "$ref")) return reference;

  const local = checkLocalAssertions(value, path, context);
  if (local !== undefined) return local;

  const children: { readonly schema: unknown; readonly path: string; readonly refs: ReadonlySet<string> }[] = [];

  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    const branches = value[key];
    if (branches === undefined) continue;
    if (!Array.isArray(branches) || branches.length === 0 || branches.length > 32) return issue("schema_shape_invalid", `${path}/${key}`, "composition needs 1..32 schema branches");
    branches.forEach((schema, index) => children.push({ schema, path: `${path}/${key}/${index}`, refs }));
  }

  if (recordOf(value.properties)) for (const [name, schema] of Object.entries(value.properties)) children.push({ schema, path: `${path}/properties/${escapePointer(name)}`, refs });

  for (const key of ["items", "additionalProperties"]) if (value[key] !== undefined) children.push({ schema: value[key], path: `${path}/${key}`, refs });

  for (const child of children) {
    const failed = visit(child.schema, child.path, context, child.refs);
    if (failed !== undefined) return failed;
  }

  return undefined;
}

function checkReference(value: Record<string, unknown>, path: string, context: Context, refs: ReadonlySet<string>): SchemaSupportFailure | undefined {
  if (!Object.hasOwn(value, "$ref")) return undefined;

  if (Object.keys(value).some(key => key !== "$ref" && key !== context.defsKey && !ANNOTATIONS.has(key) && !(path === "#" && key === "$schema"))) {
    return issue("schema_reference_unsupported", path, "$ref siblings with assertions are unsupported");
  }

  const match = typeof value.$ref === "string" ? /^#\/(\$defs|definitions)\/([^/~]+)$/u.exec(value.$ref) : null;
  const name = match?.[2];
  if (match?.[1] !== context.defsKey || name === undefined || !Object.hasOwn(context.defs, name) || !recordOf(context.defs[name])) {
    return issue("schema_reference_unresolved", `${path}/$ref`, "only direct local object definitions can be resolved");
  }

  if (refs.has(name)) return issue("schema_reference_cycle", `${path}/$ref`, "recursive definitions are outside this bounded oracle");

  return visit(context.defs[name], `#/${context.defsKey}/${escapePointer(name)}`, context, new Set([...refs, name]));
}

function checkLocalAssertions(value: Record<string, unknown>, path: string, context: Context): SchemaSupportFailure | undefined {
  const types = readTypes(value.type);
  if (types === undefined) return issue("schema_shape_invalid", `${path}/type`, "type must be one JSON type or a nonempty unique type array");

  const object = checkObject(value, path, types, context);
  if (object !== undefined) return object;

  const bounds = checkBounds(value, path, types);
  if (bounds !== undefined) return bounds;

  if (types.length === 0 && ["anyOf", "oneOf", "allOf"].filter(key => value[key] !== undefined).length > 1) {
    return issue("schema_combination_unsupported", path, "untyped mixed composition would be weakened by the installed converter");
  }

  if (STRING_KEYS.some(key => value[key] !== undefined)) context.hasStringBounds = true;

  if (value.not !== undefined && (!recordOf(value.not) || Object.keys(value.not).length !== 0)) return issue("schema_keyword_unsupported", `${path}/not`, "only not:{} is supported");

  if (Object.hasOwn(value, "enum") || Object.hasOwn(value, "const")) {
    const enumeration = checkEnumeration(value, path, types);
    if (enumeration !== undefined) return enumeration;
  }

  if (value.items !== undefined && (Array.isArray(value.items) || (typeof value.items !== "boolean" && !recordOf(value.items)))) {
    return issue("schema_shape_invalid", `${path}/items`, "only a homogeneous item schema is supported");
  }

  return undefined;
}

function checkObject(value: Record<string, unknown>, path: string, types: readonly string[], context: Context): SchemaSupportFailure | undefined {
  if (OBJECT_KEYS.some(key => value[key] !== undefined) && !types.includes("object")) return issue("schema_type_required", path, "object assertions need an explicit object type");

  if (value.properties !== undefined && !recordOf(value.properties)) return issue("schema_shape_invalid", `${path}/properties`, "properties must be a schema map");

  const properties = recordOf(value.properties) ? value.properties : {};
  if (Object.keys(properties).some(key => ["__proto__", "constructor", "prototype"].includes(key))) return issue("schema_property_unsupported", `${path}/properties`, "prototype-named properties are unsupported by the converter");

  if (value.additionalProperties !== undefined && typeof value.additionalProperties !== "boolean" && !recordOf(value.additionalProperties)) {
    return issue("schema_shape_invalid", `${path}/additionalProperties`, "additionalProperties must be a schema or boolean");
  }

  if (value.required !== undefined) {
    if (!Array.isArray(value.required) || !value.required.every(name => typeof name === "string") || new Set(value.required).size !== value.required.length) {
      return issue("schema_shape_invalid", `${path}/required`, "required must contain unique property names");
    }
    for (const name of value.required) {
      if (!Object.hasOwn(properties, name) || !requiresPresence(properties[name], context)) return issue("schema_required_unsupported", `${path}/required`, "required properties need an explicit typed or primitive-literal schema");
    }
  }

  return undefined;
}

function checkBounds(value: Record<string, unknown>, path: string, types: readonly string[]): SchemaSupportFailure | undefined {
  for (const [keys, type] of [[ARRAY_KEYS, "array"], [STRING_KEYS, "string"], [NUMBER_KEYS, "number"]] as const) {
    if (!keys.some(key => value[key] !== undefined)) continue;

    if (!types.includes(type) && !(type === "number" && types.includes("integer"))) return issue("schema_type_required", path, `${type} assertions need an explicit matching type`);

    for (const key of keys.filter(name => name !== "items")) {
      const bound = value[key];
      if (bound !== undefined && (typeof bound !== "number" || !Number.isFinite(bound)
        || (type !== "number" && (!Number.isSafeInteger(bound) || bound < 0)))) return issue("schema_shape_invalid", `${path}/${key}`, "bound has an invalid numeric shape");
    }
  }
  return undefined;
}

function checkEnumeration(value: Record<string, unknown>, path: string, types: readonly string[]): SchemaSupportFailure | undefined {
  const literals = Object.hasOwn(value, "enum") ? value.enum : [value.const];

  if (Object.hasOwn(value, "enum") && Object.hasOwn(value, "const")) return issue("schema_combination_unsupported", path, "enum and const cannot be combined in this oracle");

  if (!Array.isArray(literals) || literals.length === 0 || literals.length > 128 || literals.some(item => typeof item === "object" && item !== null)
    || new Set(literals.map(item => JSON.stringify(item))).size !== literals.length
    || literals.some(item => item === undefined || !matchesTypes(item, types))) return issue("schema_enumeration_unsupported", path, "literals must be unique primitives and agree with the declared type");

  const allowed = new Set(["type", "enum", "const", "$schema", "$defs", "definitions", ...ANNOTATIONS]);
  if (Object.keys(value).some(key => !allowed.has(key))) return issue("schema_combination_unsupported", path, "literal schemas with other assertions are unsupported");

  return undefined;
}

function readTypes(value: unknown): readonly string[] | undefined {
  if (value === undefined) return [];
  const types = typeof value === "string" ? [value] : value;
  return Array.isArray(types) && types.length > 0 && types.every(type => typeof type === "string" && TYPES.has(type))
    && new Set(types).size === types.length ? types : undefined;
}

function requiresPresence(value: unknown, context: Context, refs: ReadonlySet<string> = new Set()): boolean {
  if (!recordOf(value)) return value === false;

  if (value.$ref !== undefined) {
    const match = typeof value.$ref === "string" ? /^#\/(\$defs|definitions)\/([^/~]+)$/u.exec(value.$ref) : null;
    const name = match?.[2];
    return match?.[1] === context.defsKey && name !== undefined && !refs.has(name)
      && requiresPresence(context.defs[name], context, new Set([...refs, name]));
  }

  return (readTypes(value.type)?.length ?? 0) > 0 || value.enum !== undefined || Object.hasOwn(value, "const") || value.not !== undefined;
}

function matchesTypes(value: unknown, types: readonly string[]): boolean {
  return types.length === 0 || types.some(type => type === "null" ? value === null : type === "integer" ? typeof value === "number" && Number.isSafeInteger(value)
    : type === "number" ? typeof value === "number" : type === "object" || type === "array" ? false : typeof value === type);
}

/** JSON Schema default/readOnly annotations must never fill, freeze or repair the checked output. */
function normalize(value: JsonObject): JsonObject {
  const result: Record<string, JsonValue> = Object.create(null);

  for (const [key, child] of Object.entries(value)) {
    if (ANNOTATIONS.has(key)) continue;
    if (key === "properties" || key === "$defs" || key === "definitions") {
      const map: Record<string, JsonValue> = Object.create(null);
      for (const [name, schema] of Object.entries(child as JsonObject)) map[name] = typeof schema === "boolean" ? schema : normalize(schema as JsonObject);
      result[key] = map;
    } else if (["allOf", "anyOf", "oneOf"].includes(key)) result[key] = (child as readonly JsonValue[]).map(schema => typeof schema === "boolean" ? schema : normalize(schema as JsonObject));
    else if (["items", "additionalProperties"].includes(key)) result[key] = typeof child === "boolean" ? child : normalize(child as JsonObject);
    else result[key] = child;
  }

  const types = readTypes(value.type) ?? [];
  if (types.includes("array") && value.items === undefined) result.items = {};

  return result;
}

function issue(code: string, path: string, message: string): SchemaSupportFailure { return { code, path, message }; }

function invalid(code: string, path: string, message: string): SupportedSchema { return { ok: false, failure: issue(code, path, message) }; }

function escapePointer(value: string): string { return value.replaceAll("~", "~0").replaceAll("/", "~1"); }
