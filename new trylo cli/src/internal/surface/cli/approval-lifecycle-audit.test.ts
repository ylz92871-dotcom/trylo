import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPermissionAction } from "../../loop/permission-grants.js";
import { awaitPermissionDecision } from "../../loop/permission-boundary.js";
import { decision } from "../../ports/permission.js";

test("an approval adapter cannot mutate the executable arguments through its action reference", async () => {
  const args = { command: "node safe.js", nested: { target: "safe.txt" } };
  const action = buildPermissionAction("immutable", "run_shell", args);
  const result = await awaitPermissionDecision({
    async request(input) {
      if (!Reflect.set(input.arguments, "command", "node different.js")) throw new Error("immutable_approval_action");
      return { ticketId: "t", toolCallId: input.toolCallId };
    },
    async awaitDecision() { return decision("approved"); },
  }, action);
  assert.equal(result.outcome, "failed");
  assert.equal(args.command, "node safe.js");
  assert.equal(action.arguments.command, "node safe.js");
  assert.equal(Object.isFrozen(action.arguments.nested), true);
});

test("a supplied fingerprint for different arguments is refused before asking for approval", async () => {
  let asked = 0;
  const action = { ...buildPermissionAction("fingerprint", "run_shell", { command: "node safe.js" }), pattern: "run_shell#unrelated" };
  const result = await awaitPermissionDecision({
    async request(input) { asked += 1; return { ticketId: "t", toolCallId: input.toolCallId }; },
    async awaitDecision() { return decision("approved"); },
  }, action);
  assert.equal(result.outcome, "failed");
  assert.equal(asked, 0);
});
