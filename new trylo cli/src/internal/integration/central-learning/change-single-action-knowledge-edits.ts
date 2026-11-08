import type { CentralDeliberationRequest, CentralLearningIntentDraft } from "../../learning/central/runtime/contracts.js";
import { contentHashOf } from "../../learning/control/hash.js";
import { CENTRAL_RUNTIME_LIMITS } from "../../learning/central/runtime/validation.js";
import type { CentralChangeKnowledge } from "./change-contract.js";
import type { CentralChangeInputDictionary } from "./change-input-contract.js";
import { readCentralLearningChange } from "./change-parse.js";
import type { CentralChangeStructureRejection } from "./change-structure-rejection.js";

export type CentralSingleActionKnowledgeEdit =
  | { readonly kind: "append"; readonly entry: CentralChangeKnowledge; readonly why: string }
  | { readonly kind: "revise"; readonly target: number; readonly entry: CentralChangeKnowledge; readonly why: string }
  | { readonly kind: "withdraw"; readonly target: number; readonly why: string };

type Result = { readonly ok: true; readonly knowledge: readonly CentralChangeKnowledge[] }
  | { readonly ok: false; readonly rejection: CentralChangeStructureRejection };

type Failure = Extract<Result, { readonly ok: false }>;

const field = "/set/knowledgeEdits";
const issue = (at: string, expected: CentralChangeStructureRejection["expected"], actual: CentralChangeStructureRejection["actual"],
  cause: CentralChangeStructureRejection["cause"]): Failure => ({ ok: false,
  rejection: { schemaVersion: 1, stage: "shape", field: at, expected, actual, cause } });

function kind(value: unknown): CentralChangeStructureRejection["actual"] {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  const type = typeof value;
  return type === "object" || type === "string" || type === "number" || type === "boolean" ? type : "other";
}

function record(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null) && Reflect.ownKeys(value).length === Object.keys(value).length;
}

/** Validate one entry and its reason with the unchanged canonical leaf guards.
 * This local DTO is never sent, persisted or used as a research decision. */
function checkedEntry(edit: Record<string, unknown>, target: string, at: string):
  { readonly ok: true; readonly entry?: CentralChangeKnowledge } | Failure {
  const parsed = readCentralLearningChange({ changes: [{ kind: "revise", target, why: edit.why,
    set: { knowledge: edit.kind === "withdraw" ? [] : [edit.entry] } }], explanation: "Validate one public knowledge edit" });
  if (!parsed.ok) {
    const source = parsed.rejection.field;
    const mapped = source.startsWith("/changes/0/why") ? `${at}/why${source.slice("/changes/0/why".length)}`
      : source.startsWith("/changes/0/set/knowledge/0") ? `${at}/entry${source.slice("/changes/0/set/knowledge/0".length)}` : at;
    return { ok: false, rejection: { ...parsed.rejection, field: mapped } };
  }

  const change = parsed.value.changes[0]!;
  if (change.kind !== "revise") return issue(at, "object", "object", "unavailable");

  const entry = change.set.knowledge?.[0];

  return entry === undefined ? { ok: true } : { ok: true, entry };
}

/** Index authority is local to this exact checkpoint and selected intent. All
 * edits address the original ordered array; no persistent entry ID is created. */
export function expandCentralSingleActionKnowledgeEdits(input: { readonly edits: unknown; readonly target: unknown;
  readonly request: CentralDeliberationRequest; readonly dictionary: CentralChangeInputDictionary }): Result {
  const { edits, target, request, dictionary } = input;

  dictionary.assertRequest(request);

  if (typeof target !== "string") return issue("/target", "identity", kind(target), "type");

  const delivered = dictionary.intent(target);
  if (delivered === undefined) return issue("/target", "identity", "string", "unavailable");

  const prior = request.state.intents.find(intent => intent.intentId === delivered.intentId) ?? delivered;
  if (contentHashOf(prior.knowledge) !== contentHashOf(delivered.knowledge)) return issue("/target", "identity", "string", "unavailable");

  if (!Array.isArray(edits)) return issue(field, "array", kind(edits), "type");

  if (edits.length === 0) return issue(field, "array", "array", "empty");

  if (edits.length > CENTRAL_RUNTIME_LIMITS.knowledge) return issue(field, "array", "array", "length");

  if (Reflect.ownKeys(edits).length !== edits.length + 1) return issue(field, "array", "array", "unexpected");

  const original = prior.knowledge.slice();
  const binding = (index: number) => contentHashOf([dictionary.checkpoint, prior.intentId, index, prior.knowledge[index]]);
  const bindings = original.map((_, index) => binding(index));
  const changed = new Map<number, CentralChangeKnowledge | null>(), appended: CentralChangeKnowledge[] = [];

  for (let index = 0; index < edits.length; index++) {
    const at = `${field}/${index}`;

    if (!Object.hasOwn(edits, index)) return issue(at, "object", "missing", "missing");

    const edit: unknown = edits[index];
    if (!record(edit)) return issue(at, "object", kind(edit), "type");

    if (!Object.hasOwn(edit, "kind")) return issue(`${at}/kind`, "enum", "missing", "missing");

    if (edit.kind !== "append" && edit.kind !== "revise" && edit.kind !== "withdraw") {
      return issue(`${at}/kind`, "enum", kind(edit.kind), typeof edit.kind === "string" ? "value" : "type");
    }

    const keys = edit.kind === "append" ? ["kind", "entry", "why"]
      : edit.kind === "revise" ? ["kind", "target", "entry", "why"] : ["kind", "target", "why"];
    if (Object.keys(edit).some(key => !keys.includes(key))) return issue(at, "known_fields", "object", "unexpected");

    if (!Object.hasOwn(edit, "why")) return issue(`${at}/why`, "meaning", "missing", "missing");

    if (edit.kind !== "withdraw" && !Object.hasOwn(edit, "entry")) return issue(`${at}/entry`, "object", "missing", "missing");

    let position: number | undefined;

    if (edit.kind !== "append") {
      if (!Object.hasOwn(edit, "target")) return issue(`${at}/target`, "integer", "missing", "missing");
      if (typeof edit.target !== "number" || !Number.isSafeInteger(edit.target)) return issue(`${at}/target`, "integer", kind(edit.target), typeof edit.target === "number" ? "range" : "type");
      if (edit.target < 0 || edit.target >= original.length) return issue(`${at}/target`, "integer", "number", "range");
      position = edit.target;
      if (changed.has(position)) return issue(`${at}/target`, "integer", "number", "relation");
      if (bindings[position] !== binding(position)) return issue(`${at}/target`, "integer", "number", "unavailable");
    }

    const checked = checkedEntry(edit, target, at);
    if (!checked.ok) return checked;

    if (edit.kind === "append") appended.push(checked.entry!);
    else changed.set(position!, edit.kind === "withdraw" ? null : checked.entry!);
  }

  const retained = (entry: CentralLearningIntentDraft["knowledge"][number]): CentralChangeKnowledge | Failure => {
    const sources: string[] = [];

    for (const ref of entry.sourceRefs) {
      const handle = dictionary.entries.find(row => row.kind === "reference" && row.ref === ref)?.handle;
      if (handle === undefined || dictionary.source(handle) !== ref) return issue(field, "identity", "string", "unavailable");
      sources.push(handle);
    }

    return { statement: entry.statement, conditions: entry.conditions, sources };
  };
  const knowledge: CentralChangeKnowledge[] = [];

  for (let index = 0; index < original.length; index++) {
    const replacement = changed.get(index);
    if (replacement === null) continue;

    if (replacement !== undefined) knowledge.push(replacement);
    else {
      const entry = retained(original[index]!);
      if ("ok" in entry) return entry;
      knowledge.push(entry);
    }
  }

  knowledge.push(...appended);

  if (knowledge.length > CENTRAL_RUNTIME_LIMITS.knowledge) return issue(field, "array", "array", "length");

  dictionary.assertRequest(request);

  if (prior.knowledge.length !== bindings.length || bindings.some((hash, index) => hash !== binding(index))) return issue(field, "array", "array", "unavailable");

  return { ok: true, knowledge };
}
