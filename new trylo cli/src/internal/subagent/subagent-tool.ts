import type { ProfilePort } from "../contract/profile.js";
import type { Message } from "../contract/execution.js";
import type { PermissionPort } from "../ports/permission.js";
import type { ProviderPort } from "../ports/provider.js";
import type {
  ToolBinding,
  ToolCallRequest,
  ToolOutcome,
  ToolPort,
  ToolSandbox,
} from "../ports/tools.js";
import type { Envelope, JsonObject } from "../protocol/envelope.js";
import { createChildAttemptWorker, DEFAULT_PROFILE_PORT } from "./child-attempt.js";
import { SubagentRuntime } from "./runtime.js";
import { SUBAGENT_TOOL_NAME } from "./names.js";

export { SUBAGENT_TOOL_NAME };

export type SubagentToolOptions = {
  readonly callerMessages?: ReadonlyArray<Message>;
  readonly runtime: SubagentRuntime;
  readonly provider: ProviderPort;
  readonly permission: PermissionPort;
  readonly sandbox?: ToolSandbox;
  readonly profile?: ProfilePort | undefined;
  /**
   * The model the child attempt asks for. A parent running on a real endpoint
   * must hand its own model down: the engine's fallback is the literal
   * `"default"`, which real providers reject (live-machine finding: every
   * `delegate_subagent` child died with model_not_found).
   */
  readonly model?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly defaultAllowedTools?: ReadonlyArray<string> | undefined;
  readonly onEnvelope?: ((envelope: Envelope) => void) | undefined;
};

export const DELEGATE_SUBAGENT_BINDING: ToolBinding = {
  name: SUBAGENT_TOOL_NAME,
  description: "Delegate a sub-task to a bounded subagent worker. Runs to completion and returns the result.",
  sideEffect: "read_only",
  needsApproval: false,
  timeoutMs: 60_000,
  outputLimits: {
    maxBytes: 65_536,
    maxLines: 1_000,
  },
  parameters: {
    type: "object",
    properties: {
      taskName: {
        type: "string",
        description: "Descriptive name for the subagent task",
      },
      prompt: {
        type: "string",
        description: "Task instruction or prompt for the subagent to execute",
      },
      allowedTools: {
        type: "array",
        items: { type: "string" },
        description: "Tool names the subagent is authorized to use (defaults to read_file)",
      },
      timeoutMs: {
        type: "number",
        description: "Optional timeout in milliseconds",
      },
    },
    required: ["taskName", "prompt"],
  },
};

export function createSubagentToolPort(options: SubagentToolOptions): ToolPort {
  const inFlightSubagents = new Map<string, string>(); // toolCallId -> subagentId

  return {
    snapshot(): ReadonlyArray<ToolBinding> {
      return [DELEGATE_SUBAGENT_BINDING];
    },

    async execute(call: ToolCallRequest, signal: AbortSignal): Promise<ToolOutcome> {
      if (call.name !== SUBAGENT_TOOL_NAME) {
        return {
          outcome: "error",
          code: "unknown_tool",
          message: `Subagent tool received call for unknown tool '${call.name}'`,
        };
      }

      const taskName = typeof call.arguments["taskName"] === "string"
        ? call.arguments["taskName"]
        : "subagent_task";
      const prompt = typeof call.arguments["prompt"] === "string"
        ? call.arguments["prompt"]
        : "";
      const allowedTools: string[] = Array.isArray(call.arguments["allowedTools"])
        ? (call.arguments["allowedTools"] as string[])
        : (options.defaultAllowedTools ? [...options.defaultAllowedTools] : ["read_file"]);
      const timeoutMs = typeof call.arguments["timeoutMs"] === "number"
        ? call.arguments["timeoutMs"]
        : undefined;

      const worker = createChildAttemptWorker({
        provider: options.provider,
        permission: options.permission,
        ...(options.sandbox === undefined ? {} : { sandbox: options.sandbox }),
        profile: options.profile ?? DEFAULT_PROFILE_PORT,
        ...(options.model !== undefined ? { model: options.model } : {}),
        sessionId: options.sessionId,
        prompt,
        ...(options.callerMessages === undefined ? {} : { callerMessages: options.callerMessages }),
        onEnvelope: options.onEnvelope,
      });

      const handle = options.runtime.spawn({
        name: taskName,
        prompt,
        lineage: {
          parentAgentId: "main-agent",
          rootAttemptId: `att-root-${call.toolCallId}`,
          toolCallId: call.toolCallId,
        },
        permissions: {
          allowedTools,
        },
        ...(timeoutMs !== undefined ? { governance: { timeoutMs } } : {}),
        worker,
      });

      inFlightSubagents.set(call.toolCallId, handle.subagentId);

      // Abort subagent if caller signal aborts
      const onAbort = () => {
        void handle.cancel("parent_signal_aborted");
      };
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }

      try {
        const res = await handle.wait(timeoutMs);

        if (res.status === "completed") {
          const outputText = res.output?.output ?? `Subagent '${taskName}' completed.`;
          return {
            outcome: "result",
            value: {
              status: "completed",
              subagentId: handle.subagentId,
              output: outputText,
              usage: res.usage as unknown as JsonObject,
            },
            output: outputText,
            truncated: false,
          };
        }

        if (res.status === "cancelled") {
          // The caller aborted this call, so the subagent was cancelled with
          // it. `cancelled` is a state, not a tool failure: the loop must not
          // report an interrupt to the model as something that went wrong.
          return { outcome: "cancelled" };
        }

        // Only a terminal reaches here: this tool's `timeoutMs` also arms the
        // delegation's execution timeout (`governance.timeoutMs` above), which
        // is armed first and therefore ends the run before this wait could give
        // up on a live one. So the answer is about a settled run, never about
        // one still running.
        return {
          outcome: "error",
          code: res.error?.code ?? `subagent_${res.status}`,
          message: res.error?.message ?? `Subagent '${taskName}' ended with status: ${res.status}`,
        };
      } finally {
        signal.removeEventListener("abort", onAbort);
        inFlightSubagents.delete(call.toolCallId);
      }
    },

    async cancel(toolCallId: string): Promise<void> {
      const subagentId = inFlightSubagents.get(toolCallId);
      if (subagentId) {
        await options.runtime.cancel(subagentId, "tool_call_cancelled");
      }
    },
  };
}

/**
 * Puts the subagent ports in front of the parent's tools.
 *
 * Takes any number of them, because the surface is more than one tool: the
 * blocking `delegate_subagent` and the C43 control tools (`spawn_agent` and
 * friends) have to answer under the same name lookup and the same cancel path —
 * two mounts that each kept their own copy of that rule would be two rules.
 * A name that no child claims still belongs to the parent.
 */
export function mountSubagentTool(parentTools: ToolPort, ...children: ReadonlyArray<ToolPort>): ToolPort {
  const owner = new Map<string, ToolPort>();
  for (const child of children) {
    for (const binding of child.snapshot()) {
      owner.set(binding.name, child);
    }
  }
  return {
    snapshot(): ReadonlyArray<ToolBinding> {
      return [...parentTools.snapshot(), ...children.flatMap((child) => child.snapshot())];
    },

    async execute(call: ToolCallRequest, signal: AbortSignal): Promise<ToolOutcome> {
      const child = owner.get(call.name);
      if (child !== undefined) {
        return child.execute(call, signal);
      }
      return parentTools.execute(call, signal);
    },

    async cancel(toolCallId: string): Promise<void> {
      await parentTools.cancel(toolCallId);
      for (const child of children) {
        await child.cancel(toolCallId);
      }
    },
  };
}
