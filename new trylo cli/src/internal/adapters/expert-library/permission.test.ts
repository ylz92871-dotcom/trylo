import assert from "node:assert/strict";
import { test } from "node:test";
import type { PermissionAction, PermissionDecision, PermissionPort } from "../../ports/permission.js";
import { permissionPattern } from "../../ports/permission.js";
import { ExpertLibraryError, type ExpertAuthorizationAction } from "../../subagent/experts/contracts.js";
import { createPermissionExpertAuthorization } from "./permission.js";

const action: ExpertAuthorizationAction = { requestId: "request-1", stage: "create", fingerprint: "configuration-revision-1", summary: "Create a TypeScript compatibility expert" };

function permission(resolution: PermissionDecision["resolution"]): { readonly port: PermissionPort; readonly calls: PermissionAction[] } {
  const calls: PermissionAction[] = [];
  return { calls, port: {
    async request(request) {
      calls.push(request);
      return { ticketId: "ticket-1", toolCallId: request.toolCallId };
    },
    async awaitDecision() { return { resolution, scope: "once" }; },
  } };
}

test("expert approval binds permission requests to the exact stage and fingerprint", async () => {
  const authority = permission("approved");
  const adapter = createPermissionExpertAuthorization({ permission: authority.port });
  const first = await adapter.authorize(action, {});
  const second = await adapter.authorize({ ...action, stage: "retain", fingerprint: "configuration-revision-2" }, {});

  assert.equal(first.resolution, "approved");
  assert.equal(second.resolution, "approved");
  assert.equal(authority.calls.length, 2);
  assert.notEqual(authority.calls[0]!.pattern, authority.calls[1]!.pattern);

  for (const call of authority.calls) assert.equal(call.pattern, permissionPattern(call.name, call.arguments));
});

test("verified user actions do not prompt a second time; unverified IDs cannot grant", async () => {
  const authority = permission("denied");
  const consumed: string[] = [];
  const adapter = createPermissionExpertAuthorization({ permission: authority.port, consumeUserAction: async (id, requested) => {
    consumed.push(id);
    assert.deepEqual(requested, action);
    return id === "trusted-click";
  } });
  const approved = await adapter.authorize(action, { userActionId: "trusted-click" });

  assert.equal(approved.resolution, "approved");
  assert.equal(authority.calls.length, 0);
  assert.deepEqual(await adapter.authorize(action, { userActionId: "model-invented" }), { resolution: "denied" });
  assert.equal(authority.calls.length, 1);
  assert.deepEqual(consumed, ["trusted-click", "model-invented"]);
});

test("user action IDs without a trusted consumer still use the authority", async () => {
  const authority = permission("denied");
  assert.deepEqual(await createPermissionExpertAuthorization({ permission: authority.port }).authorize(action, { userActionId: "not-proof" }), { resolution: "denied" });
  assert.equal(authority.calls.length, 1);
});

test("denial, cancellation and expiry never carry approval receipts", async () => {
  for (const resolution of ["denied", "cancelled", "expired"] as const) {
    const authority = permission(resolution);
    assert.deepEqual(await createPermissionExpertAuthorization({ permission: authority.port }).authorize(action, {}), { resolution });
  }

  const authority = permission("approved");
  const controller = new AbortController();
  controller.abort();
  assert.deepEqual(await createPermissionExpertAuthorization({ permission: authority.port }).authorize(action, { signal: controller.signal }), { resolution: "cancelled" });
  assert.equal(authority.calls.length, 0);
});

test("mismatched tickets and malformed authority decisions fail closed", async () => {
  const wrongTicket: PermissionPort = { ...permission("approved").port, async request() { return { ticketId: "ticket", toolCallId: "somebody-else" }; } };
  await assert.rejects(createPermissionExpertAuthorization({ permission: wrongTicket }).authorize(action, {}), error => error instanceof ExpertLibraryError && error.code === "unauthorized");
  const malformed: PermissionPort = { ...permission("approved").port, async awaitDecision() { return JSON.parse('{"resolution":"approved","scope":"global"}'); } };
  await assert.rejects(createPermissionExpertAuthorization({ permission: malformed }).authorize(action, {}), error => error instanceof ExpertLibraryError && error.code === "unauthorized");
});
