import assert from "node:assert/strict";
import { test } from "node:test";
import { WORKSPACE_WRITE_TOOL_NAMES } from "../../adapters/tools/mutating/bindings.js";
import { buildPermissionAction } from "../../loop/permission-grants.js";
import type { PermissionAction } from "../../ports/permission.js";
import {
  createAllowToolsPermission,
  createDenyAllPermission,
  createInteractivePermission,
  resolveInteractiveAnswer,
} from "./permission.js";

/**
 * The prompt is the last guard and the easiest one to weaken, so its answer set
 * is asserted here: what each answer means, and how long it lasts.
 */

function action(name: string, args: Record<string, string> = {}): PermissionAction {
  return buildPermissionAction("call-1", name, args);
}

async function decideOnce(
  port: ReturnType<typeof createInteractivePermission>,
  target: PermissionAction,
): Promise<{ resolution: string; scope: string }> {
  const ticket = await port.request(target);
  const decision = await port.awaitDecision(ticket.ticketId);
  return { resolution: decision.resolution, scope: decision.scope };
}

test("the answer set offers once, session, deny, deny-tool and cancel", () => {
  assert.deepEqual(resolveInteractiveAnswer("y"), { resolution: "approved", scope: "once" });
  assert.deepEqual(resolveInteractiveAnswer("s"), { resolution: "approved", scope: "session" });
  assert.deepEqual(resolveInteractiveAnswer("n"), { resolution: "denied", scope: "once" });
  assert.deepEqual(resolveInteractiveAnswer("d"), { resolution: "denied", scope: "session" });
  assert.deepEqual(resolveInteractiveAnswer("c"), { resolution: "cancelled", scope: "once" });
  // An unrecognised answer and an ended input stream are both refusals.
  assert.deepEqual(resolveInteractiveAnswer("maybe"), { resolution: "denied", scope: "once" });
  assert.deepEqual(resolveInteractiveAnswer(undefined), { resolution: "cancelled", scope: "once" });
});

test("a cancelled scope is never remembered", async () => {
  const prompts: string[] = [];
  const port = createInteractivePermission({
    prompt: (text) => prompts.push(text),
    readLine: async () => "c",
  });
  const decision = await decideOnce(port, action("write_file", { path: "a.txt", content: "x" }));

  assert.deepEqual(decision, { resolution: "cancelled", scope: "once" });
  assert.equal(prompts.length, 1);
  // The prompt names the arguments, not just the tool.
  assert.match(prompts[0] ?? "", /write_file\(/);
  assert.match(prompts[0] ?? "", /path=a\.txt/);
});

test("a session approval is remembered and a plain approval is not", async () => {
  const port = createInteractivePermission({
    prompt: () => undefined,
    readLine: async () => "s",
  });

  assert.deepEqual(await decideOnce(port, action("edit_file")), { resolution: "approved", scope: "session" });
  const oneShot = createInteractivePermission({
    prompt: () => undefined,
    readLine: async () => "y",
  });

  assert.deepEqual(await decideOnce(oneShot, action("edit_file")), { resolution: "approved", scope: "once" });
});

test("the non-interactive default denies absolutely everything", async () => {
  const port = createDenyAllPermission();
  for (const name of ["write_file", "edit_file", "run_shell"]) {
    const ticket = await port.request(action(name));
    const decision = await port.awaitDecision(ticket.ticketId);
    assert.equal(decision.resolution, "denied", name);
  }
});

/**
 * `--allow-writes` is an explicit widening, not a mood: it covers exactly the
 * tools that declare a `workspace_write` side effect, so `run_shell` stays out
 * of reach no matter how the flag is spelled.
 */
test("--allow-writes covers workspace writes only and never the shell", async () => {
  const port = createAllowToolsPermission(new Set(WORKSPACE_WRITE_TOOL_NAMES));

  // WP13 adds notebook_edit (workspace_write cell edits); the derivation stays
  // "exactly the tools that declare workspace_write".
  assert.deepEqual(WORKSPACE_WRITE_TOOL_NAMES, ["write_file", "edit_file", "apply_patch", "notebook_edit"]);

  for (const name of WORKSPACE_WRITE_TOOL_NAMES) {
    const ticket = await port.request(action(name));
    assert.equal((await port.awaitDecision(ticket.ticketId)).resolution, "approved", name);
  }

  const shell = await port.request(action("run_shell", { command: "node -v" }));

  assert.equal((await port.awaitDecision(shell.ticketId)).resolution, "denied");
  const unknown = await port.request(action("read_file"));

  assert.equal((await port.awaitDecision(unknown.ticketId)).resolution, "denied");
});
