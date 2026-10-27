import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPermissionAction } from "../loop/permission-grants.js";
import type { PermissionAction, PermissionDecision } from "../ports/permission.js";
import type { SubagentContext } from "./types.js";
import { createSubagentApprovalScope } from "./parent-approval.js";

function harness(answer: (action: PermissionAction) => Promise<PermissionDecision> = async () => ({ resolution: "approved", scope: "once" })) {
  const cancel = new AbortController();
  const activity: string[] = [];
  let denied = false;
  let allowed = true;
  const scope = createSubagentApprovalScope({ parent: answer,
    permission: { isDenied: () => denied, request: async action => ({ ticketId: "unused", toolCallId: action.toolCallId }),
      awaitDecision: async () => { throw new Error("Only the parent callback may ask"); } },
    requester: context => ({ kind: "subagent", taskId: "task", executionId: context.subagentId,
      teamRunId: "team", memberId: "worker", displayName: "Writer", role: "worker" }),
    constrain: () => allowed ? { ok: true } : { ok: false, code: "held", message: "held" }, onCancelled: () => {} });
  const context: SubagentContext = { subagentId: "execution", name: "Writer", signal: cancel.signal,
    lineage: { parentAgentId: "parent", rootAttemptId: "root" }, tools: { snapshot: () => [],
      execute: async () => ({ outcome: "cancelled" }), cancel: async () => {} },
    reportProgress: () => {}, recordUsage: () => {}, setActivity: value => activity.push(value) };
  const { permission } = scope.bind(context);
  const call = { toolCallId: "same-call", name: "write_file", arguments: { path: "one.txt", content: "one" } };
  const approve = async () => {
    const ticket = await permission.request(buildPermissionAction(call.toolCallId, call.name, call.arguments));
    return permission.awaitDecision(ticket.ticketId);
  };
  return { scope, call, approve, cancel, activity, deny: () => { denied = true; }, hold: () => { allowed = false; } };
}

test("a once proof cannot be replayed, transferred to another execution, or used for changed arguments", async () => {
  const owner = harness(); const sibling = harness();
  await owner.approve();
  assert.equal(sibling.scope.consume(owner.call), false);
  assert.equal(owner.scope.consume({ ...owner.call, arguments: { ...owner.call.arguments, content: "changed" } }), false);
  assert.equal(owner.scope.consume(owner.call), false, "the first attempt spends even a mismatched proof");
  await owner.approve();
  assert.equal(owner.scope.consume(owner.call), true);
  assert.equal(owner.scope.consume(owner.call), false);
  owner.scope.dispose(); sibling.scope.dispose();
});

test("a live parent denial, execution cancellation, or retirement revokes an approved action", async () => {
  for (const revoke of ["deny", "cancel", "dispose"] as const) {
    const h = harness(); await h.approve();
    if (revoke === "deny") h.deny();
    else if (revoke === "cancel") h.cancel.abort();
    else h.scope.dispose();
    assert.equal(h.scope.consume(h.call), false, revoke);
    h.scope.dispose();
  }
});

test("human wait pauses member work and a new constraint rejects a reply before dispatch", async () => {
  let release!: (answer: PermissionDecision) => void;
  const held = new Promise<PermissionDecision>(resolve => { release = resolve; });
  const h = harness(async () => held);
  const pending = h.approve(); await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(h.activity, ["idle"]);
  h.hold(); release({ resolution: "approved", scope: "once" });
  assert.equal((await pending).resolution, "denied");
  assert.deepEqual(h.activity, ["idle", "working"]);
  assert.equal(h.scope.consume(h.call), false);
  h.scope.dispose();
});
