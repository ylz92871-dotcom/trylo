import type { CollaborationCorrectionV2 } from "../../learning/domains/collaboration/v2-contracts.js";
import type { ParsedCommand } from "./args-primitives.js";
import { usageError } from "./args-tokens.js";

export type CollaborationGovernanceOptions = {
  readonly subsystem: "collaboration";
  readonly operation: "status";
  readonly workspace?: string;
} | {
  readonly subsystem: "collaboration";
  readonly operation: "correct";
  readonly workspace?: string;
  readonly familyId: string;
  readonly action: "suspend" | "restore";
  readonly appliesTo: CollaborationCorrectionV2["appliesTo"];
  readonly evidenceRef: string;
  readonly replacesCorrectionId?: string;
};

const HINT = "try `trylo learn collaboration status --json` or `correct --family ID --action suspend --scope workspace --evidence-ref user:reason --json`";
const flags = new Set(["--workspace", "--family", "--action", "--scope", "--task-family", "--role", "--task-id", "--evidence-ref", "--replaces"]);
const validText = (s: string): boolean => s.trim().length > 0 && s.length <= 512 && !/[\u0000-\u001f]/u.test(s);

/** User governance is separate from autonomous content selection and never grants execution authority. */
export function parseCollaborationGovernance(argv: readonly string[]): ParsedCommand {
  const operation = argv[0];
  const values = new Map<string, string>();
  let json = false;

  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index]!;
    if (flag === "--json" && !json) {
      json = true;
      continue;
    }

    const value = argv[++index];
    if (!flags.has(flag) || values.has(flag) || value === undefined || !validText(value) || value.startsWith("--")) {
      return usageError("invalid or duplicate collaboration governance option", HINT);
    }

    values.set(flag, value);
  }

  const workspace = values.get("--workspace");
  const base = { subsystem: "collaboration" as const, ...(workspace === undefined ? {} : { workspace }) };

  if (operation === "status" && [...values.keys()].every(key => key === "--workspace")) {
    return { kind: "learn", options: { ...base, operation } };
  }

  const familyId = values.get("--family"), action = values.get("--action"), scope = values.get("--scope");
  const evidenceRef = values.get("--evidence-ref"), replacesCorrectionId = values.get("--replaces");
  if (operation !== "correct" || familyId === undefined || !["suspend", "restore"].includes(action ?? "")
    || evidenceRef === undefined || !evidenceRef.startsWith("user:") || evidenceRef.length <= 5
    || (action === "restore") !== (replacesCorrectionId !== undefined)) return usageError("invalid explicit collaboration correction", HINT);

  const taskFamily = values.get("--task-family"), role = values.get("--role"), taskId = values.get("--task-id");
  let appliesTo: CollaborationCorrectionV2["appliesTo"];

  if (scope === "workspace" && taskFamily === undefined && role === undefined && taskId === undefined) appliesTo = { kind: "workspace" };
  else if (scope === "class" && taskFamily !== undefined && role !== undefined && taskId === undefined) appliesTo = { kind: "class", taskFamily, role };
  else if (scope === "once" && taskId !== undefined && taskFamily === undefined && role === undefined) appliesTo = { kind: "once", taskId };
  else return usageError("correction scope requires exactly its own selectors", HINT);

  return { kind: "learn", options: { ...base, operation, familyId, action: action === "restore" ? "restore" : "suspend", appliesTo, evidenceRef,
    ...(replacesCorrectionId === undefined ? {} : { replacesCorrectionId }) } };
}
