import type { SessionPermissions, PermissionMode } from "../session-permissions.js";
import { isApprovableToolName, APPROVABLE_TOOL_NAMES, type PermissionChoice } from "../permission-plan.js";
import type { TuiIo } from "./io.js";

/**
 * Permission UI for the TUI slash commands.
 *
 * `/mode`, `/allow`, `/deny`, `/revoke`, and `/grants` are thin wrappers around
 * the session's permission controller. They keep the policy in one place
 * (`session-permissions.ts`) and only render its snapshot.
 */

const MODES: ReadonlyArray<PermissionMode> = ["read-only", "confirm", "auto-edit"];

export function runPermissionMode(io: TuiIo, permissions: SessionPermissions, arg: string): void {
  const mode = MODES.find((m) => m === arg.trim().toLowerCase());
  if (mode === undefined) {
    io.write(`mode must be one of: ${MODES.join(", ")}\n`);
    return;
  }

  permissions.setMode(mode);
  io.write(`mode set to ${mode}\n`);
}

export function runPermissionAllow(io: TuiIo, permissions: SessionPermissions, arg: string): void {
  const name = arg.trim();
  if (name.length === 0) {
    io.write("usage: /allow <tool>\n");
    return;
  }

  if (!isApprovableToolName(name)) {
    io.write(`unknown tool ${name}; known tools: ${APPROVABLE_TOOL_NAMES.join(", ")}\n`);
    return;
  }

  try {
    permissions.allowTool(name);
  } catch (error) {
    io.write(`cannot allow ${name}: ${error instanceof Error ? error.message : String(error)}\n`);
    return;
  }

  io.write(`allowed ${name} for this session\n`);
}

export function runPermissionDeny(io: TuiIo, permissions: SessionPermissions, arg: string): void {
  const name = arg.trim();
  if (name.length === 0) {
    io.write("usage: /deny <tool>\n");
    return;
  }

  if (!isApprovableToolName(name)) {
    io.write(`unknown tool ${name}; known tools: ${APPROVABLE_TOOL_NAMES.join(", ")}\n`);
    return;
  }

  permissions.denyTool(name);
  io.write(`denied ${name} for this session\n`);
}

export function runPermissionRevoke(io: TuiIo, permissions: SessionPermissions, arg: string): void {
  const name = arg.trim();
  if (name.length === 0) {
    io.write("usage: /revoke <tool>\n");
    return;
  }

  if (!isApprovableToolName(name)) {
    io.write(`unknown tool ${name}; known tools: ${APPROVABLE_TOOL_NAMES.join(", ")}\n`);
    return;
  }

  permissions.revokeTool(name);
  io.write(`revoked ${name}; it now follows the current mode\n`);
}

export function runPermissionGrants(io: TuiIo, permissions: SessionPermissions, arg: string): void {
  const trimmed = arg.trim();
  if (trimmed.toLowerCase().startsWith("revoke ")) {
    const pattern = trimmed.slice("revoke ".length).trim();
    if (pattern.length === 0) {
      io.write("usage: /grants revoke <pattern>\n");
      return;
    }

    permissions.grants.revoke(pattern);
    io.write(`revoked remembered call matching ${pattern}\n`);

    return;
  }

  const snapshot = permissions.snapshot();

  io.write(`mode: ${snapshot.mode}\n`);

  if (snapshot.allowTools.length > 0) {
    io.write(`allowed tools: ${snapshot.allowTools.join(", ")}\n`);
  }

  if (snapshot.denyTools.length > 0) {
    io.write(`denied tools: ${snapshot.denyTools.join(", ")}\n`);
  }

  const remembered = snapshot.grants;
  if (remembered.length > 0) {
    io.write(`remembered approvals (${remembered.length}):\n`);
    for (const grant of remembered) {
      io.write(`  ${grant.name}: ${grant.pattern}\n`);
    }
  }

  io.write(`effective: ${formatChoice(snapshot.effectiveChoice)}\n`);
}

/**
 * The resolved choice in the operator's own words. `JSON.stringify` was
 * accurate and unreadable; the one line that says what this session will
 * actually enforce is worth spelling out.
 */
function formatChoice(choice: PermissionChoice): string {
  const parts: string[] = [];

  if (choice.ask !== undefined) {
    parts.push(`ask=${choice.ask}`);
  }

  if (choice.allowWrites === true) {
    parts.push("allow-writes");
  }

  if (choice.allowTools !== undefined && choice.allowTools.length > 0) {
    parts.push(`allow=${choice.allowTools.join(",")}`);
  }

  if (choice.denyTools !== undefined && choice.denyTools.length > 0) {
    parts.push(`deny=${choice.denyTools.join(",")}`);
  }

  return parts.length === 0 ? "default (no explicit flags)" : parts.join(" ");
}
