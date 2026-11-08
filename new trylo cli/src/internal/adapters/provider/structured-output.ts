import type { JsonObject } from "../../protocol/envelope.js";
import type { ProviderRequest } from "../../ports/provider.js";

/**
 * Structured output wire mapping (WP18.3: C74, L67 schema half).
 *
 * Reuse: Codex `exec` output_schema (`codex-rs/exec/src/lib.rs:900`
 * `load_output_schema`, `:932` last_message/output_schema terminal condition;
 * `exec/src/cli.rs:48 --output-schema`, `:69 --output-last-message`).
 *
 * The caller system prompt (`--system-prompt` replace /
 * `--append-system-prompt` append, legacy L67) is applied where messages are
 * assembled (`loop/request.ts` owns that); this file owns the schema half:
 * loading the file text and stating the wire fields.
 *
 * Two rules, both about honesty rather than shape:
 *
 *  - a schema is a *request*, never a guarantee. The adapter sends the wire's
 *    own `response_format`; a 400 refusal surfaces as `invalid_request`
 *    (before headers, not retryable), never as a silent plain-text answer;
 *  - a model that declares no structured support is not asked anyway. The
 *    catalog gate (`model-catalog.ts demandStructuredSupport`) refuses before
 *    any request is sent; a model with no catalog entry passes through and
 *    the endpoint decides, because inventing a refusal would be the same lie
 *    in reverse.
 */

export type SchemaFailureCode = "not_json" | "not_object" | "empty_schema";

export type SchemaFailure = {
  readonly code: SchemaFailureCode;
  readonly detail: string;
};

export type SchemaResult =
  | { readonly ok: true; readonly schema: JsonObject }
  | { readonly ok: false; readonly failure: SchemaFailure };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse `--output-schema` file text into a request schema.
 *
 * Codex loads an arbitrary JSON value here; Trylo narrows to an object because
 * only an object can travel as a `response_format.json_schema.schema`. An
 * empty object is refused rather than sent: it constrains nothing, so sending
 * it would claim structure while enforcing none.
 */
export function loadResponseSchema(text: string): SchemaResult {
  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, failure: { code: "not_json", detail: "schema file is not valid JSON" } };
  }

  if (!isRecord(parsed)) {
    return { ok: false, failure: { code: "not_object", detail: "schema must be a JSON object" } };
  }

  if (Object.keys(parsed).length === 0) {
    return { ok: false, failure: { code: "empty_schema", detail: "schema must not be an empty object" } };
  }

  return { ok: true, schema: parsed as JsonObject };
}

/**
 * The Chat Completions wire fields for a schema, or nothing when no schema
 * was requested. Absent stays absent: a run that never passed `--output-schema`
 * sends byte for byte what it always sent.
 */
export function chatStructuredFields(schema: JsonObject | undefined): {
  readonly response_format: {
    readonly type: "json_schema";
    readonly json_schema: { readonly name: string; readonly strict: true; readonly schema: JsonObject };
  };
} | undefined {
  if (schema === undefined) {
    return undefined;
  }
  return {
    response_format: {
      type: "json_schema",
      json_schema: { name: "trylo_structured_output", strict: true, schema },
    },
  };
}

/** Refuse incompatible JSON content requests before credentials or transport.
 * No format request preserves all existing tool/schema combinations. */
export function chatResponseFormatFailure(request: ProviderRequest, supported: readonly "json_object"[]): string | undefined {
  const format = request.responseFormat;
  if (format === undefined) return undefined;

  if (request.responseSchema !== undefined) return "response_format_schema_conflict";

  if (request.tools.length > 0) return "response_format_tools_conflict";

  if (!isRecord(format) || Object.getPrototypeOf(format) !== Object.prototype && Object.getPrototypeOf(format) !== null
    || Reflect.ownKeys(format).length !== 1 || !Object.hasOwn(format, "type") || format.type !== "json_object") {
    return "response_format_invalid";
  }

  return supported.includes("json_object") ? undefined : "response_format_unsupported";
}

/** JSON object mode does not imply a JSON schema or a function call. */
export function chatJsonObjectFields(format: ProviderRequest["responseFormat"]): {
  readonly response_format: { readonly type: "json_object" };
} | undefined {
  return format === undefined ? undefined : { response_format: { type: "json_object" } };
}

/**
 * The Responses wire fields for a schema (`text.format`), or nothing when no
 * schema was requested. Same absence rule as the chat shape.
 */
export function responsesStructuredFields(schema: JsonObject | undefined): {
  readonly text: {
    readonly format: { readonly type: "json_schema"; readonly name: string; readonly strict: true; readonly schema: JsonObject };
  };
} | undefined {
  if (schema === undefined) {
    return undefined;
  }
  return {
    text: {
      format: { type: "json_schema", name: "trylo_structured_output", strict: true, schema },
    },
  };
}

/** True when this request asks the model for schema-constrained output. */
export function wantsStructuredOutput(request: ProviderRequest): boolean {
  return request.responseSchema !== undefined;
}
