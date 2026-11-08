import type { CentralDeliberationRequest } from "../../learning/central/runtime/contracts.js";
import type { JsonObject, JsonValue } from "../../protocol/envelope.js";
import type { CentralChangeInputDictionary } from "./change-input-contract.js";
import { centralLearningChangeSchema } from "./change-schema-single-action-v3.js";

// Frozen v1/v2 advert vocabulary. Future presentation actions must not enter old wire proofs.
const CENTRAL_SINGLE_ACTIONS = ["read", "inspect", "create", "revise", "continue", "end", "none", "organize"] as const;

function object(value: JsonValue | undefined): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("central_action_tool_schema_invalid");
  return value as JsonObject;
}

/** This is a deliberately shallow, non-strict function advert, not another
 * validator. Keep concrete reference choices, but avoid copying the complete
 * state/action grammar into every alternative. The existing expand/compiler
 * owns exact shape, evidence, lifecycle, investment and permission admission. */
function summary(value: JsonValue | undefined, definitions: JsonObject): JsonObject {
  const schema = object(value);
  if (typeof schema.$ref === "string") {
    const prefix = "#/$defs/";
    if (!schema.$ref.startsWith(prefix)) throw new Error("central_action_tool_schema_invalid");
    return summary(definitions[schema.$ref.slice(prefix.length)], definitions);
  }

  if (schema.type === "object" || schema.properties !== undefined) return { type: "object" };

  if (schema.type === "array") {
    const item = schema.items === undefined ? { type: "object" } : summary(schema.items, definitions);
    return { type: "array", items: item, ...(schema.maxItems === 0 ? { maxItems: 0 } : {}) };
  }

  if (Array.isArray(schema.anyOf)) {
    const variants = schema.anyOf.map(row => summary(row, definitions));
    // The canonical change list has object alternatives. Its detailed grammar
    // is already taught once on the page and enforced by the same compiler.
    return variants.every(row => row.type === "object") ? { type: "object" } : { anyOf: variants };
  }

  if (schema.const !== undefined) return { type: "string", const: schema.const };

  if (typeof schema.type !== "string") throw new Error("central_action_tool_schema_invalid");

  return { type: schema.type, ...(Array.isArray(schema.enum) ? { enum: schema.enum } : {}) };
}

/** Native object JSON Schema, with optional host-bound checkpoint/slot keys.
 * No default insertion/coercion or provider strict-output subset is assumed. */
export function centralSingleActionLegacyToolSchema(request: CentralDeliberationRequest,
  dictionary: CentralChangeInputDictionary): JsonObject {
  dictionary.assertRequest(request);
  const canonical = centralLearningChangeSchema(request, dictionary, "central-learning-change-input-v4");
  const top = object(canonical.properties), definitions = canonical.$defs === undefined ? {} : object(canonical.$defs);
  const properties: Record<string, JsonValue> = {};

  for (const [name, schema] of Object.entries(top)) properties[name] = summary(schema, definitions);

  const changes = object(top.changes);
  const alternatives = changes.items === undefined ? [] : object(changes.items).anyOf;
  if (Array.isArray(alternatives)) for (const alternative of alternatives) {
    for (const [name, schema] of Object.entries(object(object(alternative).properties))) {
      if (name !== "kind" && name !== "next") properties[name] = summary(schema, definitions);
    }
  }

  if (top.inspect !== undefined) {
    for (const [name, schema] of Object.entries(object(object(top.inspect).properties))) properties[name] = summary(schema, definitions);
    properties.refs = { ...object(properties.refs), minItems: 1 };
  }

  properties.action = { type: "string", enum: CENTRAL_SINGLE_ACTIONS };
  properties.why = { type: "string" };
  properties.next = { anyOf: [
    { type: "string", description: "Advanced v4 only: prioritize an intent handle or a new local key." },
    { type: "object", properties: { kind: { type: "string", enum: ["think", "read", "query", "consult", "dispatch", "wait", "wait_until", "end"] } },
      required: ["kind"], description: "Action fields follow the single shared action card; exact admission remains with the host." },
  ] };

  return { type: "object", properties, additionalProperties: false,
    anyOf: [{ required: ["action", "why"] }, { required: ["changes", "explanation"] }],
    description: "Choose a single action with why, or an advanced v4 delta. Supply only that action's semantic fields. The host supplies omitted checkpoint and new slot keys; exact field and reference validation still applies." };
}

