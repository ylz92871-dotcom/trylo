import type { JsonObject } from "../../protocol/envelope.js";
import type { McpCallFailureCode } from "../../ports/mcp-client.js";
import type { ToolCallRequest, ToolOutcome, ToolPort } from "../../ports/tools.js";
import { deliverMcpImages } from "./image-delivery.js";
import {
  MAX_MCP_CALL_TIMEOUT_MS,
  MIN_MCP_CALL_TIMEOUT_MS,
  type McpMountedTool,
} from "./mount.js";

/**
 * Calling one mounted MCP tool.
 *
 * The router is a map from qualified name to the server that published it, so a
 * call can only ever reach the server that owns the name. Everything else here
 * is the same three duties every tool adapter has, stated once:
 *
 *  - **A deadline.** Absent an argument the binding's `timeoutMs` applies;
 *    a value outside the bounds is a caller error, refused rather than
 *    silently clamped, because a clamped deadline hides a model that does not
 *    understand the tool it is calling. The client enforces the deadline by
 *    clock, not by trust.
 *  - **A cancellation.** `ToolPort.cancel` has to reach the *in-flight* call,
 *    so every call keeps an `AbortController` of its own, keyed by the tool
 *    call id. A turn cancel that only stopped the next call would leave a child
 *    process answering a question nobody is waiting for.
 *  - **A failure code.** An MCP failure is mapped through one explicit table
 *    (WP §4-D3) and never retried here: a timeout, a crashed child and a
 *    protocol error are all facts the journal should carry once.
 *
 * `cancelled` keeps its own terminal state for the same reason it does
 * everywhere else: an interrupt is not a failure, and reporting it as one would
 * tell the model the tool broke.
 */

const MCP_CALL_FAILURE_CODES: Readonly<Record<McpCallFailureCode, string>> = {
  not_initialized: "mcp_not_initialized",
  unknown_tool: "mcp_unknown_tool",
  invalid_arguments: "mcp_invalid_arguments",
  timeout: "mcp_timeout",
  child_crashed: "mcp_child_crashed",
  framing: "mcp_framing",
  protocol_error: "mcp_protocol_error",
  capability_unsupported: "mcp_capability_unsupported",
  needs_auth: "mcp_needs_auth",
  stderr_overflow: "mcp_stderr_overflow",
};

export function createMcpToolPort(mounted: ReadonlyArray<McpMountedTool>, workspaceRoot?: string): ToolPort {
  const byName = new Map<string, McpMountedTool>(mounted.map((item) => [item.binding.name, item]));
  const inFlight = new Map<string, AbortController>();

  return {
    snapshot: () => mounted.map((item) => item.binding),

    async execute(call: ToolCallRequest, signal: AbortSignal): Promise<ToolOutcome> {
      const route = byName.get(call.name);
      if (route === undefined) {
        return {
          outcome: "error",
          code: "mcp_unknown_tool",
          message: `mcp_unknown_tool:${call.name} is not mounted`,
        };
      }
      if (signal.aborted) {
        return { outcome: "cancelled" };
      }
      const deadline = callTimeoutMs(call.arguments, route.binding.timeoutMs);
      if (deadline === undefined) {
        return {
          outcome: "error",
          code: "mcp_invalid_arguments",
          message: `mcp_invalid_arguments:timeoutMs must be between ${MIN_MCP_CALL_TIMEOUT_MS} and ${MAX_MCP_CALL_TIMEOUT_MS}`,
        };
      }
      const controller = new AbortController();
      const onAbort = (): void => controller.abort();
      signal.addEventListener("abort", onAbort, { once: true });
      inFlight.set(call.toolCallId, controller);
      try {
        const result = await route.server.call(
          route.spec.serverToolName,
          call.arguments,
          deadline,
          controller.signal,
        );
        return result.ok
          ? await deliverMcpImages(result.outcome, workspaceRoot, controller.signal)
          : {
              outcome: "error",
              code: mcpFailureCode(result.code),
              message: result.detail,
            };
      } catch (error) {
        const detail = error instanceof Error ? error.message : "mcp_adapter_exception";
        return { outcome: "unknown", code: "mcp_adapter_exception", message: detail };
      } finally {
        inFlight.delete(call.toolCallId);
        signal.removeEventListener("abort", onAbort);
      }
    },

    async cancel(toolCallId: string): Promise<void> {
      inFlight.get(toolCallId)?.abort();
    },
  };
}

/**
 * A failure code as this adapter reports it.
 *
 * The table is a `Record` over the port's closed set so a new code is a compile
 * error rather than a silently unmapped string; anything that reaches here from
 * outside that set (the pool's own `adapter_exception`, a name failure) passes
 * through unchanged rather than being flattened into a generic code.
 */
export function mcpFailureCode(code: string): string {
  return Object.prototype.hasOwnProperty.call(MCP_CALL_FAILURE_CODES, code)
    ? MCP_CALL_FAILURE_CODES[code as McpCallFailureCode]
    : code;
}

/**
 * The deadline for one call: the argument when the model supplied a usable one,
 * the binding's own otherwise, and `undefined` — a refusal — when the argument
 * was present but unusable.
 */
export function callTimeoutMs(args: JsonObject, fallback: number): number | undefined {
  const value = args["timeoutMs"];
  if (value === undefined) {
    return fallback;
  }
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < MIN_MCP_CALL_TIMEOUT_MS ||
    value > MAX_MCP_CALL_TIMEOUT_MS
  ) {
    return undefined;
  }
  return value;
}
