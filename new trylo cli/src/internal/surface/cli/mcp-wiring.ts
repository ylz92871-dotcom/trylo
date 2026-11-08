import { createMcpRegistry, type McpRegistryPaths } from "../../adapters/mcp-registry/store.js";
import { withRuntimeRegistry } from "../../adapters/mcp-registry/runtime-overlay.js";
import { createClientForEntry } from "../../adapters/mcp-runtime/factory.js";
import { openMcpPool, type McpPool } from "../../adapters/mcp-runtime/pool.js";
import type {
  McpRegistryFailureCode,
  McpRegistryPort,
} from "../../ports/mcp-registry.js";
import { EXIT_CODES, type ExitCode } from "../../protocol/cli-stream.js";
import { tryloHome } from "./session-paths.js";

/**
 * The CLI's one binding to the MCP server registry.
 *
 * Everything that knows how a registry file is locked, read and replaced lives
 * behind `McpRegistryPort`. This module decides only two things: where the two
 * files are, and what a port failure means for the process exit code. It is the
 * management-plane counterpart of `credentials-wiring.ts`, and it exists so no
 * command handler has to name a path.
 *
 * Scopes follow the same roots the rest of the profile uses — `tryloHome()` for
 * the user file, the workspace for the project file — so a registry can never
 * end up on a different volume than the sessions and credentials it sits next
 * to. `tryloHome` is reused rather than restated: there is one definition of
 * where the profile lives.
 */

/** The slice of the CLI context the registry binding needs. */
export type McpWiringContext = {
  readonly homeDir: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
};

export const MCP_REGISTRY_FILE_NAME = "mcp-servers.json";

export function mcpRegistryPaths(ctx: McpWiringContext): McpRegistryPaths {
  return {
    userFile: `${tryloHome(ctx.homeDir, ctx.env)}/${MCP_REGISTRY_FILE_NAME}`,
    projectFile: `${ctx.cwd}/.trylo/${MCP_REGISTRY_FILE_NAME}`,
  };
}

export function createCliMcpRegistry(ctx: McpWiringContext): McpRegistryPort {
  const base = createMcpRegistry(mcpRegistryPaths(ctx));
  const file = ctx.env.TRYLO_MCP_RUNTIME_REGISTRY;
  if (!file) return base;

  const mode = ctx.env.TRYLO_MCP_RUNTIME_MODE ?? "overlay";
  if (mode !== "overlay" && mode !== "exclusive") {
    const failure = { ok: false as const, code: "invalid_document" as const, detail: "unknown runtime MCP registry mode" };
    return { ...base, names: async () => failure, resolve: async () => failure, list: async () => failure };
  }

  const runtime = createMcpRegistry({ userFile: file, projectFile: file, required: true });

  return withRuntimeRegistry(base, runtime, mode);
}

/**
 * Opens every enabled server the way a run does — eagerly, fail-soft, one
 * fact per server — so `trylo mcp status` reports what a run would actually
 * see rather than what the registry files declare. The pool is closed by the
 * caller; a status probe never leaves children behind.
 */
export async function openMcpStatusPool(ctx: McpWiringContext): Promise<McpPool> {
  const pool = await openMcpPool({
    registry: createCliMcpRegistry(ctx),
    cwd: ctx.cwd,
    clientFor: createClientForEntry,
  });
  return pool;
}

/**
 * Failure code -> exit code, exhaustive over the port's closed failure set.
 *
 * Three buckets (WP B 波):
 *
 *  - **`USAGE`** — the invocation asked for something the registry cannot
 *    represent (a bad name, a duplicate, a transport it does not speak). The
 *    user can fix it by typing something else.
 *  - **`CONFIG`** — a file on disk is not a registry this build can read. That
 *    is not the caller's fault and not an execution failure; it is the same
 *    class as an unreadable `config.json`.
 *  - **`EXECUTION_FAILURE` / `TEMPORARY`** — the file could not be reached or
 *    written. A `lock_conflict` is the one code an outer caller may retry, so
 *    it is the one that gets the retryable exit code.
 *
 * The `Record` type makes adding a code to the port a compile error here rather
 * than a silently mis-filed exit code.
 */
const MCP_REGISTRY_EXIT_CODES: Readonly<Record<McpRegistryFailureCode, ExitCode>> = {
  invalid_name: EXIT_CODES.USAGE,
  invalid_transport: EXIT_CODES.USAGE,
  unsupported_transport: EXIT_CODES.USAGE,
  invalid_command: EXIT_CODES.USAGE,
  invalid_args: EXIT_CODES.USAGE,
  invalid_env: EXIT_CODES.USAGE,
  invalid_url: EXIT_CODES.USAGE,
  invalid_headers: EXIT_CODES.USAGE,
  invalid_enabled: EXIT_CODES.USAGE,
  duplicate_entry: EXIT_CODES.USAGE,
  missing_entry: EXIT_CODES.USAGE,
  unknown_format_version: EXIT_CODES.CONFIG,
  unknown_key: EXIT_CODES.CONFIG,
  invalid_document: EXIT_CODES.CONFIG,
  checksum_mismatch: EXIT_CODES.CONFIG,
  read_failed: EXIT_CODES.EXECUTION_FAILURE,
  write_failed: EXIT_CODES.EXECUTION_FAILURE,
  lock_conflict: EXIT_CODES.TEMPORARY,
  directory_unavailable: EXIT_CODES.EXECUTION_FAILURE,
};

export function mcpRegistryExitCode(code: McpRegistryFailureCode): ExitCode {
  return MCP_REGISTRY_EXIT_CODES[code];
}
