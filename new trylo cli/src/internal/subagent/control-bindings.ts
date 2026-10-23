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
    "Start a bounded subagent and return its execution agent_id, stable task_id, tools and budget. Default 32000 tokens and 300000ms active execution; idle waiting pauses the execution clock and releases the slot after 30000ms. send_input continues an automatically parked task. fork_context includes completed parent tool results and images.",
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
      allowed_tools: { type: "array", items: { type: "string" }, description: "Optional subset of the parent's available tools; the role may narrow it further." },
      token_budget: { type: "integer", minimum: 1, maximum: 100_000, description: "Cumulative task input plus output tokens, including repeated context and automatic continuation. Default 32000. Enforced after each provider response." },
      timeout_ms: { type: "integer", minimum: 1, maximum: 900_000, description: "Active execution budget in milliseconds. Default 300000; time waiting for input is excluded." },
      idle_timeout_ms: { type: "integer", minimum: 1, maximum: 300_000, description: "Release the execution slot after this much idle time. Default 30000; later input continues the same task." },
    },
    required: ["message"],
  },
};

export const SEND_INPUT_BINDING: ToolBinding = {
  name: SEND_INPUT_TOOL,
  description: "Give a task its next instruction using agent_id or stable task_id. append queues input; replace_queued replaces input not yet started; restart stops the active execution, waits for cleanup, and starts the new instruction with its checkpoint. Parked tasks continue automatically. Replies state the actual delivery mode.",
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
        description: "Legacy alias for mode=replace_queued. Does not stop the active round. Use mode=restart to stop and replace current work.",
      },
      mode: { type: "string", enum: ["append", "replace_queued", "restart"], description: "Default append. Cannot be combined with the legacy interrupt flag." },
    },
    required: ["target", "message"],
  },
};

export const WAIT_AGENT_BINDING: ToolBinding = {
  name: WAIT_AGENT_TOOL,
  description: "Collect round answers and terminal results, including budget, usage, cursor, task_id and phase. Pass each prior cursor in after to wait only for newer results and suppress repeated output. release_on_ready frees ready execution slots while retaining follow-up context. A timed-out or cancelled observation leaves children running.",
  sideEffect: "read_only",
  needsApproval: false,
  timeoutMs: 120_000,
  outputLimits: LIMITS,
  parameters: {
    type: "object",
    properties: {
      targets: { type: "array", items: { type: "string" }, description: "Agent ids to wait for." },
      timeout_ms: { type: "number", minimum: 0, maximum: 60_000, description: "One deadline for all targets, in milliseconds. Default 10000, maximum 60000; 0 returns a snapshot immediately." },
      after: { type: "object", additionalProperties: { type: "integer", minimum: 0 }, description: "Map target ids to their previously collected result cursors. Omitted targets retain legacy snapshot behavior." },
      release_on_ready: { type: "boolean", description: "Close ready workers and release their slots; later send_input transparently continues their task." },
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
  description: "Continue a terminal task from its latest checkpoint. Automatically wait up to 5 seconds for old worker cleanup. Returns a new agent_id with the same task_id and nickname. An optional message states what to do next; without it the original assignment and recorded progress are used.",
  sideEffect: "read_only",
  needsApproval: false,
  timeoutMs: 10_000,
  outputLimits: LIMITS,
  parameters: {
    type: "object",
    properties: { target: { type: "string", description: "The execution or task id to continue from." },
      message: { type: "string", description: "Optional next instruction; verify recorded effects before repeating actions." },
      token_budget: { type: "integer", minimum: 1, maximum: 100_000, description: "Explicit replacement for the remaining token budget. Omit to retain the task's remaining allowance." },
      timeout_ms: { type: "integer", minimum: 1, maximum: 900_000, description: "Explicit replacement for remaining active time. Omit to retain the task's remaining allowance." } },
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
