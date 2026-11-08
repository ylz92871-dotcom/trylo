import { fromJSONSchema } from "zod";
import type { JsonObject, JsonValue } from "../../../../../../protocol/envelope.js";
import { isJsonValue, jsonBytes } from "../../../../../domains/tool/evolution/parse.js";
import { prepareSupportedSchema } from "./schema-support.js";

export type SchemaOracleFinding = { readonly path: string; readonly code: string; readonly message: string };

export type SchemaOracleResult = { readonly status: "pass" | "fail" | "unavailable"; readonly code: string;
  readonly findings: readonly SchemaOracleFinding[] };

/** Actual structural verification, separate from sending a responseSchema request and from semantic learned checks. */
export function evaluateSchemaOutput(schema: JsonObject, output: JsonValue): SchemaOracleResult {
  const supported = prepareSupportedSchema(schema);
  if (!supported.ok) return { status: "unavailable", code: supported.failure.code, findings: [supported.failure] };

  if (!isJsonValue(output) || jsonBytes(output) > 262_144) return unavailable("schema_output_invalid", "output is not bounded JSON");

  if (containsPrototypeNames(output)) return unavailable("schema_output_property_unsupported", "prototype-named data properties cannot be reliably checked by the installed converter");

  if (!numericRangeSupported(output)) return unavailable("schema_numeric_range_unsupported", "numbers outside the safe numeric range are not judged by this oracle");

  if (supported.hasStringBounds && containsSurrogates(output)) return unavailable("schema_unicode_bounds_unsupported", "string-length assertions on surrogate code units require a Unicode-aware oracle");

  try {
    const checked = fromJSONSchema(supported.schema).safeParse(output);
    return checked.success ? { status: "pass", code: "schema_match", findings: [] }
      : { status: "fail", code: "schema_violation", findings: checked.error.issues.slice(0, 32).map(issue => ({
        path: `#${issue.path.map(segment => `/${String(segment).replaceAll("~", "~0").replaceAll("/", "~1")}`).join("")}`,
        code: issue.code, message: "output violates the declared structural constraint",
      })) };
  } catch {
    // Conversion faults are checker unavailability; they never become a verdict that the output is bad.
    return unavailable("schema_conversion_failed", "the installed schema adapter could not execute this supported schema");
  }
}

function unavailable(code: string, message: string): SchemaOracleResult {
  return { status: "unavailable", code, findings: [{ path: "#", code, message }] };
}

function numericRangeSupported(value: JsonValue): boolean {
  if (typeof value === "number") return Math.abs(value) <= Number.MAX_SAFE_INTEGER;
  return value === null || typeof value !== "object" || Object.values(value).every(numericRangeSupported);
}

function containsSurrogates(value: JsonValue): boolean {
  if (typeof value === "string") return /[\uD800-\uDFFF]/.test(value);
  return value !== null && typeof value === "object" && Object.values(value).some(containsSurrogates);
}

function containsPrototypeNames(value: JsonValue): boolean {
  return value !== null && typeof value === "object" && ((!Array.isArray(value)
    && Object.keys(value).some(key => ["__proto__", "constructor", "prototype"].includes(key))) || Object.values(value).some(containsPrototypeNames));
}
