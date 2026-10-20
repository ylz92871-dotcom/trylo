import {
  decision,
  type PermissionAction,
  type PermissionDecision,
  type PermissionPort,
  type PermissionTicket,
} from "../../ports/permission.js";
import { APPLY_PATCH_TOOL, EDIT_FILE_TOOL, NOTEBOOK_EDIT_TOOL, RUN_SHELL_TOOL, WRITE_FILE_TOOL } from "../../adapters/tools/mutating/names.js";
import { WORKSPACE_WRITE_TOOL_NAMES } from "../../adapters/tools/mutating/bindings.js";
import { WEB_FETCH_TOOL } from "../../adapters/tools/web/names.js";
import { MEMORY_WRITE_TOOL_NAMES } from "../../adapters/tools/memory/write.js";
import { isMcpQualifiedName } from "../../mcp/names.js";
import { PATH_READ_TOOL_NAMES } from "../../adapters/tools/read-only/path-names.js";
import { createInteractivePermission, type InteractivePermissionIo } from "./permission.js";

/**
 * D7: a permission *entry point*, not a new permission model.
 *
 * Everything that decides ownership stays where it is: the sandbox still
 * refuses what it refuses, `loop/permission-grants.ts` still decides what a
 * session-scoped approval means, and learning still owns none of it. What this
 * module adds is the one thing that was missing — a way to say, from the
 * command line, how much a run may decide on its own.
 *
 * The order is fixed and the safe direction wins: the sandbox admits first
 * (unchanged, and not something a flag can pre-empt), then an explicit denial,
 * then an explicit allowance, and only then the `--ask` policy. A tool named in
 * both lists is denied.
 */

export const ASK_POLICIES = ["always", "writes", "never"] as const;

export type AskPolicy = (typeof ASK_POLICIES)[number];

export function isAskPolicy(value: string): value is AskPolicy {
  return (ASK_POLICIES as readonly string[]).includes(value);
}

/**
 * Built-ins with approval entry points. Path readers normally need no approval,
 * but an explicitly selected external scope requires per-call approval.
 */
export const APPROVABLE_TOOL_NAMES: ReadonlyArray<string> = [
  ...PATH_READ_TOOL_NAMES,
  WRITE_FILE_TOOL,
  EDIT_FILE_TOOL,
  APPLY_PATCH_TOOL,
  NOTEBOOK_EDIT_TOOL, // WP13 (L13): cell edits approve like file edits.
  RUN_SHELL_TOOL,
  WEB_FETCH_TOOL,
  // Optional user-learning tools can be explicitly permitted before mounting.
  // Their user scope never inherits the workspace-only --allow-writes grant.
  ...MEMORY_WRITE_TOOL_NAMES,
  // The session tools are deliberately absent, all three of them.
  //
  // `stop_process` was here first, on the reasoning that ending a process is an
  // effect on the machine. That is wrong about *which* process: the registry
  // holds only sessions this run started, and the tool takes a session id
  // rather than a pid, so there is nothing it can end that was not already
  // approved to exist. Ending something you were permitted to start is not an
  // escalation — the same reason `write_stdin`, which can type into that
  // process, is not one either.
  //
  // Listing them here would have been worse than useless: `--allow-tools` would
  // accept a name, the approval flow would produce a prompt, and approving it
  // would grant nothing that the catalog did not already allow.
];

/**
 * Whether a flag may name this tool. The static list covers built-ins; a
 * syntactically valid MCP qualified name (`mcp__<server>__<tool>`) is accepted
 * by name because its tools only exist once mounted at runtime — the sandbox
 * admits exactly the mounted set and fails closed on the rest. One predicate
 * so the parser and the plan cannot disagree about the vocabulary.
 */
export function isApprovableToolName(name: string): boolean {
  return APPROVABLE_TOOL_NAMES.includes(name) || isMcpQualifiedName(name);
}

/**
 * The two refusals for a tool list, owned here because the vocabulary lives
 * here: a typo must read as "unknown tool", never as "that tool is not
 * allowed". The MCP hint points at `mcp list` because the parser cannot know
 * which servers this machine registered — the runtime sandbox decides that.
 */
export function emptyToolListMessage(): string {
  return `needs at least one tool name; available tools: ${APPROVABLE_TOOL_NAMES.join(", ")}`;
}

export function unknownToolMessage(unknown: ReadonlyArray<string>): string {
  return `unknown tool ${unknown.join(", ")}; available tools: ${APPROVABLE_TOOL_NAMES.join(", ")}; MCP tools look like mcp__<server>__<tool> (\`trylo mcp list\` shows the registered servers)`;
}

const WORKSPACE_WRITE_TOOLS: ReadonlySet<string> = new Set(WORKSPACE_WRITE_TOOL_NAMES);

/**
 * What the command line asked for. Every field is optional, and an empty
 * choice — the shape every pre-D7 invocation has — must behave exactly as it
 * did before.
 */
export type PermissionChoice = {
  readonly ask?: AskPolicy;
  readonly allowTools?: ReadonlyArray<string>;
  readonly denyTools?: ReadonlyArray<string>;
  /** `--allow-writes`, kept as the `--ask writes` sugar. */
  readonly allowWrites?: boolean;
};

export type PermissionPlanInput = PermissionChoice & {
  /** False for a piped run, where there is nobody to ask. */
  readonly interactive: boolean;
};

export type PermissionPlan = {
  readonly ask: AskPolicy;
  readonly allow: ReadonlySet<string>;
  readonly deny: ReadonlySet<string>;
};

export function defaultAskPolicy(input: PermissionPlanInput): AskPolicy {
  if (input.ask !== undefined) {
    return input.ask;
  }
  if (input.allowWrites === true) {
    return "writes";
  }
  return input.interactive ? "always" : "never";
}

export function planPermissions(input: PermissionPlanInput): PermissionPlan {
  return {
    ask: defaultAskPolicy(input),
    allow: new Set(input.allowTools ?? []),
    deny: new Set(input.denyTools ?? []),
  };
}

export type PlanDecision = "approved" | "denied" | "ask";

/**
 * One call, one verdict.
 *
 * `ask` is not a decision but a request for one, and only a terminal can give
 * it — so when there is none the policy is `never` and this returns `denied`
 * without ever reaching a prompt.
 */
export function decideForPlan(plan: PermissionPlan, action: PermissionAction): PlanDecision {
  if (plan.deny.has(action.name)) {
    return "denied";
  }
  if (plan.allow.has(action.name)) {
    return "approved";
  }
  const isWorkspaceWrite = WORKSPACE_WRITE_TOOLS.has(action.name);
  if (plan.ask === "never") {
    return "denied";
  }
  if (plan.ask === "writes") {
    return isWorkspaceWrite ? "approved" : "denied";
  }
  return "ask";
}

export function createPlannedPermission(plan: PermissionPlan, io: InteractivePermissionIo): PermissionPort {
  const asking = createInteractivePermission(io);
  const settled = new Map<string, PlanDecision>();
  let counter = 0;
  return {
    isDenied: name => plan.deny.has(name),
    async request(action: PermissionAction): Promise<PermissionTicket> {
      const verdict = decideForPlan(plan, action);
      if (verdict === "ask") {
        return await asking.request(action);
      }
      counter += 1;
      const ticketId = `plan-${counter}`;
      settled.set(ticketId, verdict);
      return { ticketId, toolCallId: action.toolCallId };
    },
    async awaitDecision(ticketId: string): Promise<PermissionDecision> {
      const verdict = settled.get(ticketId);
      if (verdict === undefined) {
        return await asking.awaitDecision(ticketId);
      }
      settled.delete(ticketId);
      return decision(verdict === "approved" ? "approved" : "denied", "once", verdict === "denied" ? "policy_denied" : undefined);
    },
  };
}
