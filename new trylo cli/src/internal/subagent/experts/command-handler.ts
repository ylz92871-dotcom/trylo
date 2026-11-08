import { ExpertLibraryError } from "./contracts.js";
import type { ExpertActionContext } from "./contracts.js";
import type { ExpertCommand } from "./commands.js";
import type { ExpertLibrary } from "./library.js";
import { validateAssociation, validateEdits } from "./validation.js";

export function parseExpertCommand(value: unknown): ExpertCommand {
  const invalid = (): never => { throw new ExpertLibraryError("invalid_input", "Invalid expert command payload"); };

  if (value === null || typeof value !== "object" || Array.isArray(value)) return invalid();

  const command = value as Record<string, unknown>;
  const fields: Record<string, readonly string[]> = {
    query: ["text"], get: ["expertId", "version"], requests: [], request: ["requestId"],
    submit: ["origin", "instruction", "expertId", "requestId", "association"],
    build: ["requestId"], authorize_creation: ["requestId"], edit: ["requestId", "edits"],
    retain: ["requestId", "result"], archive: ["expertId"], draft_revision: ["expertId", "requestId"],
  };
  if (typeof command.operation !== "string" || !Object.hasOwn(fields, command.operation)) return invalid();

  const allowed = fields[command.operation]!;
  if (!Object.keys(command).every(key => key === "operation" || allowed.includes(key))) return invalid();

  const text = (item: unknown, max: number): boolean => typeof item === "string" && item.trim().length > 0 && item.length <= max;
  if (["request", "build", "authorize_creation", "edit", "retain"].includes(command.operation) && !text(command.requestId, 200)) return invalid();

  if (["get", "archive", "draft_revision"].includes(command.operation) && !text(command.expertId, 200)) return invalid();

  if (command.operation === "draft_revision" && command.requestId !== undefined && !text(command.requestId, 200)) return invalid();

  if (command.operation === "query" && command.text !== undefined && (typeof command.text !== "string" || command.text.length > 8000)) return invalid();

  if (command.operation === "get" && command.version !== undefined && (!Number.isSafeInteger(command.version) || Number(command.version) < 1)) return invalid();

  if (command.operation === "submit") {
    if (!["settings", "personal_agent", "collaboration"].includes(String(command.origin)) || !text(command.instruction, 8000)
      || command.expertId !== undefined && !text(command.expertId, 200) || command.requestId !== undefined && !text(command.requestId, 200)) return invalid();
    if (command.association !== undefined) validateAssociation(command.association);
  }

  if (command.operation === "edit") validateEdits(command.edits);

  if (command.operation === "retain") {
    const result = command.result;
    if (!result || typeof result !== "object" || Array.isArray(result)) return invalid();
    const row = result as Record<string, unknown>;
    if (!["save", "temporary", "revise"].includes(String(row.kind)) || !Object.keys(row).every(key => key === "kind" || row.kind === "revise" && key === "feedback")
      || row.kind === "revise" && !text(row.feedback, 8000)) return invalid();
  }

  return command as ExpertCommand;
}

/** Shared protocol registration is host-owned; this adapter is its single library call boundary. */
export async function executeExpertCommand(library: ExpertLibrary, input: unknown, context: ExpertActionContext = {}): Promise<unknown> {
  const command = parseExpertCommand(input);
  switch (command.operation) {
    case "query": return library.query(command.text);
    case "get": return library.get(command.expertId, command.version);
    case "requests": return library.requests();
    case "request": return library.request(command.requestId);
    case "submit": return library.submitRequest(command, context);
    case "build": return library.build(command.requestId, context);
    case "authorize_creation": return library.authorizeCreation(command.requestId, context);
    case "edit": return library.edit(command.requestId, command.edits, context);
    case "retain": return library.retain(command.requestId, command.result, context);
    case "archive": await library.archive(command.expertId, context); return null;
    case "draft_revision": return library.draftRevision(command.expertId, context, command.requestId);
    default: throw new ExpertLibraryError("invalid_input", "Unknown expert command");
  }
}
