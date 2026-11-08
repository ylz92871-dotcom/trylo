import type { JsonObject } from "../protocol/envelope.js";
import type {
  McpServerInfo,
  McpStdioClient,
  McpToolOutcome,
  McpToolSpec,
} from "../ports/mcp-client.js";
import { qualifyMcpToolName } from "./names.js";
import type {
  McpRegistryPort,
  McpServerEntry,
} from "../ports/mcp-registry.js";

/**
 * A test-only composition root: registry + client, wired into one handle.
 *
 * This module exists so the contract tests can prove the two halves actually
 * meet — that a server added through the registry becomes a connected child
 * whose published tools are addressable by `mcp__<server>__<tool>`. It is the
 * "fake composition root" the work package calls for: production `surface/cli`
 * must never import it, because real wiring (which servers to start, when to
 * approve a call, how to interrupt) belongs to HY4's combination layer, not to
 * this package.
 *
 * It deliberately does *not* answer any permission question. Opening a session
 * performs `initialize` + `tools/list` and nothing else; every `call` is still
 * handed a finite deadline by its caller, and the specs it returns still carry
 * `needsApproval: true`. This root can start a server and ask it a question; it
 * cannot authorise the answer.
 */

/** A mapping that builds a live client for one resolved registry entry. */
export type McpClientFactory = (entry: McpServerEntry, cwd: string) => McpStdioClient;

export type McpSessionFailure = {
  readonly ok: false;
  readonly code: string;
  readonly detail: string;
};

export type McpCallResult =
  | { readonly ok: true; readonly outcome: McpToolOutcome }
  | McpSessionFailure;

/** One connected, listed server, with its supplies already mounted. */
export type McpLiveSession = {
  readonly serverId: string;
  readonly info: McpServerInfo;
  readonly tools: ReadonlyArray<McpToolSpec>;
  call(
    serverToolName: string,
    args: JsonObject,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<McpCallResult>;
  close(): Promise<void>;
};

export type McpSessionRoot = {
  readonly registry: McpRegistryPort;
  open(name: string): Promise<{ readonly ok: true; readonly value: McpLiveSession } | McpSessionFailure>;
  closeAll(): Promise<void>;
};

export function createMcpSession(options: {
  readonly registry: McpRegistryPort;
  readonly cwd: string;
  readonly clientFactory: McpClientFactory;
}): McpSessionRoot {
  const live = new Map<string, McpStdioClient>();

  return {
    registry: options.registry,

    async open(name) {
      const resolved = await options.registry.resolve(name);
      if (!resolved.ok) {
        return { ok: false, code: resolved.code, detail: resolved.detail };
      }

      const entry = resolved.value.entry;
      const client = options.clientFactory(entry, options.cwd);

      const connected = await client.connect();
      if (!connected.ok) {
        await client.close();
        return { ok: false, code: connected.code, detail: connected.detail };
      }

      const listed = await client.listTools();
      if (!listed.ok) {
        await client.close();
        return { ok: false, code: listed.code, detail: listed.detail };
      }

      // Publish only after initialization and tool discovery both succeed.
      live.set(name, client);

      return { ok: true, value: wrapSession(name, connected.value, listed.value, client) };
    },

    async closeAll() {
      await Promise.all([...live.values()].map((client) => client.close()));
      live.clear();
    },
  };
}

function wrapSession(
  serverId: string,
  info: McpServerInfo,
  tools: ReadonlyArray<McpToolSpec>,
  client: McpStdioClient,
): McpLiveSession {
  return {
    serverId,
    info,
    tools,
    async call(serverToolName, args, timeoutMs, signal) {
      const qualified = qualifyMcpToolName(serverId, serverToolName);
      if (!qualified.ok) {
        return { ok: false, code: qualified.code, detail: qualified.detail };
      }

      const result = await client.callTool({
        qualifiedName: qualified.value,
        arguments: args,
        timeoutMs,
        ...(signal === undefined ? {} : { signal }),
      });
      if (!result.ok) {
        return { ok: false, code: result.code, detail: result.detail };
      }

      return { ok: true, outcome: result.outcome };
    },
    async close() {
      await client.close();
    },
  };
}
