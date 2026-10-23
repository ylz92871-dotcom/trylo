import type { ToolCallRequest, ToolOutcome, ToolPort } from "../ports/tools.js";
import type { JsonObject, JsonValue } from "../protocol/envelope.js";
import { CLOSE_AGENT_TOOL, RESUME_AGENT_TOOL, SEND_INPUT_TOOL, SPAWN_AGENT_TOOL,
  SUBAGENT_CONTROL_BINDINGS, WAIT_AGENT_TOOL } from "./control-bindings.js";
import { roleCatalogDescription } from "./role.js";
import type { SubagentStatus } from "./types.js";
import { systemTimerScheduler } from "./scheduler.js";
import { governanceFailureOutcome } from "./governance.js";
import { DEFAULT_AGENT_WAIT_MS, MAX_AGENT_WAIT_MS, waitForAgentReports } from "./control-observation.js";
import { ControlAgentSessions, AGENT_CLEANUP_WAIT_MS, type SubagentControlOptions } from "./control-session.js";
import { spawnSettings, inputMode, resultCursors } from "./control-input.js";
export type { SubagentControlOptions } from "./control-session.js";

function text(args: JsonObject, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function flag(args: JsonObject, key: string): boolean {
  return args[key] === true;
}

function number(args: JsonObject, key: string): number | undefined {
  const value = args[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function list(args: JsonObject, key: string): ReadonlyArray<string> | undefined {
  const value = args[key];
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? (value as string[])
    : undefined;
}

function ok(value: JsonObject, output: string): ToolOutcome {
  return { outcome: "result", value, output, truncated: false };
}

function refuse(code: string, message: string): ToolOutcome {
  return { outcome: "error", code, message };
}

export function createSubagentControlTool(options: SubagentControlOptions): ToolPort {
  const agents = new ControlAgentSessions(options);
  const observers = new Map<string, AbortController>();
  let submissions = 0;

  const run = async (call: ToolCallRequest, signal: AbortSignal): Promise<ToolOutcome> => {
    const args = call.arguments;
    switch (call.name) {
      case SPAWN_AGENT_TOOL: {
        const message = text(args, "message");
        if (message === undefined) {
          return refuse("invalid_arguments", "spawn_agent requires a non-empty message");
        }
        const forkParent = flag(args, "fork_context");
        const forkMessages = forkParent
          ? typeof options.parentMessages === "function" ? options.parentMessages() : options.parentMessages
          : undefined;
        if (forkParent && forkMessages === undefined) {
          return refuse(
            "fork_context_unavailable",
            "This run carries no parent conversation to fork from",
          );
        }
        const entry = agents.start({
          message, toolCallId: call.toolCallId, forkMessages, ...spawnSettings(args),
          agentType: text(args, "agent_type"), model: text(args, "model"),
        });
        return ok(
          {
            agent_id: entry.agentId,
            nickname: entry.nickname,
            budget: entry.observation.budgetSnapshot(options.runtime.getGovernance().snapshot(entry.agentId)),
            idle_timeout_ms: entry.idleTimeoutMs,
            task_id: entry.taskId,
            role: entry.resolved.role.name,
            allowed_tools: [...entry.resolved.allowedTools],
            // Said out loud rather than thrown: the role asked for tools this
            // parent cannot grant, and narrowing is the safe direction.
            ...(entry.resolved.withheld.length === 0 ? {} : { withheld: [...entry.resolved.withheld] }),
          },
          `agent ${entry.agentId}`,
        );
      }

      case SEND_INPUT_TOOL: {
        const target = text(args, "target");
        const message = text(args, "message");
        if (target === undefined || message === undefined) {
          return refuse("invalid_arguments", "send_input requires target and message");
        }
        const entry = agents.get(target);
        if (entry === undefined) {
          return refuse("unknown_agent", `No agent with id '${target}'`);
        }
        const mode = inputMode(args);
        if (mode === "restart" || entry.parked) {
          if (mode === "restart") {
            entry.channel.close();
            await options.runtime.cancel(entry.agentId, "restarted_by_parent");
          }
          const next = await agents.resume(entry, message, call.toolCallId, signal);
          if (next === "cancelled") return { outcome: "cancelled" };
          submissions += 1;
          return ok({ submission_id: `sub-${submissions}`, agent_id: next.agentId, task_id: next.taskId,
            delivery: mode === "restart" ? "restarted" : "continued" }, `continued ${next.taskId}`);
        }
        const interrupt = mode === "replace_queued";
        if (!entry.channel.deliver({ message, interrupt })) {
          return entry.channel.open
            ? refuse("agent_input_queue_full", `Agent '${target}' has a full input queue; wait or replace queued input with interrupt`)
            : refuse("agent_closed", `Agent '${target}' is closed and takes no more input`);
        }
        entry.observation.requestInput();
        submissions += 1;
        return ok({ submission_id: `sub-${submissions}`, agent_id: entry.agentId, task_id: entry.taskId,
          delivery: interrupt ? "replaced_queued" : "queued", active_round_interrupted: false }, `queued for ${target}`);
      }

      case WAIT_AGENT_TOOL: {
        const targets = list(args, "targets");
        if (targets === undefined || targets.length === 0) {
          return refuse("invalid_arguments", "wait_agent requires at least one target");
        }
        const requestedTimeout = number(args, "timeout_ms");
        if (args["timeout_ms"] !== undefined && (requestedTimeout === undefined || requestedTimeout < 0)) {
          return refuse("invalid_arguments", "timeout_ms must be a finite non-negative number");
        }
        const after = resultCursors(args, targets);
        const known = [...new Set(targets)].flatMap(target => {
          const entry = agents.get(target);
          return entry === undefined ? [] : [{ target, entry }];
        });
        if (known.length !== new Set(targets).size) {
          return refuse("unknown_agent", "wait_agent received an unknown agent id");
        }
        const observed = await waitForAgentReports({
          ready: () => targets.some(target => agents.get(target)?.observation.isReady(after.get(target))),
          subscribe: listener => agents.subscribe(listener),
          timeoutMs: Math.min(requestedTimeout ?? DEFAULT_AGENT_WAIT_MS, MAX_AGENT_WAIT_MS),
          signal,
          scheduler: options.scheduler ?? systemTimerScheduler,
        });
        if (observed === "cancelled") return { outcome: "cancelled" };
        const status: Record<string, SubagentStatus> = {};
        const results: Record<string, JsonObject> = {};
        for (const { target } of known) {
          const entry = agents.get(target);
          if (entry === undefined) return refuse("unknown_agent", "This task has left the bounded conversation history");
          if (flag(args, "release_on_ready") && entry.observation.isReady()) {
            agents.park(entry);
            const retired = await options.runtime.waitForRetirement(entry.agentId, AGENT_CLEANUP_WAIT_MS, signal);
            if (retired === "cancelled") return { outcome: "cancelled" };
          }
          status[target] = entry.handle.status();
          results[target] = { ...entry.observation.snapshot(entry.handle.status(), after.get(target),
            options.runtime.getGovernance().snapshot(entry.agentId)), agent_id: entry.agentId, task_id: entry.taskId,
            round: entry.roundOffset + entry.observation.lastRound,
            nickname: entry.nickname, idle_timeout_ms: entry.idleTimeoutMs };
        }
        const answer = { status, timed_out: observed === "timeout", results };
        return ok(answer, JSON.stringify(answer));
      }

      case CLOSE_AGENT_TOOL: {
        const target = text(args, "target");
        const entry = target === undefined ? undefined : agents.get(target);
        if (target === undefined || entry === undefined) {
          return refuse("unknown_agent", `No agent with id '${target ?? ""}'`);
        }
        // Closing the channel ends the agent at the end of the round it is in,
        // which keeps the work it already did and reports `completed`. Forcing
        // is a different request: `cancel` settles the run now, and a run that
        // is cut short is honestly reported as `cancelled`.
        entry.parked = false;
        entry.channel.close();
        if (flag(args, "force")) {
          await options.runtime.cancel(entry.agentId, "closed_by_parent");
        }
        return ok({ closed: true, forced: flag(args, "force") }, `closed ${target}`);
      }

      case RESUME_AGENT_TOOL: {
        const target = text(args, "target");
        const entry = target === undefined ? undefined : agents.get(target);
        if (target === undefined || entry === undefined) {
          return refuse("unknown_agent", `No agent with id '${target ?? ""}'`);
        }
        const current: SubagentStatus = entry.handle.status();
        if (current === "pending" || current === "running") {
          return refuse(
            "agent_still_running",
            `Agent '${target}' is '${current}'; it does not need resuming`,
          );
        }
        const settings = spawnSettings(args);
        const entry2 = await agents.resume(entry, text(args, "message"), call.toolCallId, signal, settings.governance);
        if (entry2 === "cancelled") return { outcome: "cancelled" };
        return ok({ agent_id: entry2.agentId, task_id: entry2.taskId, nickname: entry2.nickname,
          resumed_from: entry.agentId }, `resumed ${entry2.taskId}`);
      }

      default:
        return refuse("unknown_tool", `Unknown subagent control tool '${call.name}'`);
    }
  };

  return {
    // Codex does the same thing at `spec_plan.rs:753`: the spawn tool's
    // description carries whatever roles this run has, so the model chooses from
    // the configured set. With no roles the text is the plain one, unchanged.
    snapshot: () => {
      const catalog = roleCatalogDescription(options.roles ?? []);
      if (catalog.length === 0) {
        return SUBAGENT_CONTROL_BINDINGS;
      }
      return SUBAGENT_CONTROL_BINDINGS.map((binding) =>
        binding.name === SPAWN_AGENT_TOOL
          ? {
              ...binding,
              description: `${binding.description}
${catalog}`,
              parameters: {
                type: "object",
                properties: {
                  ...(binding.parameters as { properties: Record<string, JsonValue> }).properties,
                  agent_type: {
                    type: "string",
                    enum: [...(options.roles ?? []).map((role) => role.name)],
                    description: "A configured role; it can only narrow this child's tools.",
                  },
                },
                required: ["message"],
              },
            }
          : binding,
      );
    },
    async execute(call, signal): Promise<ToolOutcome> {
      if (signal.aborted) return { outcome: "cancelled" };
      const observer = new AbortController();
      const cancel = (): void => { observer.abort(signal.reason); };
      signal.addEventListener("abort", cancel, { once: true });
      observers.set(call.toolCallId, observer);
      try {
        return await run(call, observer.signal);
      } catch (error) {
        return governanceFailureOutcome(error);
      } finally {
        signal.removeEventListener("abort", cancel);
        observers.delete(call.toolCallId);
      }
    },
    async cancel(toolCallId): Promise<void> {
      // Cancel the observation, not a child that may have other waiters.
      observers.get(toolCallId)?.abort("tool_call_cancelled");
    },
  };
}
