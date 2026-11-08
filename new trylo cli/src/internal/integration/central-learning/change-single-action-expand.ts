import type { CentralDeliberationRequest } from "../../learning/central/runtime/contracts.js";
import type { CentralChangeInputDictionary } from "./change-input-contract.js";
import type { CentralChangeStructureRejection } from "./change-structure-rejection.js";
import { centralReferenceSelectionCode } from "./change-reference-contract.js";
import { CentralDeliberationError } from "./deliberation-contract.js";
import { CENTRAL_SINGLE_ACTION_FIELDS, isCentralSingleAction } from "./change-single-action-contract.js";
import { CENTRAL_SINGLE_ACTION_V5_VERSION as CENTRAL_SINGLE_ACTION_VERSION, type CentralSingleActionVersion } from "./change-single-action-version.js";
import { expandCentralSingleActionKnowledgeEdits } from "./change-single-action-knowledge-edits.js";
import { expandCentralSingleActionSourceAnchoring } from "./change-single-action-source-anchoring.js";

/** Default total material-character budget for a single read/inspect decision. */
export const CENTRAL_SINGLE_ACTION_DEFAULT_READ_CHARS = 8192;

function rejectStructure(field: string, expected: CentralChangeStructureRejection["expected"],
  actual: CentralChangeStructureRejection["actual"], cause: CentralChangeStructureRejection["cause"]): never {
  throw new CentralDeliberationError("central_learning_change_invalid", "returned",
    undefined, undefined, undefined, undefined, undefined, { schemaVersion: 1, stage: "shape", field, expected, actual, cause });
}

function coarseKind(value: unknown): CentralChangeStructureRejection["actual"] {
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

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null) && Reflect.ownKeys(value).length === Object.keys(value).length;
}

/** Slot keys add no research meaning. Explicit keys and all delivered handles
 * are reserved before allocating, including keys in later array positions. */
function supplyKeys(value: Record<string, unknown>, dictionary: CentralChangeInputDictionary): Record<string, unknown> {
  const used = new Set(dictionary.entries.map(entry => entry.handle));

  for (const rows of [value.changes, value.organizationKnowledge]) {
    if (!Array.isArray(rows)) continue;
    for (const row of rows) if (plainRecord(row) && typeof row.key === "string") used.add(row.key);
  }

  const allocate = (kind: "create" | "propose", slot: number): string => {
    const base = `single-${kind}-${slot + 1}`;
    let key = base, collision = 1;
    while (used.has(key)) key = `${base}-${++collision}`;
    used.add(key);
    return key;
  };
  const rowsWithKeys = (rows: unknown, kind: "create" | "propose"): unknown => {
    // Preserve malformed arrays for the original shape guard; mapping them
    // must not erase extra properties or fill sparse slots.
    if (!Array.isArray(rows) || Reflect.ownKeys(rows).length !== rows.length + 1) return rows;
    for (let index = 0; index < rows.length; index++) if (!Object.hasOwn(rows, index)) return rows;
    return rows.map((row: unknown, index: number) => plainRecord(row) && row.kind === kind && !Object.hasOwn(row, "key")
      ? { ...row, key: allocate(kind, index) } : row);
  };

  return { ...value,
    ...(Object.hasOwn(value, "changes") ? { changes: rowsWithKeys(value.changes, "create") } : {}),
    ...(Object.hasOwn(value, "organizationKnowledge") ? { organizationKnowledge: rowsWithKeys(value.organizationKnowledge, "propose") } : {}),
  };
}

function expandAction(value: Record<string, unknown>): Record<string, unknown> {
  const action = value.action;
  if (!isCentralSingleAction(action)) {
    return rejectStructure("/action", "enum", coarseKind(action), typeof action === "string" ? "value" : "type");
  }

  if (!Object.hasOwn(value, "why")) return rejectStructure("/why", "meaning", "missing", "missing");

  const allowed = new Set(["action", "checkpoint", "why", ...CENTRAL_SINGLE_ACTION_FIELDS[action]]);
  if (Object.keys(value).some(key => !allowed.has(key))) return rejectStructure("", "known_fields", "object", "unexpected");

  const { action: _action, checkpoint: _checkpoint, why, ...fields } = value;

  if (action === "read" || action === "inspect") return { changes: [], explanation: why, inspect: { ...fields,
    ...(!Object.hasOwn(fields, "purpose") ? { purpose: why } : {}),
    ...(!Object.hasOwn(fields, "expectedChange") ? { expectedChange: why } : {}),
    ...(!Object.hasOwn(fields, "maximumChars") ? { maximumChars: CENTRAL_SINGLE_ACTION_DEFAULT_READ_CHARS } : {}),
  } };

  if (action === "none") return { changes: [], explanation: why };

  if (action === "organize") return { changes: [], explanation: why, ...fields };

  if (action === "continue") return { changes: [{ kind: "revise", target: fields.target, why, set: { next: fields.next } }], explanation: why };

  return { changes: [{ kind: action, why, ...fields }], explanation: why };
}

/** Expand presentation aliases into the original v4 DTO only. The original
 * compiler still owns typed references, domain evidence, identities and funds. */
export function expandCentralSingleAction(value: unknown, request: CentralDeliberationRequest,
  dictionary: CentralChangeInputDictionary, representationVersion: CentralSingleActionVersion = CENTRAL_SINGLE_ACTION_VERSION): unknown {
  dictionary.assertRequest(request);

  if (!plainRecord(value)) return rejectStructure("", "object", coarseKind(value), "type");

  let presented = value;

  // A frozen old representation never acquires this new action field. Advanced
  // deltas retain their original canonical whole-array replacement contract.
  if ((representationVersion === "central-learning-single-action-v4" || representationVersion === "central-learning-single-action-v5") && value.action === "revise"
    && plainRecord(value.set) && Object.hasOwn(value.set, "knowledgeEdits")) {
    if (Object.hasOwn(value.set, "knowledge")) return rejectStructure("/set/knowledgeEdits", "known_fields", "object", "relation");
    const result = expandCentralSingleActionKnowledgeEdits({ edits: value.set.knowledgeEdits, target: value.target, request, dictionary });
    if (!result.ok) return rejectStructure(result.rejection.field, result.rejection.expected, result.rejection.actual, result.rejection.cause);
    const { knowledgeEdits: _edits, ...unchanged } = value.set;
    presented = { ...value, set: { ...unchanged, knowledge: result.knowledge } };
  }

  const expanded = Object.hasOwn(presented, "action") ? expandAction(presented) : { ...presented };

  // A supplied checkpoint, even an incorrect one, is never repaired here.
  if (Object.hasOwn(value, "checkpoint")) expanded.checkpoint = value.checkpoint;
  else {
    const code = centralReferenceSelectionCode(dictionary);
    if (code !== undefined) expanded.checkpoint = code;
  }

  const keyed = supplyKeys(expanded, dictionary);

  return representationVersion === "central-learning-single-action-v5"
    ? expandCentralSingleActionSourceAnchoring(keyed, request, dictionary) : keyed;
}
