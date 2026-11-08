import type { CapabilityDemand, ToolLibrary, ToolLibraryContext, ToolLibraryFilter } from "../index.js";
import { libraryFailure } from "../service.js";

/** Register this host adapter in the shared protocol layer. Context comes from the host, never the payload. */
export function createToolLibraryCommandHandler(library: ToolLibrary) {
  return async (context: ToolLibraryContext, raw: unknown, signal: AbortSignal): Promise<unknown> => {
    if (!record(raw) || typeof raw.operation !== "string") return libraryFailure("invalid_command", "tool-library operation is required");

    if (signal.aborted) return libraryFailure("cancelled", "operation cancelled");

    if (raw.operation === "query") {
      if (raw.filter !== undefined && !filter(raw.filter)) return libraryFailure("invalid_filter", "invalid tool query");
      return library.query(context, raw.filter);
    }

    if (raw.operation === "resolve" || raw.operation === "configure") {
      if (!Array.isArray(raw.toolIds) || raw.toolIds.length > 256 || !raw.toolIds.every((id): id is string => typeof id === "string")) return libraryFailure("invalid_selection", "toolIds must be bounded strings");
      if (raw.operation === "configure") return library.configure(context, raw.toolIds);
      const result = await library.resolve(context, raw.toolIds);
      return result.ok ? { ok: true, value: { references: result.value.references, rejected: result.value.rejected } } : result;
    }

    if (raw.operation === "request") return demand(raw.demand) ? library.requestCapability(context, raw.demand, signal) : libraryFailure("invalid_demand", "capability demand is malformed");

    if (raw.operation === "get-request") return typeof raw.requestId === "string" ? library.getRequest(context, raw.requestId) : libraryFailure("invalid_request_id", "requestId is required");

    return libraryFailure("unknown_operation", "unsupported tool-library operation");
  };
}

function record(raw: unknown): raw is Record<string, unknown> { return raw !== null && typeof raw === "object" && !Array.isArray(raw); }

function demand(raw: unknown): raw is CapabilityDemand {
  return record(raw) && [raw.requestKey, raw.capability, raw.taskId].every(value => typeof value === "string" && value.length > 0 && value.length <= 512);
}

function filter(raw: unknown): raw is ToolLibraryFilter {
  return record(raw) && (raw.text === undefined || typeof raw.text === "string")
    && (raw.limit === undefined || typeof raw.limit === "number")
    && (raw.origin === undefined || ["builtin", "mcp", "plugin", "learned", "external"].includes(String(raw.origin)));
}
