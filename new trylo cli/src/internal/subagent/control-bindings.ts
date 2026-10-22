import type { ToolBinding } from "../ports/tools.js";

/**
 * The subagent control tools' advertised surface (WP22.2 / C43).
 *
 * Kept apart from the implementation because it is a different job with a
 * different owner: this is what the model is told exists and what shape each
 * call has, while `control-tools.ts` is what those calls mean. `spawn_agent`'s
 * description and `agent_type` enum are filled in per run from the discovered
 * roles, the way Codex does it at `spec_plan.rs:753`.
 */

export const SPAWN_AGENT_TOOL = "spawn_agent";
export const SEND_INPUT_TOOL = "send_input";
export const WAIT_AGENT_TOOL = "wait_agent";
export const CLOSE_AGENT_TOOL = "close_agent";
export const RESUME_AGENT_TOOL = "resume_agent";

const LIMITS = { maxBytes: 65_536, maxLines: 1_000 } as const;

export const SPAWN_AGENT_BINDING: ToolBinding = {
  name: SPAWN_AGENT_TOOL,
  description:
    "Start a subagent working on a message and return immediately with its id. Use send_input to add to it, wait_agent to collect, close_agent to stop it. fork_context makes it start from this conversation.",
  sideEffect: "read_only",
  needsApproval: false,
  timeoutMs: 10_000,
  outputLimits: LIMITS,
  parameters: {
    type: "object",
    properties: {
      message: { type: "string", description: "The instruction the subagent starts with." },
      agent_type: {
        type: "string",
        description: "A configured role. It may narrow the child's tools, model or turns; it can never widen them.",
      },
      fork_context: {
        type: "boolean",
        description: "Start from this conversation instead of from nothing.",
      },
      model: { type: "string", description: "Model override for this subagent." },
    },
    required: ["message"],
  },
};

export const SEND_INPUT_BINDING: ToolBinding = {
  name: SEND_INPUT_TOOL,
  description: "Give a running subagent its next instruction. It runs another round and keeps what it already did.",
  sideEffect: "read_only",
  needsApproval: false,
  timeoutMs: 10_000,
  outputLimits: LIMITS,
  parameters: {
    type: "object",
    properties: {
      target: { type: "string", description: "The agent id." },
      message: { type: "string", description: "The next instruction." },
      interrupt: {
        type: "boolean",
        description: "Forget instructions already queued but not yet started.",
      },
    },
    required: ["target", "message"],
  },
};

export const WAIT_AGENT_BINDING: ToolBinding = {
  name: WAIT_AGENT_TOOL,
  description: "Collect a round answer or terminal result when a target becomes ready. Results include output, phase and status: awaiting_input means the child answered and stays running for send_input. Close it when finished. A timeout or cancelled wait does not stop children.",
  sideEffect: "read_only",
  needsApproval: false,
  timeoutMs: 120_000,
  outputLimits: LIMITS,
  parameters: {
    type: "object",
    properties: {
      targets: { type: "array", items: { type: "string" }, description: "Agent ids to wait for." },
      timeout_ms: { type: "number", minimum: 0, maximum: 60_000, description: "One deadline for all targets, in milliseconds. Default 10000, maximum 60000; 0 returns a snapshot immediately." },
    },
    required: ["targets"],
  },
};

export const CLOSE_AGENT_BINDING: ToolBinding = {
  name: CLOSE_AGENT_TOOL,
  description: "Close a subagent after its current and queued rounds finish. Set force to cancel immediately. Use resume_agent to continue a terminal agent with its role and conversation.",
  sideEffect: "read_only",
  needsApproval: false,
  timeoutMs: 10_000,
  outputLimits: LIMITS,
  parameters: {
    type: "object",
    properties: {
      target: { type: "string", description: "The agent id." },
      force: { type: "boolean", description: "Cancel the active round and discard queued work instead of finishing it." },
    },
    required: ["target"],
  },
};

export const RESUME_AGENT_BINDING: ToolBinding = {
  name: RESUME_AGENT_TOOL,
  description: "Start a fresh subagent that continues a finished one's conversation, and return its new id.",
  sideEffect: "read_only",
  needsApproval: false,
  timeoutMs: 10_000,
  outputLimits: LIMITS,
  parameters: {
    type: "object",
    properties: { target: { type: "string", description: "The agent id to continue from." } },
    required: ["target"],
  },
};

export const SUBAGENT_CONTROL_BINDINGS: ReadonlyArray<ToolBinding> = [
  SPAWN_AGENT_BINDING,
  SEND_INPUT_BINDING,
  WAIT_AGENT_BINDING,
  CLOSE_AGENT_BINDING,
  RESUME_AGENT_BINDING,
];
