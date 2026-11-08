import type { JsonObject, JsonValue } from "../../protocol/envelope.js";

function node(value: JsonValue | undefined): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("central_action_tool_schema_invalid");
  return value as JsonObject;
}

function referenceName(value: string): string {
  const prefix = "#/definitions/";
  if (!value.startsWith(prefix)) throw new Error("central_action_tool_schema_invalid");
  return value.slice(prefix.length);
}

/** Render the shared AST rather than maintain a second set of action cards.
 * Reference menus occur once; a referenced handle type is always one string. */
function skeleton(value: JsonValue | undefined): string {
  const schema = node(value);
  if (typeof schema.$ref === "string") return referenceName(schema.$ref);

  if (schema.const !== undefined) return JSON.stringify(schema.const);

  if (Array.isArray(schema.enum)) return schema.enum.map(value => JSON.stringify(value)).join(" | ");

  if (Array.isArray(schema.anyOf)) return schema.anyOf.map(skeleton).join(" | ");

  if (schema.type === "array") {
    if (schema.maxItems === 0) return "[]";
    const item = skeleton(schema.items);
    return `${item.includes(" | ") ? `(${item})` : item}[]${schema.minItems === 1 ? " (nonempty)" : ""}`;
  }

  if (schema.type === "object") {
    const properties = schema.properties === undefined ? {} : node(schema.properties);
    const mandatory = Array.isArray(schema.required) ? schema.required : [];
    const members = Object.entries(properties).map(([name, member]) => `${name}${mandatory.includes(name) ? "" : "?"}:${skeleton(member)}`);
    const conditional = Array.isArray(schema.allOf) ? schema.allOf.map(value => {
      const clause = node(value), condition = node(clause.if), then = node(clause.then);
      const fields = Object.entries(node(condition.properties)).map(([name, member]) => `${name}=${skeleton(member)}`);
      return `if ${fields.join(" and ")}, require ${(Array.isArray(then.required) ? then.required : []).join(",")}`;
    }) : [];

    return `{${members.join(",")}}${schema.minProperties === 1 ? " (at least one field)" : ""}${conditional.length > 0 ? ` (${conditional.join("; ")})` : ""}`;
  }

  if (schema.type === "string" || schema.type === "integer" || schema.type === "number" || schema.type === "boolean") {
    const bounds = [schema.minimum === undefined ? undefined : `>=${schema.minimum}`, schema.maximum === undefined ? undefined : `<=${schema.maximum}`]
      .filter(value => value !== undefined);
    return `${schema.type}${bounds.length === 0 ? "" : `(${bounds.join(",")})`}`;
  }

  throw new Error("central_action_tool_schema_invalid");
}

export function centralSingleActionGrammarText(schema: JsonObject): string {
  const definitions = node(schema.definitions), aliases: string[] = [], choices: string[] = [];

  for (const [name, value] of Object.entries(definitions)) {
    const definition = node(value);
    if (definition.type === "string" && Array.isArray(definition.enum)) {
      aliases.push(`${name}=string (choose one from its menu)`);
      choices.push(`${name}=${JSON.stringify(definition.enum)}`);
    } else aliases.push(`${name}=${skeleton(definition)}`);
  }

  return [
    "Typed structure: choose exactly one Decision branch. Fields are closed; ? means optional; [] means an array. A handle/target/subject is ONE string, never its menu array.",
    `Decision=${skeleton({ anyOf: schema.anyOf! })}`,
    ...aliases,
    "The advanced branch has no action. Its next? is a string selecting priority; create.next, continue.next and revise.set.next use the next object union. Omitted checkpoint and new create/propose key are host-bound; no target is inferred.",
    "Menus below list available scalar values, not values to copy as arrays:",
    ...choices,
  ].join("\n");
}
