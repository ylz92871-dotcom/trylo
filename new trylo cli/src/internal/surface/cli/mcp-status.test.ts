import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EXIT_CODES } from "../../protocol/cli-stream.js";
import { handleMcpStatus } from "./commands-mcp.js";
import type { CliContext } from "./context.js";
import { createCliMcpRegistry } from "./mcp-wiring.js";

/**
 * WP15.2/50 `mcp status` contracts.
 *
 * `status` dials every enabled server the way a run does (fail-soft, one
 * fact per server) instead of merely reading registry files. The fake stdio
 * server is a genuine child process here, not a stubbed client — the one
 * thing stubbed is the filesystem root, so no test touches a real profile.
 * Header values never appear in any row: the assertion that matters most is
 * the negative one.
 */

const repoRoot = process.cwd();
const fakeServer = join(repoRoot, "testdata", "mcp", "fake-server.mjs");

function tempCtx(): { readonly ctx: CliContext; readonly out: string[]; readonly cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "trylo-mcp-status-"));
  const home = join(root, "home");
  const cwd = join(root, "workspace");

  // The pool spawns children with cwd set to the workspace, so both roots
  // must exist before any server is opened.
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  const out: string[] = [];
  const ctx: CliContext = {
    env: {},
    homeDir: home,
    cwd,
    nodeVersion: "v22.0.0",
    stdinIsTty: false,
    readFile: () => undefined,
    isDirectory: () => true,
    readDir: () => [],
    writeFile: () => true,
    readStdin: async () => "",
    readLine: async () => undefined,
    readSecret: async () => undefined,
    stdout: (text) => out.push(text),
    stderr: () => {},
    now: () => 0,
    newId: (prefix) => `${prefix}-1`,
  };

  return { ctx, out, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("an empty registry reports no servers without dialling anything", async () => {
  const { ctx, out, cleanup } = tempCtx();
  try {
    const code = await handleMcpStatus(ctx, false);
    assert.equal(code, EXIT_CODES.OK);
    assert.deepEqual(out, ["no MCP servers registered; `trylo mcp add <name> -- <command>`\n"]);
  } finally {
    cleanup();
  }
});

test("a live stdio server reports connected with its tool count", async () => {
  const { ctx, out, cleanup } = tempCtx();
  try {
    const registry = createCliMcpRegistry(ctx);
    const added = await registry.add({
      name: "fake",
      transport: "stdio",
      command: process.execPath,
      args: [fakeServer, "ok"],
      env: {},
      enabled: true,
      scope: "user",
    });

    assert.equal(added.ok, true);
    const code = await handleMcpStatus(ctx, false);

    assert.equal(code, EXIT_CODES.OK);
    assert.ok(out.some((line) => line.includes("fake connected tools=3")), JSON.stringify(out));
  } finally {
    cleanup();
  }
});

test("a disabled server is reported without being spawned, and a ghost as unavailable", async () => {
  const { ctx, out, cleanup } = tempCtx();
  try {
    const registry = createCliMcpRegistry(ctx);

    assert.equal(
      (
        await registry.add({
          name: "off",
          transport: "stdio",
          command: process.execPath,
          args: [fakeServer, "ok"],
          env: {},
          enabled: false,
          scope: "user",
        })
      ).ok,
      true,
    );
    assert.equal(
      (
        await registry.add({
          name: "ghost",
          transport: "stdio",
          command: "trylo-definitely-not-a-binary",
          args: [],
          env: {},
          enabled: true,
          scope: "user",
        })
      ).ok,
      true,
    );
    const code = await handleMcpStatus(ctx, false);

    assert.equal(code, EXIT_CODES.OK);
    assert.ok(out.some((line) => line.includes("off disabled")), JSON.stringify(out));
    // A missing binary surfaces as handshake_rejected today (the dead
    // transport synthesizes -32000 child_exited): the port's
    // `command_not_found` code currently has no producer. That mapping gap is
    // recorded in the WP15 handoff, not repaired here — rewiring handshake
    // errors belongs to the transport owner, not to a status probe.
    assert.ok(
      out.some((line) => line.includes("ghost unavailable:handshake_rejected")),
      JSON.stringify(out),
    );
  } finally {
    cleanup();
  }
});

test("header values never print: only key names, even for a server that needs auth", async () => {
  const { ctx, out, cleanup } = tempCtx();
  try {
    const registry = createCliMcpRegistry(ctx);

    assert.equal(
      (
        await registry.add({
          name: "remote",
          transport: "http",
          command: "",
          args: [],
          env: {},
          enabled: true,
          scope: "user",
          url: "http://127.0.0.1:1/mcp",
          headers: { Authorization: "Bearer super-secret-token" },
        })
      ).ok,
      true,
    );
    const code = await handleMcpStatus(ctx, false);

    assert.equal(code, EXIT_CODES.OK);
    const text = out.join("");

    assert.ok(!text.includes("super-secret-token"), text);
    assert.ok(text.includes("remote headers=[Authorization]"), text);
    assert.ok(text.includes("remote unavailable:"), text);
  } finally {
    cleanup();
  }
});

test("json output parses and carries the same facts without secrets", async () => {
  const { ctx, out, cleanup } = tempCtx();
  try {
    const registry = createCliMcpRegistry(ctx);

    assert.equal(
      (
        await registry.add({
          name: "fake",
          transport: "stdio",
          command: process.execPath,
          args: [fakeServer, "ok"],
          env: {},
          enabled: true,
          scope: "user",
        })
      ).ok,
      true,
    );
    const code = await handleMcpStatus(ctx, true);

    assert.equal(code, EXIT_CODES.OK);
    const parsed = JSON.parse(out.join("")) as {
      readonly connected: ReadonlyArray<{ readonly name: string; readonly tools: number }>;
      readonly failed: ReadonlyArray<{ readonly code: string }>;
    };

    assert.equal(parsed.connected.length, 1);
    assert.equal(parsed.connected[0]?.name, "fake");
    assert.equal(parsed.connected[0]?.tools, 3);
    assert.equal(parsed.failed.length, 0);
  } finally {
    cleanup();
  }
});
