import { identity, list, sequence } from "../../validation/json-shape.js";
import { CENTRAL_LEARNING_AGENT_DOMAINS } from "../../learning/control/coordination-contract.js";
import { CENTRAL_RUNTIME_LIMITS } from "../../learning/central/runtime/validation.js";
import { isCentralThinkMaxOutputTokens } from "../../learning/central/runtime/generation.js";
import type { CentralLearningChange } from "./change-contract.js";
import type { CentralChangeStructureRejection } from "./change-structure-rejection.js";

type Rejection = CentralChangeStructureRejection;

type Issue = Rejection | undefined;

interface Guard {
  readonly expected: Rejection["expected"];
  read(value: unknown, field: string): Issue;
}

const limits = CENTRAL_RUNTIME_LIMITS;
const guard = (expected: Rejection["expected"], read: Guard["read"]): Guard => ({ expected, read });
const path = (field: string, key: string | number): string => field + "/" + key;

function structuralType(value: unknown): Rejection["actual"] {
  if (value === null) return "null";

  if (Array.isArray(value)) return "array";

  switch (typeof value) {
    case "object": return "object";
    case "string": return "string";
    case "number": return "number";
    case "boolean": return "boolean";
    default: return "other";
  }
}

const reject = (field: string, expected: Rejection["expected"], value: unknown, cause: Rejection["cause"],
  actual: Rejection["actual"] = structuralType(value)): Rejection => ({ schemaVersion: 1, stage: "shape", field, expected, actual, cause });
const validUnicode = (value: string): boolean => [...value].every(character => {
  const point = character.codePointAt(0)!;
  return point < 0xd800 || point > 0xdfff;
});
const prose = (maximum: number = limits.textChars): Guard => guard("text", (value, field) => {
  if (typeof value !== "string") return reject(field, "text", value, "type");
  if (value.length > maximum) return reject(field, "text", value, "length");
  return validUnicode(value) ? undefined : reject(field, "text", value, "unicode");
});
const meaningful = (text: Guard): Guard => guard("meaning", (value, field) => {
  const issue = text.read(value, field);
  if (issue !== undefined) return { ...issue, expected: "meaning" };
  return typeof value === "string" && value.trim().length > 0 ? undefined : reject(field, "meaning", value, "empty");
});
const meaning = meaningful(prose());
const identifier = guard("identity", (value, field) => {
  if (identity(value)) return undefined;
  if (typeof value !== "string") return reject(field, "identity", value, "type");
  if (value.trim().length === 0) return reject(field, "identity", value, "empty");
  if (value.length > 256) return reject(field, "identity", value, "length");
  return reject(field, "identity", value, validUnicode(value) ? "value" : "unicode");
});
const integer = (minimum: number, maximum: number): Guard => guard("integer", (value, field) =>
  sequence(value) && value >= minimum && value <= maximum ? undefined : reject(field, "integer", value, typeof value === "number" ? "range" : "type"));
const enumeration = (values: readonly string[]): Guard => guard("enum", (value, field) =>
  typeof value === "string" && values.includes(value) ? undefined : reject(field, "enum", value, typeof value === "string" ? "value" : "type"));
const array = (item: Guard, maximum: number = limits.references): Guard => guard("array", (value, field) => {
  if (!Array.isArray(value)) return reject(field, "array", value, "type");

  if (!list(value, 0, maximum)) return reject(field, "array", value, "length");

  if (Reflect.ownKeys(value).length !== value.length + 1) return reject(field, "array", value, "unexpected");

  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index)) return reject(path(field, index), item.expected, undefined, "missing", "missing");
    const issue = item.read(value[index], path(field, index));
    if (issue !== undefined) return issue;
  }

  return undefined;
});
const handles = array(identifier), statements = array(prose(), limits.statements);
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** One ordered shape walk owns both acceptance and safe first-failure metadata. */
function shape(value: unknown, field: string, required: Readonly<Record<string, Guard>>, optional: Readonly<Record<string, Guard>> = {}): Issue {
  if (!record(value)) return reject(field, "object", value, "type");

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return reject(field, "object", value, "value");

  if (Reflect.ownKeys(value).length !== Object.keys(value).length) return reject(field, "known_fields", value, "unexpected");

  for (const key of Object.keys(required)) {
    if (!Object.hasOwn(value, key)) return reject(path(field, key), required[key]!.expected, undefined, "missing", "missing");
  }

  for (const key of Object.keys(value)) {
    const member = Object.hasOwn(required, key) ? required[key] : Object.hasOwn(optional, key) ? optional[key] : undefined;
    // An unknown caller key is deliberately excluded from the diagnostic path.
    if (member === undefined) return reject(field, "known_fields", value, "unexpected");
    const issue = member.read(value[key], path(field, key));
    if (issue !== undefined) return issue;
  }

  return undefined;
}

const object = (required: Readonly<Record<string, Guard>>, optional: Readonly<Record<string, Guard>> = {}): Guard =>
  guard("object", (value, field) => shape(value, field, required, optional));
const commitment = object({ purpose: prose(), assumptions: statements, reconsiderWhen: statements });
const knowledge = array(object({ statement: prose(), conditions: prose(), sources: handles }), limits.knowledge);
const grounding = object({ relation: meaning, whenRelevant: meaning, parents: handles,
  citations: array(object({ source: identifier }, { quote: prose() }), 32) });
const allowance = object({ maxTokens: integer(1, 1_000_000_000), maxCalls: integer(1, 64),
  maxSteps: integer(1, 64), maxPromptChars: integer(0, 100000) });
const userDestination = object({ plane: enumeration(["user"]) });
const agentDestination = object({ plane: enumeration(["agent"]), domain: enumeration(CENTRAL_LEARNING_AGENT_DOMAINS) });
const destination = guard("object", (value, field) => {
  const first = userDestination.read(value, field);
  if (first === undefined || agentDestination.read(value, field) === undefined) return undefined;
  return first;
});
const goalState = enumeration(["open", "answered", "withdrawn"]);
const thinkMaxOutputTokens = guard("integer", (value, field) => isCentralThinkMaxOutputTokens(value) ? undefined
  : reject(field, "integer", value, typeof value === "number" ? "range" : "type"));

function kindIssue(value: unknown, field: string): Issue {
  if (typeof value !== "object" || value === null) return reject(field, "object", value, "type");
  return "kind" in value ? undefined : reject(path(field, "kind"), "enum", undefined, "missing", "missing");
}

const next = guard("object", (value, field) => {
  const issue = kindIssue(value, field);
  if (issue !== undefined) return issue;

  // The precheck above preserves the original discriminator-before-shape order.
  const candidate = value as Record<string, unknown>;
  const operationMeaning = { purpose: meaning, expectedChange: meaning, sources: handles };

  switch (candidate.kind) {
    case "think": return shape(value, field, { kind: enumeration(["think"]), ...operationMeaning }, { maxOutputTokens: thinkMaxOutputTokens });
    case "read": return shape(value, field, { kind: enumeration(["read"]), ...operationMeaning, refs: handles, maximumChars: integer(1, limits.jsonChars) });
    case "query": {
      const invalid = shape(value, field, { kind: enumeration(["query"]), ...operationMeaning, plane: enumeration(["knowledge", "organization"]),
        query: meaningful(prose(512)), maximumChars: integer(1, limits.jsonChars) }, { offset: integer(0, Number.MAX_SAFE_INTEGER) });
      if (invalid !== undefined) return invalid;
      return !("offset" in candidate) || "plane" in candidate && candidate.plane === "organization" ? undefined
        : reject(path(field, "offset"), "query_offset", candidate.offset, "relation");
    }
    case "consult": return shape(value, field, { kind: enumeration(["consult"]), ...operationMeaning, allowance });
    case "dispatch": return shape(value, field, { kind: enumeration(["dispatch"]), ...operationMeaning, allowance }, { destination });
    case "wait": return shape(value, field, { kind: enumeration(["wait"]), for: enumeration(["facts", "use_feedback", "resources"]), sources: handles, reason: meaning });
    case "wait_until": return shape(value, field, { kind: enumeration(["wait_until"]), at: integer(0, Number.MAX_SAFE_INTEGER), sources: handles, reason: meaning });
    case "end": return shape(value, field, { kind: enumeration(["end"]), goalState, reason: meaning });
    default: return reject(path(field, "kind"), "enum", candidate.kind, typeof candidate.kind === "string" ? "value" : "type");
  }
});
const intentFields = () => ({ goal: prose(), rationale: prose(), conditions: statements, knowledge, residual: statements,
  commitment, sources: handles, grounding, next });
const intentChange = guard("object", (value, field) => {
  const issue = kindIssue(value, field);
  if (issue !== undefined) return issue;

  const candidate = value as Record<string, unknown>;
  if (candidate.kind === "create") {
    const invalid = shape(value, field, { kind: enumeration(["create"]), key: identifier, subject: identifier,
      goal: meaning, why: meaning, next }, { grounding, conditions: statements, knowledge, residual: statements, commitment, sources: handles });
    if (invalid !== undefined) return invalid;
    return !("subject" in candidate) || candidate.subject !== "central" || Object.hasOwn(candidate, "grounding") ? undefined
      : reject(path(field, "grounding"), "grounding", undefined, "missing", "missing");
  }

  if (candidate.kind === "revise") return shape(value, field, { kind: enumeration(["revise"]), target: identifier, why: meaning,
    set: guard("nonempty_set", (set, setField) => {
      const invalid = shape(set, setField, {}, intentFields());
      if (invalid !== undefined) return invalid;
      return typeof set === "object" && set !== null && Object.keys(set).length > 0 ? undefined : reject(setField, "nonempty_set", set, "empty");
    }) });

  return shape(value, field, { kind: enumeration(["end"]), target: identifier, goalState, why: meaning });
});
const organizationFields = () => ({ statement: prose(4096), conditions: prose(4096), conditionKeys: array(identifier, 32),
  exceptions: prose(4096), exceptionKeys: array(identifier, 32), implication: prose(4096), support: handles, counterexamples: handles });
const organizationChange = guard("object", (value, field) => {
  const issue = kindIssue(value, field);
  if (issue !== undefined) return issue;

  const candidate = value as Record<string, unknown>, semantic = organizationFields();
  if (candidate.kind === "propose") return shape(value, field, { kind: enumeration(["propose"]), key: identifier, statement: semantic.statement,
    conditions: semantic.conditions, exceptions: semantic.exceptions, implication: semantic.implication, support: handles },
  { conditionKeys: semantic.conditionKeys, exceptionKeys: semantic.exceptionKeys, counterexamples: handles });

  return shape(value, field, { kind: enumeration(["revise", "withdraw"]), target: identifier, why: meaning, set: object({}, semantic) });
});
const inspectRefs = guard("array", (value, field) => {
  const issue = handles.read(value, field);
  if (issue !== undefined) return issue;
  return Array.isArray(value) && value.length > 0 ? undefined : reject(field, "array", value, "empty");
});
const change = object({ changes: array(intentChange, limits.intents), explanation: prose() }, { checkpoint: identifier, next: identifier, sources: handles,
  inspect: object({ purpose: meaning, expectedChange: meaning, refs: inspectRefs, maximumChars: integer(1, limits.jsonChars) }, { sources: handles }),
  alternatives: array(prose(4096), 32), organizationUse: object({ recall: identifier,
    changes: array(object({ knowledge: identifier, choice: enumeration(["program", "investment", "timing", "wait", "unchanged"]),
      before: prose(4096), after: prose(4096), reason: prose(4096) }), 8) }),
  organizationKnowledge: array(organizationChange, limits.knowledge) });

/** Shape only. Original domain decoding owns evidence, lifecycle and investment validity. */
export function readCentralLearningChange(value: unknown): { readonly ok: true; readonly value: CentralLearningChange }
  | { readonly ok: false; readonly rejection: CentralChangeStructureRejection } {
  const rejection = change.read(value, "");
  return rejection === undefined ? { ok: true, value: value as CentralLearningChange } : { ok: false, rejection };
}

export function isCentralLearningChange(value: unknown): value is CentralLearningChange {
  return readCentralLearningChange(value).ok;
}
