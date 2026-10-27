import { MCP_TOOL_PREFIX } from "../../mcp/names.js";
import { cancelToolPorts } from "../../ports/tool-cancellation.js";
import {
  guardRefinedText,
  noOverlay,
} from "../../learning/domains/tool/refine/overlay.js";
import type { DescriptionOverlay } from "../../learning/domains/tool/refine/types.js";
import type { McpToolSpec } from "../../ports/mcp-client.js";
import type {
  SandboxVerdict,
  ToolBinding,
  ToolCallRequest,
  ToolOutcome,
  ToolPort,
  ToolSandbox,
} from "../../ports/tools.js";
import { sanitizeToolDescription } from "../../tooling/catalog/description-guard.js";
import {
  DEFAULT_MAX_SHELL_OUTPUT_BYTES,
  DEFAULT_MAX_SHELL_OUTPUT_LINES,
} from "../sandbox/policy.js";
import type { McpRuntimeServer } from "./pool.js";

/**
 * Mounting: a listed server tool becomes a row in the tool table, or it does
 * not become one at all.
 *
 * Three conversions happen here and nowhere else (WP §4-D9), and each carries a
 * decision worth naming:
 *
 *  - **Name.** The binding is named `mcp__<server>__<tool>`, the qualified name
 *    the client already produced, so the provider request, the approval action
 *    and the call router all speak one string.
 *  - **Description.** The text arrives from a server Trylo does not control, so
 *    it is sanitised before the model can read it. A description that looks
 *    like an injection attempt, or is empty, costs the *tool* its place in the
 *    table — the rest of the server keeps working (D5).
 *  - **Side effect and approval.** `"external"` and `true`, literally. A tool
 *    whose body runs in someone else's process is not bounded by the workspace
 *    sandbox, and the `needsApproval` literal on `McpToolSpec` is the same fact
 *    stated twice on purpose: there is no annotation a server can publish that
 *    turns either of them off.
 *
 * The output limits are the shell family's, not a new pair: MCP tool output
 * travels the loop's one 64 KiB envelope, and inventing a second ceiling here
 * would only give the two a way to disagree.
 */

export const DEFAULT_MCP_CALL_TIMEOUT_MS = 30_000;
export const MIN_MCP_CALL_TIMEOUT_MS = 1;
export const MAX_MCP_CALL_TIMEOUT_MS = 120_000;

export const MCP_OUTPUT_LIMITS = {
  maxBytes: DEFAULT_MAX_SHELL_OUTPUT_BYTES,
  maxLines: DEFAULT_MAX_SHELL_OUTPUT_LINES,
} as const;

export type McpRefusedTool = {
  readonly qualifiedName: string;
  readonly code: "prompt_injection" | "empty_description";
};

/** One mounted tool: its table row, the server that owns it, and its spec. */
export type McpMountedTool = {
  readonly binding: ToolBinding;
  readonly server: McpRuntimeServer;
  readonly spec: McpToolSpec;
};

export type McpMount = {
  readonly mounted: ReadonlyArray<McpMountedTool>;
  readonly refused: ReadonlyArray<McpRefusedTool>;
};

export function mountServerTools(
  servers: ReadonlyArray<McpRuntimeServer>,
  overlay: DescriptionOverlay = noOverlay,
): McpMount {
  const mounted: McpMountedTool[] = [];
  const refused: McpRefusedTool[] = [];
  for (const server of servers) {
    for (const spec of server.tools) {
      const binding = bindingForSpec(spec, DEFAULT_MCP_CALL_TIMEOUT_MS, overlay);
      if ("code" in binding) {
        refused.push({ qualifiedName: spec.qualifiedName, code: binding.code });
        continue;
      }
      mounted.push({ binding, server, spec });
    }
  }
  return { mounted, refused };
}

/**
 * The one spec -> binding translation. `needsApproval: true` is written as a
 * literal rather than copied from the spec, so a future spec type cannot make
 * this line conditional by accident.
 *
 * `overlay` is the A-description-refinement injection point (P05 tool learning
 * §6). It arrives as a *function*, not a store: mounting may ask what a tool's
 * description should read as, and has no way to write an entry, read another
 * tool's entry, or reach any other field. That is what makes "refinement never
 * changes execution semantics" structural rather than a rule to remember — this
 * function's only use of it is the `description` line below.
 *
 * The overlay is asked **after** the guard, and its answer is **not** trusted on
 * its own: `guardRefinedText` runs the same description guard again. A refined
 * description is model-written or read back from a local file, so it has no
 * claim to being more trustworthy than the server's original; letting it in
 * unguarded would turn the overlay into a bypass of the very check that
 * refuses an injecting description upstream. A refinement that fails the guard
 * falls back to the original text — never to refusing the tool, since the
 * original is already known-good and one bad refinement should not cost a
 * working tool its place in the table.
 */
export function bindingForSpec(
  spec: McpToolSpec,
  timeoutMs: number = DEFAULT_MCP_CALL_TIMEOUT_MS,
  overlay: DescriptionOverlay = noOverlay,
): ToolBinding | McpRefusedTool {
  const guarded = sanitizeToolDescription(spec.description);
  if (!guarded.ok) {
    return { qualifiedName: spec.qualifiedName, code: guarded.code };
  }
  const refined = overlay.descriptionFor(spec.qualifiedName, guarded.text);
  const description =
    refined === undefined ? guarded.text : guardRefinedText({ refined, original: guarded.text }).text;
  return {
    name: spec.qualifiedName,
    description,
    sideEffect: "external",
    parameters: spec.inputSchema,
    needsApproval: true,
    timeoutMs,
    outputLimits: MCP_OUTPUT_LIMITS,
  };
}

/**
 * The composite tool table: workspace tools first, MCP tools after.
 *
 * Routing is by name prefix *or* by membership in the MCP snapshot taken at
 * compose time, and that split is the whole point: server tools
 * (`mcp__<server>__<tool>`) route by prefix — including names that merely
 * look like MCP tools, which fail closed in the MCP port with `unknown_tool`
 * — while the runtime's synthetic resource tools (`mcp_list_resources` and
 * kin, single underscores, unspellable by any server) route by membership.
 * Membership is captured once because the MCP table is fixed for the run
 * that composed it; a name in neither set goes to the workspace port,
 * exactly as before this package existed.
 */
export function composeTools(workspace: ToolPort, mcp: ToolPort): ToolPort {
  const mcpNames = new Set(mcp.snapshot().map((binding) => binding.name));
  return {
    snapshot: () => [...workspace.snapshot(), ...mcp.snapshot()],
    execute: (call: ToolCallRequest, signal: AbortSignal): Promise<ToolOutcome> =>
      mcpNames.has(call.name) || isMcpToolName(call.name)
        ? mcp.execute(call, signal)
        : workspace.execute(call, signal),
    cancel: async (toolCallId: string): Promise<void> => {
      await cancelToolPorts([workspace, mcp], toolCallId);
    },
  };
}

/**
 * The sandbox as the loop will consult it, with the workspace rules intact and
 * one addition: a mounted MCP tool is admitted.
 *
 * The workspace sandbox refuses any name it has no plan for — that is what
 * keeps a new tool from being granted freedom by omission (`sandbox/planner.ts`
 * §"a tool the sandbox has no constraint for"). An MCP tool would therefore be
 * refused before a human ever saw it, which is the wrong outcome for a call
 * whose safety argument was never about the workspace: its body runs in another
 * process, outside this filesystem, and the approval prompt is its only gate.
 *
 * Admission is keyed on *what is actually mounted*, never on the prefix, so a
 * name that merely looks like an MCP tool still meets the workspace refusal.
 */
export function composeSandbox(
  workspace: ToolSandbox,
  mountedNames: ReadonlySet<string>,
): ToolSandbox {
  const requiresApproval = workspace.requiresApproval;
  return {
    policy: workspace.policy,
    ...(requiresApproval === undefined ? {} : { requiresApproval }),
    evaluate: (call: ToolCallRequest): SandboxVerdict =>
      mountedNames.has(call.name) ? { ok: true } : workspace.evaluate(call),
  };
}

export function isMcpToolName(name: string): boolean {
  return name.startsWith(MCP_TOOL_PREFIX);
}

/** The names a composite sandbox should admit: exactly the mounted bindings. */
export function mountedNameSet(mounted: ReadonlyArray<McpMountedTool>): ReadonlySet<string> {
  return new Set(mounted.map((item) => item.binding.name));
}
