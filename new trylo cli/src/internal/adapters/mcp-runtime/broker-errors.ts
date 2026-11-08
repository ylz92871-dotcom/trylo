import type { ToolOutcome } from "../../ports/tools.js";

/** Only the local HTTP transport may establish whether a broker call was sent. */
export type BrokerRequestDelivery = "not_dispatched" | "unknown";

export class McpBrokerTransportError extends Error {
  override readonly name = "McpBrokerTransportError";

  private constructor(
    readonly delivery: BrokerRequestDelivery,
    readonly code: "mcp_broker_unavailable" | "mcp_broker_delivery_unknown",
    readonly connectionCode: string | undefined,
    cause: unknown,
  ) {
    super(delivery === "not_dispatched"
      ? `MCP broker connection failed before dispatch (${connectionCode}). This tool did not execute. Reconnect the tool service or choose another available tool.`
      : "MCP broker delivery could not be confirmed. The operation may have executed. Inspect the tool and workspace state; do not repeat this operation until its result is reconciled.",
    { cause });
  }

  static from(error: unknown): McpBrokerTransportError {
    const connectionCode = undispatchedConnectionCode(error);
    if (connectionCode !== undefined) {
      return new McpBrokerTransportError("not_dispatched", "mcp_broker_unavailable", connectionCode, error);
    }
    return new McpBrokerTransportError("unknown", "mcp_broker_delivery_unknown", undefined, error);
  }
}

/** Fetch exposes the native failure as its cause. A code without its connection
 * phase, a server-supplied object, a reset or a timeout cannot prove delivery. */
function undispatchedConnectionCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || !(error.cause instanceof Error)) return undefined;
  const cause = error.cause;
  if (!("code" in cause) || !("syscall" in cause)) return undefined;
  if ((cause.code === "ECONNREFUSED" || cause.code === "ENETUNREACH") && cause.syscall === "connect") return cause.code;
  return cause.code === "ENOTFOUND" && cause.syscall === "getaddrinfo" ? cause.code : undefined;
}

export function brokerRequestError(error: unknown): McpBrokerTransportError {
  return error instanceof McpBrokerTransportError ? error : McpBrokerTransportError.from(error);
}

/** Preserve trusted delivery evidence at every public MCP tool boundary. */
export function brokerToolOutcome(error: unknown): ToolOutcome | undefined {
  if (!(error instanceof McpBrokerTransportError)) return undefined;
  return { outcome: error.delivery === "not_dispatched" ? "error" : "unknown", code: error.code, message: error.message };
}
