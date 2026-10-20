import type { Message } from "../contract/execution.js";
import type { ProfilePort } from "../contract/profile.js";
import type { PermissionPort } from "../ports/permission.js";
import type { ProviderPort } from "../ports/provider.js";
import type { ToolCallRequest, ToolOutcome, ToolPort, ToolSandbox } from "../ports/tools.js";
import type { JsonObject, JsonValue } from "../protocol/envelope.js";
import { createSubagentInputChannel, type SubagentInputChannel } from "./input-channel.js";
import {
  createInteractiveChildWorker,
  type InteractiveChildResult,
} from "./interactive-worker.js";
import type { SubagentRuntime } from "./runtime.js";
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
};

type AgentEntry = {
  readonly agentId: string;
  readonly nickname: string;
  readonly channel: SubagentInputChannel;
  readonly handle: SubagentHandle<InteractiveChildResult>;
  /** Kept so `resume_agent` can hand the conversation to a fresh run. */
  transcript: import("../protocol/transcript.js").Transcript;
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
  let submissions = 0;

  /** Remembers what an agent said, so `resume_agent` has something to continue. */
  const remember = (entry: AgentEntry): void => {
    void entry.handle.wait().then((result) => {
      if (result.status === "completed" && result.output !== undefined) {
        entry.transcript = result.output.transcript;
      }
    });
  };

  const start = (
    name: string,
    message: string,
    toolCallId: string,
    carried: AgentEntry["transcript"] | undefined,
    forkParent: boolean,
    agentType: string | undefined,
  ): { readonly entry: AgentEntry; readonly resolved: ResolvedRole } => {
    const resolved = resolveRole(options.roles ?? [], agentType, {
      model: options.model,
      allowedTools: [...(options.allowedTools ?? ["read_file"])],
      maxIterations: options.childMaxIterations,
    });
    const model = resolved.model;
    const channel = createSubagentInputChannel();
    const forkMessages =
      forkParent && options.parentMessages !== undefined ? options.parentMessages : undefined;
    const worker = createInteractiveChildWorker({
      provider: options.provider,
      permission: options.permission,
      ...(options.sandbox === undefined ? {} : { sandbox: options.sandbox }),
      ...(options.profile === undefined ? {} : { profile: options.profile }),
      message,
      ...(forkMessages === undefined ? {} : { forkMessages }),
      ...(carried === undefined ? {} : { forkTranscript: carried }),
      ...(model === undefined ? {} : { model: model }),
      ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
      ...(options.onEnvelope === undefined ? {} : { onEnvelope: options.onEnvelope }),
    });
    const handle = options.runtime.spawn<InteractiveChildResult>({
      name,
      lineage: {
        parentAgentId: "main-agent",
        rootAttemptId: `att-root-${toolCallId}`,
        toolCallId,
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
      transcript: carried ?? [],
    };
    agents.set(handle.subagentId, entry);
    remember(entry);
    // The resolution travels with the entry so the caller can report what the
    // role actually granted. Resolving twice would be two chances to disagree
    // with itself, and the second one would be the one the model reads.
    return { entry, resolved };
  };

  const run = async (call: ToolCallRequest): Promise<ToolOutcome> => {
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
        const { entry, resolved } = start(
          "subagent",
          message,
          call.toolCallId,
          undefined,
          forkParent,
          text(args, "agent_type"),
        );
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
        if (!entry.channel.deliver({ message, interrupt: flag(args, "interrupt") })) {
          return refuse("agent_closed", `Agent '${target}' is closed and takes no more input`);
        }
        submissions += 1;
        return ok({ submission_id: `sub-${submissions}` }, `queued for ${target}`);
      }

      case WAIT_AGENT_TOOL: {
        const targets = list(args, "targets");
        if (targets === undefined || targets.length === 0) {
          return refuse("invalid_arguments", "wait_agent requires at least one target");
        }
        const timeoutMs = number(args, "timeout_ms");
        const status: Record<string, SubagentStatus> = {};
        let timedOut = false;
        for (const target of targets) {
          const entry = agents.get(target);
          if (entry === undefined) {
            status[target] = "failed";
            continue;
          }
          const observed = await entry.handle.wait(timeoutMs);
          status[target] = observed.status;
          timedOut = timedOut || observed.observed === "timeout";
        }
        return ok({ status, timed_out: timedOut }, JSON.stringify({ status, timed_out: timedOut }));
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
        if (current !== "completed" && current !== "failed" && current !== "cancelled") {
          return refuse(
            "agent_still_running",
            `Agent '${target}' is '${current}'; it does not need resuming`,
          );
        }
        const carried =
          (await options.runtime.wait<InteractiveChildResult>(target)).output?.transcript ??
          entry.transcript;
        const { entry: entry2 } = start(entry.nickname, "Continue.", call.toolCallId, carried, false, undefined);
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
    // No signal: these tools either return at once or observe a subagent the
    // parent started. Aborting this call must not reach into an agent the
    // parent still owns — that is what `close_agent` is for.
    execute: (call) => run(call),
    async cancel(): Promise<void> {
      return;
    },
  };
}
