import type { Message } from "../contract/execution.js";
import type { ProfilePort } from "../contract/profile.js";
import type { PermissionPort } from "../ports/permission.js";
import type { ProviderPort } from "../ports/provider.js";
import type { ToolCallRequest, ToolOutcome, ToolPort, ToolSandbox } from "../ports/tools.js";
import type { JsonObject, JsonValue } from "../protocol/envelope.js";
import type { Transcript } from "../protocol/transcript.js";
import { createSubagentInputChannel, type SubagentInputChannel } from "./input-channel.js";
import {
  createInteractiveChildWorker,
  type InteractiveChildResult,
} from "./interactive-worker.js";
import { SUBAGENT_HISTORY_LIMIT, type SubagentRuntime } from "./runtime.js";
import {
  CLOSE_AGENT_TOOL,
  RESUME_AGENT_TOOL,
  SEND_INPUT_TOOL,
  SPAWN_AGENT_TOOL,
  SUBAGENT_CONTROL_BINDINGS,
  WAIT_AGENT_TOOL,
} from "./control-bindings.js";
import {
  uniqueNicknameFor,
  resolveRole,
  roleCatalogDescription,
  type ResolvedRole,
  type SubagentRole,
} from "./role.js";
import type { SubagentHandle, SubagentStatus } from "./types.js";
import { systemTimerScheduler, type TimerScheduler } from "./scheduler.js";
import {
  AgentRoundObservation,
  DEFAULT_AGENT_WAIT_MS,
  MAX_AGENT_WAIT_MS,
  waitForAgentReports,
} from "./control-observation.js";

/**
 * The model's side of a subagent (WP22.2 / C43, L29).
 *
 * `delegate_subagent` is one blocking call: spawn, wait, return. The model
 * cannot start two agents and come back to either, cannot tell one something
 * new, and cannot pick an agent back up after it ends. These five tools are
 * that control plane, named and shaped after Codex's `multi_agents` V1
 * (`codex-rs/core/src/tools/handlers/multi_agents/{spawn,send_input,wait,
 * close_agent,resume_agent}.rs`, registered at `spec_plan.rs:670-693`).
 *
 * What is borrowed is the surface. What is *not* borrowed is the authority:
 * a subagent still runs under the parent's permission grant and can never
 * approve anything itself, because that red line lives in `SubagentPermissions`
 * and not in any tool argument.
 */


export type SubagentControlOptions = {
  readonly runtime: SubagentRuntime;
  readonly provider: ProviderPort;
  readonly permission: PermissionPort;
  readonly sandbox?: ToolSandbox;
  readonly profile?: ProfilePort | undefined;
  readonly model?: string | undefined;
  readonly sessionId?: string | undefined;
  /** The parent's conversation, for `fork_context` (L29). */
  readonly parentMessages?: ReadonlyArray<Message> | undefined;
  readonly allowedTools?: ReadonlyArray<string> | undefined;
  /** Discovered roles (C44/L27). Empty means `spawn_agent` offers no types. */
  readonly roles?: ReadonlyArray<SubagentRole> | undefined;
  /** What one turn of a child may spend, before a role narrows it. */
  readonly childMaxIterations?: number | undefined;
  readonly onEnvelope?: ((envelope: import("../protocol/envelope.js").Envelope) => void) | undefined;
  readonly scheduler?: TimerScheduler | undefined;
};

type AgentEntry = {
  readonly agentId: string;
  readonly nickname: string;
  readonly channel: SubagentInputChannel;
  readonly handle: SubagentHandle<InteractiveChildResult>;
  /** Kept so `resume_agent` can hand the conversation to a fresh run. */
  readonly observation: AgentRoundObservation;
  readonly resolved: ResolvedRole;
};

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
  const agents = new Map<string, AgentEntry>();
  const finished: string[] = [];
  const observers = new Map<string, AbortController>();
  let submissions = 0;

  /** Remembers what an agent said, so `resume_agent` has something to continue. */
  const remember = (entry: AgentEntry): void => {
    void entry.handle.wait().then((result) => {
      entry.channel.close();
      entry.observation.finish(result);
      finished.push(entry.agentId);
      // The runtime bounds its terminal history; this owner must also release
      // the conversations it retains for resume. Active workers keep their slots.
      while (finished.length > SUBAGENT_HISTORY_LIMIT) {
        const oldest = finished.shift();
        if (oldest !== undefined) agents.delete(oldest);
      }
    });
  };

  const start = (request: {
    readonly name: string;
    readonly message: string;
    readonly toolCallId: string;
    readonly carried?: Transcript;
    readonly forkParent?: boolean;
    readonly agentType?: string | undefined;
    readonly model?: string | undefined;
    readonly resolved?: ResolvedRole;
  }): { readonly entry: AgentEntry; readonly resolved: ResolvedRole } => {
    const role = request.resolved ?? resolveRole(options.roles ?? [], request.agentType, {
      model: options.model,
      allowedTools: [...(options.allowedTools ?? ["read_file"])],
      maxIterations: options.childMaxIterations,
    });
    const resolved = request.model === undefined ? role : { ...role, model: request.model };
    const model = resolved.model;
    const channel = createSubagentInputChannel();
    const observation = new AgentRoundObservation(channel, request.carried);
    const forkMessages =
      request.forkParent && options.parentMessages !== undefined ? options.parentMessages : undefined;
    const worker = createInteractiveChildWorker({
      provider: options.provider,
      permission: options.permission,
      ...(options.sandbox === undefined ? {} : { sandbox: options.sandbox }),
      ...(options.profile === undefined ? {} : { profile: options.profile }),
      message: resolved.role.prompt === undefined
        ? request.message
        : `${resolved.role.prompt}\n\nTask:\n${request.message}`,
      ...(resolved.maxIterations === undefined ? {} : { budget: { maxIterations: resolved.maxIterations } }),
      onRoundStarted: (round, prompt) => {
        observation.startRound(round);
        options.runtime.reportRound(handle.subagentId, { status: "running", round, prompt, displayName: entry.nickname });
      },
      onCheckpoint: (transcript) => observation.checkpoint(transcript),
      onRoundReady: (report) => {
        observation.publish(report);
        options.runtime.reportRound(handle.subagentId, { status: "waiting", round: report.rounds, result: report.output });
      },
      ...(forkMessages === undefined ? {} : { forkMessages }),
      ...(request.carried === undefined ? {} : { forkTranscript: request.carried }),
      ...(model === undefined ? {} : { model: model }),
      ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
      ...(options.onEnvelope === undefined ? {} : { onEnvelope: options.onEnvelope }),
    });
    const handle = options.runtime.spawn<InteractiveChildResult>({
      name: request.name,
      agentType: resolved.role.name,
      prompt: request.message,
      lineage: {
        parentAgentId: "main-agent",
        rootAttemptId: `att-root-${request.toolCallId}`,
        toolCallId: request.toolCallId,
      },
      permissions: {
        allowedTools: [...resolved.allowedTools],
      },
      input: channel,
      worker,
    });
    const taken = new Set([...agents.values()].map((other) => other.nickname));
    const entry: AgentEntry = {
      agentId: handle.subagentId,
      nickname: uniqueNicknameFor(resolved.role, handle.subagentId, taken),
      channel,
      handle,
      observation,
      resolved,
    };
    agents.set(handle.subagentId, entry);
    remember(entry);
    // The resolution travels with the entry so the caller can report what the
    // role actually granted. Resolving twice would be two chances to disagree
    // with itself, and the second one would be the one the model reads.
    return { entry, resolved };
  };

  const run = async (call: ToolCallRequest, signal: AbortSignal): Promise<ToolOutcome> => {
    const args = call.arguments;
    switch (call.name) {
      case SPAWN_AGENT_TOOL: {
        const message = text(args, "message");
        if (message === undefined) {
          return refuse("invalid_arguments", "spawn_agent requires a non-empty message");
        }
        const forkParent = flag(args, "fork_context");
        if (forkParent && options.parentMessages === undefined) {
          return refuse(
            "fork_context_unavailable",
            "This run carries no parent conversation to fork from",
          );
        }
        const { entry, resolved } = start({
          name: "subagent", message, toolCallId: call.toolCallId, forkParent,
          agentType: text(args, "agent_type"), model: text(args, "model"),
        });
        return ok(
          {
            agent_id: entry.agentId,
            nickname: entry.nickname,
            role: resolved.role.name,
            allowed_tools: [...resolved.allowedTools],
            // Said out loud rather than thrown: the role asked for tools this
            // parent cannot grant, and narrowing is the safe direction.
            ...(resolved.withheld.length === 0 ? {} : { withheld: [...resolved.withheld] }),
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
        const interrupt = flag(args, "interrupt");
        if (!entry.channel.deliver({ message, interrupt })) {
          return entry.channel.open
            ? refuse("agent_input_queue_full", `Agent '${target}' has a full input queue; wait or replace queued input with interrupt`)
            : refuse("agent_closed", `Agent '${target}' is closed and takes no more input`);
        }
        entry.observation.requestInput(interrupt);
        submissions += 1;
        return ok({ submission_id: `sub-${submissions}` }, `queued for ${target}`);
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
        const entries = [...new Set(targets)].map(target => agents.get(target));
        if (entries.some(entry => entry === undefined)) {
          return refuse("unknown_agent", "wait_agent received an unknown agent id");
        }
        const known = entries.filter((entry): entry is AgentEntry => entry !== undefined);
        const observed = await waitForAgentReports({
          agents: known.map(entry => entry.observation),
          timeoutMs: Math.min(requestedTimeout ?? DEFAULT_AGENT_WAIT_MS, MAX_AGENT_WAIT_MS),
          signal,
          scheduler: options.scheduler ?? systemTimerScheduler,
        });
        if (observed === "cancelled") return { outcome: "cancelled" };
        const status: Record<string, SubagentStatus> = {};
        const results: Record<string, JsonObject> = {};
        for (const entry of known) {
          status[entry.agentId] = entry.handle.status();
          results[entry.agentId] = entry.observation.snapshot(entry.handle.status());
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
        entry.channel.close();
        if (flag(args, "force")) {
          await options.runtime.cancel(target, "closed_by_parent");
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
        const { entry: entry2 } = start({
          name: entry.nickname, message: "Continue.", toolCallId: call.toolCallId,
          carried: entry.observation.transcript, resolved: entry.resolved,
        });
        return ok({ agent_id: entry2.agentId }, `resumed ${target} as ${entry2.agentId}`);
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
