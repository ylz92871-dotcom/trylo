import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createMcpSession } from "./session.js";
import { createMcpStdioClient } from "../adapters/mcp-stdio/client.js";
import { createMcpRegistry } from "../adapters/mcp-registry/store.js";
import type { McpServerEntry } from "../ports/mcp-registry.js";

/**
 * The fake composition root: registry → resolve → connect → list → call → close.
 * This is what "the two halves actually meet" looks like. It is test-only; the
 * production wiring still belongs to HY4.
 */

const repoRoot = process.cwd();
const fakeServer = join(repoRoot, "testdata", "mcp", "fake-server.mjs");

function clientFactory(entry: McpServerEntry, cwd: string) {
  return createMcpStdioClient({
    serverId: entry.name,
    command: entry.command,
    args: entry.args,
    env: entry.env,
    cwd,
    handshakeTimeoutMs: 5_000,
  });
}

test("a server added through the registry opens, lists and calls end-to-end", async () => {
  const dir = mkdtempSync(join(os.tmpdir(), "trylo-mcp-session-"));
  try {
    const registry = createMcpRegistry({
      userFile: join(dir, "user", "mcp-servers.json"),
      projectFile: join(dir, "project", "mcp-servers.json"),
    });
    const added = await registry.add({
      name: "fake",
      transport: "stdio",
      command: process.execPath,
      args: [fakeServer, "ok"],
      env: {},
      enabled: true,
      scope: "project",
    });

    assert.equal(added.ok, true);

    const session = createMcpSession({ registry, cwd: repoRoot, clientFactory });
    const opened = await session.open("fake");

    assert.equal(opened.ok, true);

    if (!opened.ok) {
      return;
    }

    assert.deepEqual(
      opened.value.tools.map((tool) => tool.qualifiedName).sort(),
      ["mcp__fake__echo", "mcp__fake__fail", "mcp__fake__hash"],
    );

    const called = await opened.value.call("echo", { text: "roundtrip" }, 2_000);

    assert.equal(called.ok, true);

    if (called.ok && called.outcome.outcome === "result") {
      assert.equal(called.outcome.output, "echo:roundtrip");
    }

    await session.closeAll();
    assert.equal(opened.value.info.protocolVersion, "2025-03-26");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("opening an unregistered server name is an explicit failure", async () => {
  const dir = mkdtempSync(join(os.tmpdir(), "trylo-mcp-session-"));
  try {
    const registry = createMcpRegistry({
      userFile: join(dir, "user", "mcp-servers.json"),
      projectFile: join(dir, "project", "mcp-servers.json"),
    });
    const session = createMcpSession({ registry, cwd: repoRoot, clientFactory });
    const opened = await session.open("ghost");

    assert.equal(opened.ok, false);

    if (!opened.ok) {
      assert.equal(opened.code, "missing_entry");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
