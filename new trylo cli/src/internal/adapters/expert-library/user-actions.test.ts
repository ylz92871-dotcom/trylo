import assert from "node:assert/strict";
import { test } from "node:test";
import { ExpertLibrary, executeExpertCommand, expertRequestAuthorizationAction } from "../../subagent/experts/index.js";
import type { ExpertActionContext, ExpertCommand, ExpertConfiguration, ExpertLibrarySnapshot, ExpertRequest, ExpertStorePort } from "../../subagent/experts/index.js";
import { createPermissionExpertAuthorization } from "./permission.js";
import { createExpertUserActionBridge } from "./user-actions.js";

const configuration: ExpertConfiguration = { displayName: "API 专家", specialty: "Public API compatibility", baseRole: "worker",
  situations: ["API changes"], responsibilities: ["Check consumer contracts"], constraints: ["Preserve exported signatures"],
  collaboration: ["Report findings to reviewer"], role: { name: "worker", description: "API compatibility specialist" }, toolRefs: [],
  sources: [{ kind: "user", title: "API policy", uri: "user:api-policy", excerpt: "Inspect exports and their consumers." }],
  methods: [{ title: "Consumer review", instructions: "Inspect exported types and run affected consumer checks.", sourceUris: ["user:api-policy"] }] };

function fixture() {
  let snapshot: ExpertLibrarySnapshot = { schemaVersion: 1, sequence: 0, experts: [], requests: [] };
  const store: ExpertStorePort = { read: () => structuredClone(snapshot), update(sequence, next) {
    assert.equal(sequence, snapshot.sequence);
    snapshot = structuredClone(next);
  } };
  let prompts = 0;
  const bridge = createExpertUserActionBridge();
  const library = new ExpertLibrary({ store, builder: { async build() { return configuration; } },
    authorization: createPermissionExpertAuthorization({ permission: {
      async request(action) {
        prompts += 1;
        return { ticketId: `ticket-${prompts}`, toolCallId: action.toolCallId };
      },
      async awaitDecision() { return { resolution: "denied", scope: "once" }; },
    }, consumeUserAction: bridge.consumeUserAction }) });
  const execute = (command: ExpertCommand, context: ExpertActionContext) => executeExpertCommand(library, command, context);
  const run = (command: ExpertCommand) => bridge.executeUserAction({ library, command, execute });

  return { bridge, library, store, execute, run, prompts: () => prompts };
}

test("trusted UI commands create, edit the actual candidate, and save without duplicate prompts", async () => {
  const f = fixture();
  const submitted = await f.run({ operation: "submit", origin: "settings", instruction: "Create API expert" }) as ExpertRequest;

  assert.equal(submitted.state, "authorized");
  const built = await f.library.build(submitted.requestId);
  const edited = await f.run({ operation: "edit", requestId: built.requestId, edits: { constraints: ["Never change user-authored public signatures"] } }) as ExpertRequest;

  assert.deepEqual(edited.configuration?.constraints, ["Never change user-authored public signatures"]);
  const saved = await f.run({ operation: "retain", requestId: built.requestId, result: { kind: "save" } }) as ExpertRequest;

  assert.equal(saved.state, "saved");
  assert.equal(f.prompts(), 0);
  assert.equal(f.library.get(saved.expertId)?.version, 1);
});

test("ordinary model execution and invented action IDs cannot mint UI authorization", async () => {
  const f = fixture();
  const denied = await f.execute({ operation: "submit", origin: "personal_agent", instruction: "Create without consent" }, { userActionId: "invented-ui-click" }) as ExpertRequest;
  assert.equal(denied.state, "rejected");
  assert.equal(f.prompts(), 1);
});

test("UI submit grant is bound to its assigned request ID and canonical command", async () => {
  const f = fixture();
  const denied = await f.bridge.executeUserAction({ library: f.library,
    command: { operation: "submit", origin: "settings", instruction: "Create the reviewed expert" },
    execute: (command, context) => {
      assert.equal(command.operation, "submit");
      if (command.operation !== "submit") throw new Error("test expected a canonical submit");
      return f.execute({ ...command, instruction: "Create another unreviewed expert" }, context);
    },
  }) as ExpertRequest;

  assert.equal(denied.state, "rejected");
  assert.equal(f.prompts(), 1);
});

test("a changed draft revision invalidates the in-flight user grant", async () => {
  const f = fixture();
  const submitted = await f.run({ operation: "submit", origin: "settings", instruction: "Create API expert" }) as ExpertRequest;

  await f.library.build(submitted.requestId);
  await assert.rejects(f.bridge.executeUserAction({ library: f.library,
    command: { operation: "edit", requestId: submitted.requestId, edits: { specialty: "User reviewed API specialty" } },
    execute: (command, context) => {
      const current = f.store.read();
      f.store.update(current.sequence, { ...current, sequence: current.sequence + 1,
        requests: current.requests.map(request => request.requestId === submitted.requestId ? { ...request, revision: request.revision + 1 } : request) });
      return f.execute(command, context);
    },
  }), { code: "unauthorized" });
  assert.equal(f.prompts(), 1);
});

test("consumed or completed action IDs cannot authorize another mutation", async () => {
  const f = fixture();
  let captured: string | undefined;
  const request = await f.bridge.executeUserAction({ library: f.library,
    command: { operation: "submit", origin: "settings", instruction: "Create API expert" },
    execute: async (command, context) => {
      captured = context.userActionId;
      const result = await f.execute(command, context) as ExpertRequest;
      assert.ok(captured);
      assert.equal(f.bridge.ownsUserAction(captured), true, "consumed internal tokens must not fall through to another consumer while executing");
      assert.equal(await f.bridge.consumeUserAction(captured, expertRequestAuthorizationAction(result, "create")), false);
      return result;
    },
  }) as ExpertRequest;

  assert.ok(captured);
  assert.equal(f.bridge.ownsUserAction(captured), false);
  await f.library.build(request.requestId);
  await f.execute({ operation: "retain", requestId: request.requestId, result: { kind: "save" } }, { userActionId: captured });
  assert.equal(f.library.request(request.requestId).state, "temporary");
  assert.equal(f.prompts(), 1);
});

test("manual saved-expert revisions bind their new creation request without synthesis", async () => {
  const f = fixture();
  let request = await f.run({ operation: "submit", origin: "settings", instruction: "Create API expert" }) as ExpertRequest;

  request = await f.library.build(request.requestId);
  await f.run({ operation: "retain", requestId: request.requestId, result: { kind: "save" } });
  const revision = await f.run({ operation: "draft_revision", expertId: request.expertId }) as ExpertRequest;

  assert.equal(revision.state, "awaiting_retention");
  assert.notEqual(revision.requestId, request.requestId);
  assert.equal(revision.preparation, "reuse_configuration");
  assert.equal(f.prompts(), 0);
});
