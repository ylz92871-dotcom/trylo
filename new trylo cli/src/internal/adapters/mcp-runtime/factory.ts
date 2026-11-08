import { resolve } from "node:path";
import type { McpStdioClient } from "../../ports/mcp-client.js";
import type { McpServerEntry } from "../../ports/mcp-registry.js";
import { createMcpHttpClient, type McpHttpClientSpec } from "../mcp-http/client.js";
import { createMcpStdioClient, type McpClientSpec } from "../mcp-stdio/client.js";

/**
 * One registry entry -> one connected-capable client, for all three transports.
 *
 * The claim "this build speaks stdio, http and sse" is only true if something
 * actually branches on `entry.transport`, and this is that one place. Keeping it
 * apart from the pool means the pool never has to know which transport it is
 * starting: it asks for a client and gets one, or gets a failure it can record.
 *
 * Two shapes are deliberately *not* produced here:
 *
 *  - **No defaulting of a missing url.** A remote entry without a url cannot be
 *    dialled, and guessing one from the command would be inventing
 *    configuration. It is a refusal with a code, reported per server.
 *  - **No throwing.** A build that cannot be made is data, because the caller's
 *    job is to keep every other server running (see `pool.ts`).
 *
 * The seams exist so the pool's own tests can drive it without a child process;
 * production passes nothing and gets the real clients.
 */

export type McpClientOpenFailure = {
  readonly ok: false;
  readonly code: "missing_url";
  readonly detail: string;
};

export type McpClientOpen =
  | { readonly ok: true; readonly client: McpStdioClient }
  | McpClientOpenFailure;

export type McpClientSeams = {
  readonly stdio?: (spec: McpClientSpec) => McpStdioClient;
  readonly remote?: (spec: McpHttpClientSpec) => McpStdioClient;
};

export function createClientForEntry(
  entry: McpServerEntry,
  cwd: string,
  seams: McpClientSeams = {},
): McpClientOpen {
  if (entry.transport === "stdio") {
    const build = seams.stdio ?? createMcpStdioClient;
    return {
      ok: true,
      client: build({
        serverId: entry.name,
        command: entry.command,
        args: entry.args,
        env: entry.env,
        cwd,
        workspaceRoot: resolve(cwd),
      }),
    };
  }

  const url = entry.url;
  if (url === undefined || url.length === 0) {
    return {
      ok: false,
      code: "missing_url",
      detail: `${entry.name} is registered as ${entry.transport} but carries no url`,
    };
  }

  const build = seams.remote ?? createMcpHttpClient;

  return {
    ok: true,
    client: build({
      serverId: entry.name,
      transport: entry.transport,
      url,
      ...(entry.headers === undefined ? {} : { headers: entry.headers }),
    }),
  };
}
