import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceSandbox } from "../../adapters/sandbox/index.js";
import { createWorkspaceTools } from "../../adapters/tools/index.js";
import { buildPermissionAction, createPermissionGrantCache } from "../../loop/permission-grants.js";
import { readToolApprovalRequirement } from "../../loop/tool-boundary.js";
import { permissionFor } from "./permission-for-run.js";
import type { CliContext } from "./context.js";
import { createSessionPermissions } from "./session-permissions.js";

test("implicit workspace editing grants cannot authorize explicit external file or patch targets", async t => {
  const root = mkdtempSync(join(tmpdir(), "trylo-approval-scope-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const context: CliContext = { cwd: root, homeDir: root, env: {}, nodeVersion: process.version, stdinIsTty: false,
    readFile: () => undefined, readDir: () => [], isDirectory: () => true, writeFile: () => false,
    readStdin: async () => "", readSecret: async () => undefined, readLine: async () => undefined,
    stdout() {}, stderr() {}, now: () => 0, newId: prefix => prefix };
  for (const choice of [{ allowWrites: true }, { ask: "writes" as const }]) {
    const port = permissionFor("non_interactive", context, choice);
    for (const [name, args] of [
      ["write_file", { path: "../outside.txt", content: "outside" }],
      ["apply_patch", { patch: "*** Begin Patch\n*** Add File: ../outside.txt\n+outside\n*** End Patch" }],
    ] as const) {
      const ticket = await port.request(buildPermissionAction("scope", name, args));
      assert.equal((await port.awaitDecision(ticket.ticketId)).resolution, "denied", JSON.stringify({ choice, name }));
    }
    const ticket = await port.request(buildPermissionAction("local", "write_file", { path: "inside.txt", content: "inside" }));
    assert.equal((await port.awaitDecision(ticket.ticketId)).resolution, "approved");
  }
});

test("auto-edit session mode delegates workspace edits without becoming a tool-wide external grant", async t => {
  const root = mkdtempSync(join(tmpdir(), "trylo-auto-edit-scope-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const context: CliContext = { cwd: root, homeDir: root, env: {}, nodeVersion: process.version, stdinIsTty: true,
    readFile: () => undefined, readDir: () => [], isDirectory: () => true, writeFile: () => false,
    readStdin: async () => "", readSecret: async () => undefined, readLine: async () => undefined,
    stdout() {}, stderr() {}, now: () => 0, newId: prefix => prefix };
  const session = createSessionPermissions(); session.setMode("auto-edit");
  const port = permissionFor("interactive", context, session.choice({}));
  for (const target of ["inside.txt", "../outside.txt"]) {
    const ticket = await port.request(buildPermissionAction(target, "write_file", { path: target, content: "data" }));
    assert.equal((await port.awaitDecision(ticket.ticketId)).resolution, target === "inside.txt" ? "approved" : "denied");
  }
});

test("deny_all sandbox refuses a workspace read even though its binding needs no approval", async t => {
  const root = mkdtempSync(join(tmpdir(), "trylo-read-denial-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "private.txt"), "private");
  const sandbox = createWorkspaceSandbox({ workspaceRoot: root, mode: "deny_all" });
  const tools = createWorkspaceTools({ workspaceRoot: root, sandbox });
  const call = { toolCallId: "read", name: "read_file", arguments: { path: "private.txt" } };
  assert.equal(readToolApprovalRequirement(tools, call.name, call, sandbox).required, true);
  const result = await tools.execute(call, new AbortController().signal);
  assert.equal(result.outcome, "error", JSON.stringify(result));
});

test("disabling a no-approval reader removes its execution grant", async () => {
  const grants = createPermissionGrantCache();
  grants.record(buildPermissionAction("read", "read_file", { path: "private.txt" }), "denied", "session");
  const tools = createWorkspaceTools({ workspaceRoot: tmpdir(), visibility: grants });
  assert.equal(tools.snapshot().some(binding => binding.name === "read_file"), false);
  const result = await tools.execute({ toolCallId: "read", name: "read_file", arguments: { path: "private.txt" } }, new AbortController().signal);
  assert.equal(result.outcome, "error");
  if (result.outcome === "error") assert.equal(result.code, "permission_denied");
});
