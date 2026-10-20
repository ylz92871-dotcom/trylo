import type { Message } from "../../contract/execution.js";
import type { PermissionPort } from "../../ports/permission.js";
import type { ProviderPort } from "../../ports/provider.js";
import type { ToolPort, ToolSandbox } from "../../ports/tools.js";
import {
  createSubagentControlTool,
  createSubagentToolPort,
  mountSubagentTool,
  SubagentRuntime,
  type SubagentRuntimeOptions,
} from "../../subagent/index.js";
import type { SubagentRole } from "../../subagent/role.js";
import { NO_LEARNING_PROFILE } from "./wiring-catalog.js";

/**
 * Everything `--subagent` turns on, in one place (WP22).
 *
 * This used to live inline in `wiring.ts` and pushed that file past the size
 * the gate allows. It is split out rather than the limit being raised, because
 * what it does is a distinct job: there is one runtime, one governance, one
 * journal attribution, and two ways for the model to reach a subagent —
 * `delegate_subagent` (spawn and wait in one blocking call) and the C43 control
 * tools (`spawn_agent` and friends, where the model decides when to look).
 * Both go through the same runtime on purpose; the two ports only differ in
 * what the model is allowed to do while the agent is alive.
 */

export type SubagentPortsInput = {
  /** The parent's tool port, before subagents are added to it. */
  readonly parentTools: ToolPort;
  /** The unbounded workspace tools: what a subagent may be narrowed down from. */
  readonly workspaceTools: ToolPort;
  /** The provider subagents run on. The fixture variant is chosen by the caller. */
  readonly childProvider: ProviderPort;
  readonly model: string | undefined;
  readonly permission: PermissionPort;
  readonly sandbox?: ToolSandbox;
  /** The parent's conversation, for `fork_context` (L29) and WP14's skill fork. */
  readonly callerMessages: ReadonlyArray<Message> | undefined;
  readonly onEvent?: SubagentRuntimeOptions["onEvent"];
  readonly governance?: SubagentRuntimeOptions["governance"];
  readonly idGenerator?: SubagentRuntimeOptions["idGenerator"];
  /** Roles (C44/L27). Absent or empty means no `agent_type` is offered. */
  readonly roles?: ReadonlyArray<SubagentRole>;
};

export type SubagentPorts = {
  readonly runtime: SubagentRuntime;
  /** WP14's late-bound skill fork exit: it must be the tool port itself. */
  readonly toolPort: ToolPort;
  /** What the loop should run with. */
  readonly tools: ToolPort;
};

export function buildSubagentPorts(input: SubagentPortsInput): SubagentPorts {
  const runtime = new SubagentRuntime({
    tools: input.workspaceTools,
    ...(input.onEvent === undefined ? {} : { onEvent: input.onEvent }),
    ...(input.governance === undefined ? {} : { governance: input.governance }),
    ...(input.idGenerator === undefined ? {} : { idGenerator: input.idGenerator }),
  });

  // Without the run's model the child hits the engine's `"default"` → model_not_found.
  const shared = {
    runtime,
    provider: input.childProvider,
    model: input.model,
    permission: input.permission,
    ...(input.sandbox === undefined ? {} : { sandbox: input.sandbox }),
    profile: NO_LEARNING_PROFILE,
  };

  const delegateTool = createSubagentToolPort({
    ...shared,
    ...(input.callerMessages === undefined ? {} : { callerMessages: input.callerMessages }),
  });

  const controlTools = createSubagentControlTool({
    ...shared,
    ...(input.callerMessages === undefined ? {} : { parentMessages: input.callerMessages }),
    ...(input.roles === undefined ? {} : { roles: input.roles }),
  });

  return {
    runtime,
    toolPort: delegateTool,
    tools: mountSubagentTool(input.parentTools, delegateTool, controlTools),
  };
}
