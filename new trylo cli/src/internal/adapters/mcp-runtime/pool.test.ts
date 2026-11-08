import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  McpCallFailureCode,
  McpConnectFailureCode,
  McpStdioClient,
  McpToolListFailureCode,
  McpToolOutcome,
  McpToolSpec,
} from "../../ports/mcp-client.js";
import type { McpRegistryPort, McpServerEntry } from "../../ports/mcp-registry.js";
import { createClientForEntry } from "./factory.js";
import { openMcpPool } from "./pool.js";

/**
 * Pool contracts: eager, fail-soft, one fact per server.
 *
 * The behaviours worth pinning are the *negative* ones — a server that will not
 * start must not stop the others, must not be silently reported as absent, and
 * must not leave a child behind. Each test below states which of those three it
 * is about.
 */

function entry(over: Partial<McpServerEntry> & { readonly name: string }): McpServerEntry {
  return {
    name: over.name,
    transport: over.transport ?? "stdio",
    command: over.command ?? "node",
    args: over.args ?? [],
    env: over.env ?? {},
    enabled: over.enabled ?? true,
    ...(over.url === undefined ? {} : { url: over.url }),
    ...(over.headers === undefined ? {} : { headers: over.headers }),
  };
}

function spec(serverId: string, tool: string, description = "does a thing"): McpToolSpec {
  return {
    serverToolName: tool,
    qualifiedName: `mcp__${serverId}__${tool}`,
    serverId,
    description,
    inputSchema: { type: "object" },
    annotations: {},
    annotationsTrust: "untrusted",
    needsApproval: true,
  };
}

type FakeBehaviour = {
  readonly tools?: ReadonlyArray<McpToolSpec>;
  readonly connectFails?: McpConnectFailureCode;
  readonly listFails?: McpToolListFailureCode;
  readonly callFails?: McpCallFailureCode;
  readonly outcome?: McpToolOutcome;
};

function fakeClient(behaviour: FakeBehaviour = {}) {
  const state = { closed: false, calls: [] as string[] };
  const ok = {
    name: "fake",
    version: "1.0.0",
    protocolVersion: "2025-03-26" as const,
    capabilities: {},
  };
  const client: McpStdioClient = {
    async connect() {
      return behaviour.connectFails === undefined
        ? { ok: true, value: ok }
        : { ok: false, code: behaviour.connectFails, detail: "refused on purpose" };
    },
    async listTools() {
      return behaviour.listFails === undefined
        ? { ok: true, value: behaviour.tools ?? [] }
        : { ok: false, code: behaviour.listFails, detail: "listing refused on purpose" };
    },
    async callTool(request) {
      state.calls.push(request.qualifiedName);

      if (behaviour.callFails !== undefined) {
        return { ok: false, code: behaviour.callFails, detail: "call refused on purpose" };
      }

      return {
        ok: true,
        outcome: behaviour.outcome ?? { outcome: "result", value: {}, output: "ok", truncated: false },
      };
    },
    async listResources() {
      return { ok: true, value: { resources: [] } };
    },
    async listResourceTemplates() {
      return { ok: true, value: { templates: [] } };
    },
    async readResource() {
      return { ok: true, value: { contents: [] } };
    },
    async close() {
      state.closed = true;
    },
    isConnected: () => !state.closed,
    stderrDiagnostics: () => ({ bytes: 0, truncated: false }),
  };

  return { client, state };
}

function fakeRegistry(
  entries: ReadonlyArray<McpServerEntry>,
  options: { readonly namesFail?: string } = {},
): McpRegistryPort {
  const byName = new Map(entries.map((item) => [item.name, item]));
  const refused = { ok: false as const, code: "missing_entry" as const, detail: "not a registry operation" };

  return {
    async add() {
      return refused;
    },
    async remove() {
      return refused;
    },
    async setEnabled() {
      return refused;
    },
    async listScope() {
      return refused;
    },
    async list() {
      return refused;
    },
    async names() {
      return options.namesFail === undefined
        ? { ok: true, value: [...byName.keys()].sort() }
        : { ok: false, code: "read_failed", detail: options.namesFail };
    },
    async resolve(name) {
      const found = byName.get(name);
      return found === undefined
        ? { ok: false, code: "missing_entry", detail: name }
        : { ok: true, value: { entry: found, scope: "user", shadowedScopes: [] } };
    },
  };
}

test("startup overlaps independent servers with a fixed bound and keeps registry order", async () => {
  const entries = Array.from({ length: 7 }, (_, index) => entry({ name: `s${index}` }));
  const releases = new Map<string, () => void>();
  let active = 0;
  let peak = 0;
  const clients = entries.map(() => fakeClient());
  const opening = openMcpPool({ registry: fakeRegistry(entries), cwd: process.cwd(), clientFor(item) {
    const index = Number(item.name.slice(1));
    const client = clients[index]!.client;
    const connect = client.connect;

    client.connect = async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise<void>(resolve => releases.set(item.name, resolve));
      active--;
      return connect();
    };

    return { ok: true, client };
  } });
  // Flush microtasks only: no timing threshold or real child process.
  const flush = async (): Promise<void> => { for (let i = 0; i < 40; i++) await Promise.resolve(); };

  try {
    await flush();
    assert.equal(releases.size, 4, "one stalled server must not serialize all startup");
    releases.get("s3")?.();
    await flush();
    assert.equal(releases.has("s4"), true, "a freed slot starts the next server");

    for (let round = 0; round < 7; round++) {
      for (const release of releases.values()) release();
      await flush();
    }

    const pool = await opening;

    assert.equal(peak, 4);
    assert.deepEqual(pool.servers.map(server => server.serverId), entries.map(item => item.name));
    await pool.closeAll();
    assert.ok(clients.every(client => client.state.closed));
  } finally {
    // Release pending gates even when proving the old sequential code red.
    for (let round = 0; round < 7; round++) {
      for (const release of releases.values()) release();
      await flush();
    }
    await (await opening).closeAll();
  }
});

test("a factory exception waits for active startup and closes acquired clients", async () => {
  const healthy = fakeClient();
  const connect = healthy.client.connect;
  let release: (() => void) | undefined;

  healthy.client.connect = async () => {
    await new Promise<void>(resolve => { release = resolve; });
    return connect();
  };
  const failure = new Error("factory failed");
  const opening = openMcpPool({ registry: fakeRegistry([entry({ name: "a" }), entry({ name: "b" })]),
    cwd: process.cwd(), clientFor(item) {
      if (item.name === "b") throw failure;
      return { ok: true, client: healthy.client };
    } });
  const outcome = opening.then(() => undefined, error => error);

  for (let i = 0; i < 40; i++) await Promise.resolve();

  release?.();
  assert.equal(await outcome, failure);
  assert.equal(healthy.state.closed, true);
});

test("every enabled server is opened before the run, and its tools are listed", async () => {
  const alpha = fakeClient({ tools: [spec("alpha", "echo")] });
  const beta = fakeClient({ tools: [spec("beta", "read"), spec("beta", "write")] });
  const pool = await openMcpPool({
    registry: fakeRegistry([entry({ name: "alpha" }), entry({ name: "beta" })]),
    cwd: process.cwd(),
    clientFor: (item) => ({ ok: true, client: item.name === "alpha" ? alpha.client : beta.client }),
  });

  assert.deepEqual(
    pool.servers.map((server) => server.serverId),
    ["alpha", "beta"],
  );
  assert.deepEqual(pool.servers.map((server) => server.tools.length), [1, 2]);
  assert.equal(pool.failures.length, 0);
});

test("a server that will not start is a fact, not a failure of the run", async () => {
  const broken = fakeClient({ connectFails: "command_not_found" });
  const healthy = fakeClient({ tools: [spec("healthy", "echo")] });
  const pool = await openMcpPool({
    registry: fakeRegistry([entry({ name: "broken" }), entry({ name: "healthy" })]),
    cwd: process.cwd(),
    clientFor: (item) => ({ ok: true, client: item.name === "broken" ? broken.client : healthy.client }),
  });

  assert.deepEqual(
    pool.servers.map((server) => server.serverId),
    ["healthy"],
  );
  assert.deepEqual(pool.failures, [
    { serverId: "broken", code: "command_not_found", detail: "refused on purpose" },
  ]);
  // The half-open client is closed: a failed start never leaves a child behind.
  assert.equal(broken.state.closed, true);
});

test("a server whose tool list fails is closed and reported, and the rest keep serving", async () => {
  const listing = fakeClient({ listFails: "protocol_error" });
  const healthy = fakeClient({ tools: [spec("healthy", "echo")] });
  const pool = await openMcpPool({
    registry: fakeRegistry([entry({ name: "listing" }), entry({ name: "healthy" })]),
    cwd: process.cwd(),
    clientFor: (item) => ({ ok: true, client: item.name === "listing" ? listing.client : healthy.client }),
  });

  assert.equal(pool.servers.length, 1);
  assert.equal(pool.failures[0]?.code, "protocol_error");
  assert.equal(listing.state.closed, true);
});

test("a disabled server is skipped, and skipping is reported as its own fact", async () => {
  const skipped = fakeClient({ tools: [spec("off", "echo")] });
  const pool = await openMcpPool({
    registry: fakeRegistry([entry({ name: "off", enabled: false })]),
    cwd: process.cwd(),
    clientFor: () => ({ ok: true, client: skipped.client }),
  });

  assert.equal(pool.servers.length, 0);
  assert.equal(pool.failures.length, 0);
  assert.deepEqual(pool.skipped, [{ serverId: "off", reason: "disabled" }]);
  // A skipped server is not even connected, so it cannot have been closed.
  assert.equal(skipped.state.closed, false);
});

test("the factory dispatches on transport, and refuses a remote entry with no url", () => {
  const client = fakeClient().client;
  const seen: string[] = [];
  const seams = {
    stdio: (spec: { readonly command: string }) => {
      seen.push(`stdio:${spec.command}`);
      return client;
    },
    remote: (spec: { readonly transport: string; readonly url: string }) => {
      seen.push(`${spec.transport}:${spec.url}`);
      return client;
    },
  };
  const locale = createClientForEntry(entry({ name: "locale", command: "node" }), process.cwd(), seams);
  const http = createClientForEntry(
    entry({ name: "remote", transport: "http", url: "https://example.invalid/mcp" }),
    process.cwd(),
    seams,
  );
  const sse = createClientForEntry(
    entry({ name: "legacy", transport: "sse", url: "https://example.invalid/sse" }),
    process.cwd(),
    seams,
  );

  assert.deepEqual([locale.ok, http.ok, sse.ok], [true, true, true]);
  assert.deepEqual(seen, [
    "stdio:node",
    "http:https://example.invalid/mcp",
    "sse:https://example.invalid/sse",
  ]);

  // The refusal is a value, and the remote seam was never reached.
  const missing = createClientForEntry(entry({ name: "remote", transport: "http" }), process.cwd(), {
    remote: () => {
      throw new Error("a client must not be built for an entry with no url");
    },
  });

  assert.equal(missing.ok, false);
  assert.equal(missing.ok === false ? missing.code : "", "missing_url");
});

test("a registry that cannot be read fails soft: empty pool, one reported failure", async () => {
  const pool = await openMcpPool({
    registry: fakeRegistry([entry({ name: "alpha" })], { namesFail: "the file is not a registry" }),
    cwd: process.cwd(),
    clientFor: () => {
      throw new Error("no client should be built when the registry is unreadable");
    },
  });

  assert.equal(pool.servers.length, 0);
  assert.deepEqual(pool.failures, [
    { serverId: "", code: "read_failed", detail: "the file is not a registry" },
  ]);
});

test("closeAll closes every open server, and is safe to call twice", async () => {
  const alpha = fakeClient({ tools: [spec("alpha", "echo")] });
  const pool = await openMcpPool({
    registry: fakeRegistry([entry({ name: "alpha" })]),
    cwd: process.cwd(),
    clientFor: () => ({ ok: true, client: alpha.client }),
  });

  await pool.closeAll();
  await pool.closeAll();
  assert.equal(alpha.state.closed, true);
});

test("a call reaches the server that published the tool, under its qualified name", async () => {
  const alpha = fakeClient({ tools: [spec("alpha", "echo")] });
  const pool = await openMcpPool({
    registry: fakeRegistry([entry({ name: "alpha" })]),
    cwd: process.cwd(),
    clientFor: () => ({ ok: true, client: alpha.client }),
  });
  const server = pool.servers[0];

  assert.ok(server);
  const result = await server.call("echo", { text: "hi" }, 1_000, new AbortController().signal);

  assert.equal(result.ok, true);
  assert.deepEqual(alpha.state.calls, ["mcp__alpha__echo"]);
});

test("header names are carried for the record, values are not", async () => {
  const client = fakeClient({ tools: [spec("remote", "echo")] });
  const pool = await openMcpPool({
    registry: fakeRegistry([
      entry({
        name: "remote",
        transport: "sse",
        url: "https://example.invalid/sse",
        headers: { authorization: "Bearer secret-value", "x-tenant": "acme" },
      }),
    ]),
    cwd: process.cwd(),
    clientFor: () => ({ ok: true, client: client.client }),
  });

  assert.deepEqual(pool.headerKeys, [{ serverId: "remote", keys: ["authorization", "x-tenant"] }]);
  assert.equal(JSON.stringify(pool.headerKeys).includes("secret-value"), false);
});

test("header names are reported even for an entry that never came up", async () => {
  const down = fakeClient({ connectFails: "spawn_failed" });
  const pool = await openMcpPool({
    registry: fakeRegistry([
      entry({
        name: "down",
        transport: "http",
        url: "http://127.0.0.1:1/mcp",
        headers: { authorization: "Bearer s3cret-token" },
      }),
    ]),
    cwd: process.cwd(),
    clientFor: () => ({ ok: true, client: down.client }),
  });

  assert.equal(pool.servers.length, 0);
  assert.deepEqual(pool.headerKeys, [{ serverId: "down", keys: ["authorization"] }]);
  assert.deepEqual(pool.failures.map((failure) => failure.code), ["spawn_failed"]);
  assert.equal(JSON.stringify(pool.headerKeys).includes("s3cret-token"), false);
});
