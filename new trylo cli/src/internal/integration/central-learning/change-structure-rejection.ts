import { fields } from "../../validation/json-shape.js";

export interface CentralChangeStructureRejection {
  readonly schemaVersion: 1;
  readonly stage: "shape" | "generation";
  /** Host schema tokens and array indices only; the root is an empty string. */
  readonly field: string;
  readonly expected: "object" | "array" | "text" | "meaning" | "identity" | "integer" | "enum"
    | "known_fields" | "grounding" | "nonempty_set" | "query_offset" | "generation_limit";
  readonly actual: "missing" | "null" | "object" | "array" | "string" | "number" | "boolean" | "other";
  readonly cause: "type" | "missing" | "unexpected" | "range" | "length" | "value" | "empty" | "unicode"
    | "relation" | "unavailable" | "unsupported";
}

const expectedKinds: readonly CentralChangeStructureRejection["expected"][] = ["object", "array", "text", "meaning", "identity",
  "integer", "enum", "known_fields", "grounding", "nonempty_set", "query_offset", "generation_limit"];
const actualKinds: readonly CentralChangeStructureRejection["actual"][] = ["missing", "null", "object", "array", "string", "number", "boolean", "other"];
const causes: readonly CentralChangeStructureRejection["cause"][] = ["type", "missing", "unexpected", "range", "length", "value", "empty",
  "unicode", "relation", "unavailable", "unsupported"];
const fieldTokens = new Set(["action", "changes", "explanation", "checkpoint", "next", "sources", "inspect", "purpose", "expectedChange", "refs",
  "maximumChars", "alternatives", "organizationUse", "recall", "knowledge", "knowledgeEdits", "entry", "choice", "before", "after", "reason", "organizationKnowledge",
  "kind", "key", "subject", "goal", "why", "grounding", "conditions", "residual", "commitment", "rationale", "statement", "assumptions",
  "reconsiderWhen", "relation", "whenRelevant", "parents", "citations", "source", "quote", "maxTokens", "maxCalls", "maxSteps", "maxPromptChars",
  "plane", "domain", "maxOutputTokens", "query", "offset", "for", "at", "goalState", "target", "set", "conditionKeys", "exceptions", "exceptionKeys",
  "implication", "support", "counterexamples", "destination", "allowance"]);
const decimal = /^(?:0|[1-9]\d*)$/;

function schemaField(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 256) return false;
  return value === "" || value.startsWith("/") && value.slice(1).split("/").every(token => fieldTokens.has(token)
    || decimal.exec(token)?.[0] === token && Number.isSafeInteger(Number(token)));
}

/** Structural metadata never contains caller keys, values, quotations or parser prose. */
export function isCentralChangeStructureRejection(value: unknown): value is CentralChangeStructureRejection {
  if (!fields(value, ["schemaVersion", "stage", "field", "expected", "actual", "cause"]) || Reflect.ownKeys(value).length !== 6
    || value.schemaVersion !== 1 || value.stage !== "shape" && value.stage !== "generation" || !schemaField(value.field)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null) && expectedKinds.some(kind => kind === value.expected)
    && actualKinds.some(kind => kind === value.actual) && causes.some(cause => cause === value.cause);
}

/** An original shape constraint is new control feedback, not a semantic repair.
 * Re-expression uses the current exact contract; neither old values nor erased
 * keys are guessed. Generation and unclear/external relations stay separate. */
export function isActionableCentralChangeStructureRejection(value: unknown): value is CentralChangeStructureRejection {
  return isCentralChangeStructureRejection(value) && value.stage === "shape"
    && (value.cause === "type" || value.cause === "missing" || value.cause === "unexpected" || value.cause === "value"
      || value.cause === "range" || value.cause === "length" || value.cause === "empty" || value.cause === "unicode");
}
