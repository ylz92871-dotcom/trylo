import type { ToolBinding } from "../ports/tools.js";
import { HANDOFF_SCHEMA } from "../protocol/subagent-handoff.js";

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
export const LIST_AGENTS_TOOL = "list_agents";

const LIMITS = { maxBytes: 65_536, maxLines: 1_000 } as const;
const DEPENDENCIES = { type: "array", maxItems: 16, items: { type: "string", minLength: 1, maxLength: 512 },
  description: "Stable task ids whose latest rounds must already be ready. Pending, failed, unknown and self dependencies refuse dispatch before another model is called. Round readiness does not prove independent acceptance." };

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
        depends_on: DEPENDENCIES,
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
  description: "Give a task its next instruction using agent_id or stable task_id. Optional handoff supplies scope, artifacts, evidence, pending work and blockers to the actual recipient. depends_on refuses dispatch until prerequisite rounds are ready. append queues input; replace_queued replaces input not yet started; restart waits for cleanup before continuing. A submission_id receipt means queued, not processed: wait_agent.delivery distinguishes started and answered. None of these states proves independent acceptance.",
  sideEffect: "read_only",
  needsApproval: false,
  timeoutMs: 10_000,
  outputLimits: LIMITS,
  parameters: {
    type: "object",
    properties: {
      target: { type: "string", description: "The agent id." },
      message: { type: "string", description: "The next instruction." },
      handoff: HANDOFF_SCHEMA,
      depends_on: DEPENDENCIES,
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
  description: "Collect round answers, terminal results and authored progress reports, including budget, usage, cursor, task_id and phase. Set wake_on_report to observe new progress or blockers before a round ends. Pass each returned cursor in after to suppress repeats; while has_more_reports is true, read the next page with after and timeout_ms=0. Reports are member statements, not acceptance or permission decisions. reports_truncated identifies lost older reports; output_truncated marks a shortened full-answer preview. release_on_ready frees only genuinely ready execution slots. A timed-out or cancelled observation leaves children running.",
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
      wake_on_report: { type: "boolean", description: "Also return when a member authors a new progress, blocked or ready report. Default false preserves waiting for a full round. Use after cursors to avoid rereading reports; a report does not make an execution ready for release." },
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
  description: "Continue a terminal task or an explicitly selected durable checkpoint. Waits for old task resource cleanup; returns a new agent_id with the same task_id and nickname. After process exit, canonical history is replayed through a fresh provider under current role policy and permissions; opaque provider state, queued input and old approvals are not restored. Interrupted checkpoints require an explicit message after inspecting existing effects, plus explicit token_budget and timeout_ms because usage after the boundary is unknown. No automatic retry or exactly-once guarantee. Use list_agents when durable recovery is available.",
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

export const LIST_AGENTS_BINDING: ToolBinding = {
  name: LIST_AGENTS_TOOL, description: "List bounded live tasks and durable recovery candidates without starting any work. Recovery candidates are historical checkpoints, never currently running workers. Invalid or unavailable context cannot be resumed. Use resume_agent explicitly. Cold recovery returns cursor_reset=true: discard prior wait_agent.after cursors for that task.",
  sideEffect: "read_only", needsApproval: false, timeoutMs: 10_000, outputLimits: LIMITS,
  parameters: { type: "object", properties: { offset: { type: "integer", minimum: 0, maximum: 128,
    description: "Default 0. Read at most 8 tasks per bounded page; pass next_offset to continue, until null. This is a live listing, not a frozen snapshot." } }, additionalProperties: false },
};

export const SUBAGENT_CONTROL_BINDINGS: ReadonlyArray<ToolBinding> = [
  SPAWN_AGENT_BINDING,
  SEND_INPUT_BINDING,
  WAIT_AGENT_BINDING,
  CLOSE_AGENT_BINDING,
  RESUME_AGENT_BINDING,
];
