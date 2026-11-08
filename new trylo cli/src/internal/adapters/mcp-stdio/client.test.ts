import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { createMcpStdioClient } from "./client.js";

/**
 * M3 / M4 / M5 / M6 against a real child process.
 *
 * The fake server (`testdata/mcp/fake-server.mjs`) is a genuine Node subprocess
 * spawned with `process.execPath`, never a mocked `spawn`. Each scenario below
 * provokes one contract; scenarios that never emit a byte (timeout) depend on
 * the client's own deadline rather than on the server closing.
 */

const repoRoot = process.cwd();
const fakeServer = join(repoRoot, "testdata", "mcp", "fake-server.mjs");

function clientFor(scenario: string, overrides: { serverId?: string } = {}): ReturnType<typeof createMcpStdioClient> {
  return createMcpStdioClient({
    serverId: overrides.serverId ?? "fake",
    command: process.execPath,
    args: [fakeServer, scenario],
    env: {},
    cwd: repoRoot,
    handshakeTimeoutMs: 5_000,
  });
}

/** Polls a predicate until true or a hard deadline; fails fast without hanging. */
async function until(predicate: () => boolean, label: string, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      assert.fail(`timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("M3: a clean handshake speaks the pinned revision and lists real tools", async () => {
  const client = clientFor("ok");
  try {
    const connected = await client.connect();

    assert.equal(connected.ok, true);

    if (connected.ok) {
      assert.equal(connected.value.protocolVersion, "2025-03-26");
      assert.equal(connected.value.name, "fake-server");
    }

    const listed = await client.listTools();

    assert.equal(listed.ok, true);

    if (listed.ok) {
      const names = listed.value.map((tool) => tool.qualifiedName).sort();
      assert.deepEqual(names, ["mcp__fake__echo", "mcp__fake__fail", "mcp__fake__hash"]);
      for (const tool of listed.value) {
        assert.equal(tool.needsApproval, true);
        assert.equal(tool.annotationsTrust, "untrusted");
      }
    }
  } finally {
    await client.close();
  }
});

test("M3: the second protocol revision is also accepted", async () => {
  const client = clientFor("version-other");
  try {
    const connected = await client.connect();
    assert.equal(connected.ok, true);
    if (connected.ok) {
      assert.equal(connected.value.protocolVersion, "2024-11-05");
    }
  } finally {
    await client.close();
  }
});

test("M3: a version the client does not speak is disconnected before any call", async () => {
  const client = clientFor("version-mismatch");
  try {
    const connected = await client.connect();
    assert.equal(connected.ok, false);
    if (!connected.ok) {
      assert.equal(connected.code, "unsupported_protocol_version");
    }
  } finally {
    await client.close();
  }
});

test("M3: a child that exits immediately fails to connect", async () => {
  const client = clientFor("exit");
  try {
    const connected = await client.connect();
    assert.equal(connected.ok, false);
  } finally {
    await client.close();
  }
});

test("M3: garbage on stdout fails the handshake, never a success", async () => {
  const client = clientFor("garbage");
  try {
    const connected = await client.connect();
    assert.equal(connected.ok, false);
  } finally {
    await client.close();
  }
});

test("M5: a successful call without an invented deadline returns structured content", async () => {
  const client = clientFor("ok");
  try {
    assert.equal((await client.connect()).ok, true);
    assert.equal((await client.listTools()).ok, true);
    const call = await client.callTool({
      qualifiedName: "mcp__fake__echo",
      arguments: { text: "hi" },
    });

    assert.equal(call.ok, true);

    if (call.ok && call.outcome.outcome === "result") {
      assert.equal(call.outcome.output, "echo:hi");
      assert.deepEqual(call.outcome.value, { echoed: true });
    }
  } finally {
    await client.close();
  }
});

test("M5: a server reported isError is an error outcome, not unknown", async () => {
  const client = clientFor("ok");
  try {
    await client.connect();
    await client.listTools();
    const call = await client.callTool({
      qualifiedName: "mcp__fake__fail",
      arguments: {},
      timeoutMs: 2_000,
    });

    assert.equal(call.ok, true);

    if (call.ok) {
      assert.equal(call.outcome.outcome, "error");
      if (call.outcome.outcome === "error") {
        assert.equal(call.outcome.code, "mcp_tool_error");
      }
    }
  } finally {
    await client.close();
  }
});

test("M5: a tool from another server is refused as unknown_tool", async () => {
  const client = clientFor("ok");
  try {
    await client.connect();
    const call = await client.callTool({
      qualifiedName: "mcp__other__echo",
      arguments: {},
      timeoutMs: 2_000,
    });

    assert.equal(call.ok, false);

    if (!call.ok) {
      assert.equal(call.code, "unknown_tool");
    }
  } finally {
    await client.close();
  }
});

test("M5: a deadline kills the child and reports mcp_timeout, not a result", async () => {
  const client = clientFor("timeout");
  try {
    await client.connect();
    await client.listTools();
    const call = await client.callTool({
      qualifiedName: "mcp__fake__echo",
      arguments: { text: "x" },
      timeoutMs: 60,
    });

    assert.equal(call.ok, true);

    if (call.ok && call.outcome.outcome === "unknown") {
      assert.equal(call.outcome.code, "mcp_timeout");
    }

    await until(() => !client.isConnected(), "child to be killed after timeout");
  } finally {
    await client.close();
  }
});

test("M5: a user abort is cancelled, distinct from a tool failure", async () => {
  const client = clientFor("timeout");
  try {
    await client.connect();
    await client.listTools();
    const controller = new AbortController();
    const pending = client.callTool({
      qualifiedName: "mcp__fake__echo",
      arguments: {},
      timeoutMs: 5_000,
      signal: controller.signal,
    });

    setTimeout(() => controller.abort(), 20);
    const call = await pending;

    assert.equal(call.ok, true);

    if (call.ok) {
      assert.equal(call.outcome.outcome, "cancelled");
    }
  } finally {
    await client.close();
  }
});

test("M4: a tool whose name contains `__` is dropped from the callable set", async () => {
  const client = clientFor("bad-tool");
  try {
    await client.connect();
    const listed = await client.listTools();

    assert.equal(listed.ok, true);

    if (listed.ok) {
      const names = listed.value.map((tool) => tool.serverToolName);
      assert.equal(names.includes("a__b"), false);
      assert.equal(names.includes("echo"), true);
    }
  } finally {
    await client.close();
  }
});

test("M4: a tool with a non-object inputSchema is dropped", async () => {
  const client = clientFor("bad-schema");
  try {
    await client.connect();
    const listed = await client.listTools();
    assert.equal(listed.ok, true);
    if (listed.ok) {
      assert.equal(listed.value.some((tool) => tool.serverToolName === "weird"), false);
    }
  } finally {
    await client.close();
  }
});

test("M6: an elicitation request is refused and the child is closed, not hung", async () => {
  const client = clientFor("elicitation");
  try {
    const connected = await client.connect();
    assert.equal(connected.ok, true);
    // The server fires elicitation/create immediately after the handshake; the
    // client answers "no" and closes rather than turning it into a hanging turn.
    await until(() => !client.isConnected(), "elicitation child to be closed");
  } finally {
    await client.close();
  }
});

test("M6: a sampling request is refused the same way", async () => {
  const client = clientFor("sampling");
  try {
    const connected = await client.connect();
    assert.equal(connected.ok, true);
    await until(() => !client.isConnected(), "sampling child to be closed");
  } finally {
    await client.close();
  }
});

test("M6: a capability notification (no id) also closes the child", async () => {
  const client = clientFor("notification-elicitation");
  try {
    assert.equal((await client.connect()).ok, true);
    await until(() => !client.isConnected(), "notification child to be closed");
  } finally {
    await client.close();
  }
});

test("adversarial #10: a second connect on the same client is mcp_already_connected", async () => {
  const client = clientFor("ok");
  try {
    assert.equal((await client.connect()).ok, true);
    const second = await client.connect();
    assert.equal(second.ok, false);
    if (!second.ok) {
      assert.equal(second.code, "already_connected");
    }
  } finally {
    await client.close();
  }
});

test("adversarial #11: a connect after close is mcp_closed, not mcp_already_connected", async () => {
  const client = clientFor("ok");

  assert.equal((await client.connect()).ok, true);
  await client.close();
  const again = await client.connect();

  assert.equal(again.ok, false);

  if (!again.ok) {
    assert.equal(again.code, "closed");
  }
});

test("M5: stderr past the budget is truncated in diagnostics", async () => {
  const client = clientFor("stderr");
  try {
    await client.connect();
    await until(() => client.stderrDiagnostics().truncated, "stderr truncation flag");
    assert.equal(client.stderrDiagnostics().bytes > 0, true);
  } finally {
    await client.close();
  }
});

test("WP15.2: resources/list + templates/list + read round-trip against a real child", async () => {
  const client = clientFor("ok");
  try {
    assert.equal((await client.connect()).ok, true);
    const listed = await client.listResources();

    assert.equal(listed.ok, true);

    if (listed.ok) {
      assert.deepEqual(
        listed.value.resources.map((resource) => resource.uri),
        ["file:///notes/today.md", "binary:///logo.png"],
      );
      for (const resource of listed.value.resources) {
        assert.equal(resource.annotationsTrust, "untrusted");
      }
    }

    const templates = await client.listResourceTemplates();

    assert.equal(templates.ok, true);

    if (templates.ok) {
      assert.deepEqual(
        templates.value.templates.map((template) => template.uriTemplate),
        ["file:///logs/{date}.log"],
      );
    }

    const read = await client.readResource({ uri: "file:///notes/today.md", timeoutMs: 2_000 });

    assert.equal(read.ok, true);

    if (read.ok) {
      assert.equal(read.value.contents.length, 1);
      const first = read.value.contents[0];
      assert.ok(first !== undefined && first.kind === "text");
      if (first !== undefined && first.kind === "text") {
        assert.ok(first.text.includes("WP15"));
      }
    }

    const binary = await client.readResource({ uri: "binary:///logo.png", timeoutMs: 2_000 });

    assert.equal(binary.ok, true);

    if (binary.ok) {
      assert.equal(binary.value.contents[0]?.kind, "binary");
    }
  } finally {
    await client.close();
  }
});

test("WP15.2: reading an unknown URI is a protocol error, and an empty URI never leaves the client", async () => {
  const client = clientFor("ok");
  try {
    assert.equal((await client.connect()).ok, true);
    const unknown = await client.readResource({ uri: "file:///does/not/exist.md", timeoutMs: 2_000 });

    assert.equal(unknown.ok, false);

    if (!unknown.ok) {
      assert.equal(unknown.code, "protocol_error");
    }

    const empty = await client.readResource({ uri: "", timeoutMs: 2_000 });

    assert.equal(empty.ok, false);

    if (!empty.ok) {
      assert.equal(empty.code, "invalid_arguments");
    }
  } finally {
    await client.close();
  }
});

test("WP15.2: resource verbs before connect fail closed, and reads time out by the clock", async () => {
  const unconnected = clientFor("ok");

  try {
    const early = await unconnected.listResources();
    assert.equal(early.ok, false);
    if (!early.ok) {
      assert.equal(early.code, "not_initialized");
    }
  } finally {
    await unconnected.close();
  }

  const hanging = clientFor("timeout");

  try {
    assert.equal((await hanging.connect()).ok, true);
    const read = await hanging.readResource({ uri: "file:///notes/today.md", timeoutMs: 200 });
    assert.equal(read.ok, false);
    if (!read.ok) {
      assert.equal(read.code, "timeout");
    }
  } finally {
    await hanging.close();
  }
});

test("WP15-F-A: a listing without an answer hits its deadline instead of hanging", async () => {
  const hanging = clientFor("timeout");
  try {
    assert.equal((await hanging.connect()).ok, true);
    // An unusable deadline is refused before a round trip is spent.
    const refused = await hanging.listResources(undefined, -1);

    assert.equal(refused.ok, false);

    if (!refused.ok) {
      assert.equal(refused.code, "invalid_arguments");
    }

    const listed = await hanging.listResources(undefined, 200);

    assert.equal(listed.ok, false);

    if (!listed.ok) {
      assert.equal(listed.code, "timeout");
    }

    // A timed-out child is killed, like a timed-out call's: later verbs fail
    // closed on the dead transport instead of hanging behind it.
    assert.equal(hanging.isConnected(), false);
    const afterDeath = await hanging.listResourceTemplates(undefined, 200);

    assert.equal(afterDeath.ok, false);

    if (!afterDeath.ok) {
      assert.equal(afterDeath.code, "not_initialized");
    }
  } finally {
    await hanging.close();
  }
});

test("WP15-F-A: templates/list has its own deadline", async () => {
  const hanging = clientFor("timeout");
  try {
    assert.equal((await hanging.connect()).ok, true);
    const templates = await hanging.listResourceTemplates(undefined, 200);
    assert.equal(templates.ok, false);
    if (!templates.ok) {
      assert.equal(templates.code, "timeout");
    }
  } finally {
    await hanging.close();
  }
});
