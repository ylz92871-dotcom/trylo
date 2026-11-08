import type { JsonObject } from "../../protocol/envelope.js";
import type {
  McpResourceFailure,
  McpResourceListResult,
  McpResourceReadResult,
  McpResourceTemplatesResult,
  McpStdioClient,
  McpToolOutcome,
  McpToolSpec,
} from "../../ports/mcp-client.js";
import type { McpRegistryDiagnostic, McpRegistryPort, McpServerEntry } from "../../ports/mcp-registry.js";
import { qualifyMcpToolName } from "../../mcp/names.js";
import { registryDiagnosticWarning } from "../mcp-registry/diagnostics.js";
import type { McpClientOpen } from "./factory.js";

/**
 * Eager open, fail-soft, one fact per server.
 *
 * A run starts every enabled server before the first provider request, and a
 * server that will not start does not take the run down. That is the whole
 * point of the shape: an MCP server is a *tool supplier*, not a dependency of
 * the turn, so the honest reading of "this one did not come up" is a recorded
 * fact and a smaller tool table — never a hung run. Codex's `required: true`
 * escape hatch is deliberately not implemented here (OPEN-1); every server is
 * optional.
 *
 * The registry is read the way the port defines it: `names()` says which ids
 * exist, `resolve()` says what a scope-merged entry actually is. A registry
 * that cannot be read at all yields an empty pool plus one failure, which is
 * the same observable state as "no servers configured" for the run while still
 * being reportable — the caller turns that failure into a warning line.
 */

export type McpRuntimeCall =
  | { readonly ok: true; readonly outcome: McpToolOutcome }
  | { readonly ok: false; readonly code: string; readonly detail: string };

export type McpResourceCall<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: string; readonly detail: string };

export type McpRuntimeServer = {
  readonly serverId: string;
  readonly tools: ReadonlyArray<McpToolSpec>;
  call(
    serverToolName: string,
    args: JsonObject,
    timeoutMs: number | undefined,
    signal: AbortSignal,
  ): Promise<McpRuntimeCall>;
  /** `resources/list` under a finite deadline. Failures are values, never throws. */
  listResources(cursor?: string, timeoutMs?: number): Promise<McpResourceCall<McpResourceListResult>>;
  /** `resources/templates/list` under a finite deadline. */
  listResourceTemplates(cursor?: string, timeoutMs?: number): Promise<McpResourceCall<McpResourceTemplatesResult>>;
  /** `resources/read` with an optional caller deadline. The URI travels verbatim. */
  readResource(uri: string, timeoutMs: number | undefined, signal: AbortSignal): Promise<McpResourceCall<McpResourceReadResult>>;
  close(): Promise<void>;
};

export type McpOpenFailure = {
  readonly serverId: string;
  readonly code: string;
  readonly detail: string;
  readonly registryDiagnostic?: McpRegistryDiagnostic;
};

export type McpSkippedServer = {
  readonly serverId: string;
  readonly reason: "disabled";
};

/** Header *names* of one configured entry; a value never leaves the store. */
export type McpHeaderKeys = {
  readonly serverId: string;
  readonly keys: ReadonlyArray<string>;
};

export type McpPool = {
  readonly servers: ReadonlyArray<McpRuntimeServer>;
  readonly failures: ReadonlyArray<McpOpenFailure>;
  readonly skipped: ReadonlyArray<McpSkippedServer>;
  /**
   * Every enabled entry's header names — including the entries that never
   * came up. Reported per *entry* rather than per live server because that is
   * the question a user checking their own configuration is asking: "what did
   * I write", not "what answered". A value is never part of this.
   */
  readonly headerKeys: ReadonlyArray<McpHeaderKeys>;
  closeAll(): Promise<void>;
};

export type McpPoolInput = {
  readonly registry: McpRegistryPort;
  readonly cwd: string;
  readonly clientFor: (entry: McpServerEntry, cwd: string) => McpClientOpen;
};

type PoolState = {
  readonly live: McpStdioClient[];
  readonly servers: McpRuntimeServer[];
  readonly failures: McpOpenFailure[];
  readonly skipped: McpSkippedServer[];
  readonly headerKeys: McpHeaderKeys[];
};

/** Bound child startup pressure while independent handshakes overlap. */
const STARTUP_CONCURRENCY = 4;

function emptyPoolState(): PoolState {
  return { live: [], servers: [], failures: [], skipped: [], headerKeys: [] };
}

export async function openMcpPool(input: McpPoolInput): Promise<McpPool> {
  const state = emptyPoolState();
  const names = await input.registry.names();
  if (!names.ok) {
    state.failures.push({ serverId: "", code: names.code, detail: names.detail });
    return poolOf(state);
  }

  for (const diagnostic of names.diagnostics ?? []) {
    state.failures.push({ serverId: "", code: diagnostic.code,
      detail: registryDiagnosticWarning(diagnostic), registryDiagnostic: diagnostic });
  }

  // Each server owns its result until all workers settle. Publication stays
  // in registry order, so completion timing cannot change the tool catalog.
  const pending = names.value.map(name => ({ name, state: emptyPoolState() }));
  const queue = pending.values();
  const worker = async (): Promise<void> => {
    for (const item of queue) await openOne(input, item.state, item.name);
  };
  const outcomes = await Promise.allSettled(Array.from({ length: Math.min(STARTUP_CONCURRENCY, pending.length) }, worker));

  for (const item of pending) {
    state.live.push(...item.state.live);
    state.servers.push(...item.state.servers);
    state.failures.push(...item.state.failures);
    state.skipped.push(...item.state.skipped);
    state.headerKeys.push(...item.state.headerKeys);
  }

  const rejected = outcomes.find(outcome => outcome.status === "rejected");
  if (rejected?.status === "rejected") {
    await poolOf(state).closeAll();
    throw rejected.reason;
  }

  return poolOf(state);
}

/** One server, start to listed. Every step below is a recorded fact, not a throw. */
async function openOne(input: McpPoolInput, state: PoolState, name: string): Promise<void> {
  const resolved = await input.registry.resolve(name);
  if (!resolved.ok) {
    state.failures.push({ serverId: name, code: resolved.code, detail: resolved.detail });
    return;
  }

  const entry = resolved.value.entry;
  if (!entry.enabled) {
    state.skipped.push({ serverId: name, reason: "disabled" });
    return;
  }

  const headerKeys = Object.keys(entry.headers ?? {}).sort();
  if (headerKeys.length > 0) {
    state.headerKeys.push({ serverId: name, keys: headerKeys });
  }

  const opened = input.clientFor(entry, input.cwd);
  if (!opened.ok) {
    state.failures.push({ serverId: name, code: opened.code, detail: opened.detail });
    return;
  }

  const client = opened.client;
  const started = await startClient(client, entry);
  if (!started.ok) {
    await closeQuietly(client);
    state.failures.push({ serverId: name, code: started.code, detail: started.detail });
    return;
  }

  state.live.push(client);
  state.servers.push(serverOf(entry, client, started.tools));
}

type Started =
  | { readonly ok: true; readonly tools: ReadonlyArray<McpToolSpec> }
  | { readonly ok: false; readonly code: string; readonly detail: string };

/**
 * The two calls that make a server *listed* rather than merely spawned.
 *
 * A client that throws is `adapter_exception` rather than a propagated error:
 * the transport implementations report failures as values, so a throw here is a
 * bug in the layer below, and the run still must not die of it.
 */
async function startClient(client: McpStdioClient, entry: McpServerEntry): Promise<Started> {
  try {
    const connected = await client.connect();
    if (!connected.ok) {
      return { ok: false, code: connected.code, detail: connected.detail };
    }

    const listed = await client.listTools();
    if (!listed.ok) {
      return { ok: false, code: listed.code, detail: listed.detail };
    }

    return { ok: true, tools: listed.value };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "mcp_adapter_exception";
    return { ok: false, code: "adapter_exception", detail: `${entry.name}: ${detail}` };
  }
}

function serverOf(
  entry: McpServerEntry,
  client: McpStdioClient,
  tools: ReadonlyArray<McpToolSpec>,
): McpRuntimeServer {
  return {
    serverId: entry.name,
    tools,
    async call(serverToolName, args, timeoutMs, signal) {
      const qualified = qualifyMcpToolName(entry.name, serverToolName);
      if (!qualified.ok) {
        return { ok: false, code: qualified.code, detail: qualified.detail };
      }

      try {
        const result = await client.callTool({
          qualifiedName: qualified.value,
          arguments: args,
          timeoutMs,
          signal,
        });
        return result.ok
          ? { ok: true, outcome: result.outcome }
          : { ok: false, code: result.code, detail: result.detail };
      } catch (error) {
        const detail = error instanceof Error ? error.message : "mcp_adapter_exception";
        return { ok: false, code: "adapter_exception", detail };
      }
    },
    async listResources(cursor, timeoutMs) {
      return resourceCall(() => client.listResources(cursor, timeoutMs));
    },
    async listResourceTemplates(cursor, timeoutMs) {
      return resourceCall(() => client.listResourceTemplates(cursor, timeoutMs));
    },
    async readResource(uri, timeoutMs, signal) {
      return resourceCall(() => client.readResource({ uri, timeoutMs, signal }));
    },
    async close() {
      await client.close();
    },
  };
}

/**
 * One resource round trip as a value. The transport implementations report
 * failures as values, so a throw here is a bug in the layer below — recorded
 * as `adapter_exception` while the run keeps its other servers, exactly like
 * `call` above rather than in a second vocabulary.
 */
async function resourceCall<T>(
  roundTrip: () => Promise<{ readonly ok: true; readonly value: T } | McpResourceFailure>,
): Promise<McpResourceCall<T>> {
  try {
    const result = await roundTrip();
    return result.ok
      ? { ok: true, value: result.value }
      : { ok: false, code: result.code, detail: result.detail };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "mcp_adapter_exception";
    return { ok: false, code: "adapter_exception", detail };
  }
}

function poolOf(state: PoolState): McpPool {
  return {
    servers: state.servers,
    failures: state.failures,
    skipped: state.skipped,
    headerKeys: state.headerKeys,
    async closeAll() {
      const live = [...state.live];
      state.live.length = 0;
      await Promise.all(live.map((client) => closeQuietly(client)));
    },
  };
}

async function closeQuietly(client: McpStdioClient): Promise<void> {
  try {
    await client.close();
  } catch {
    // A server that cannot be closed cleanly is still not a reason to leave
    // the run's other servers open: the process exit is the backstop.
  }
}
