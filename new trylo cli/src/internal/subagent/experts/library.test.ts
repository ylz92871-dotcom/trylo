import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ExpertLibrary, instantiateExpertFromLibrary, parseExpertCommand, validateEdits } from "./index.js";
import { createFileExpertStore, createPermissionExpertAuthorization } from "../../adapters/expert-library/index.js";
import type { ExpertConfiguration } from "./contracts.js";

const configuration: ExpertConfiguration = {
  displayName: "TypeScript API 专家", specialty: "TypeScript public API", baseRole: "worker",
  situations: ["TypeScript API changes"], responsibilities: ["Maintain public API contracts"],
  constraints: ["Preserve backwards compatibility"], collaboration: ["Ask reviewer to inspect API diff"],
  role: { name: "worker", description: "TypeScript API specialist", skills: [] }, toolRefs: ["runtime:read_file"],
  sources: [{ kind: "user", title: "Repository API policy", uri: "user:api-policy", excerpt: "Preserve API compatibility and test consumers." }],
  methods: [{ title: "Consumer contract check", instructions: "List exported types, compare consumers, run affected type checks.", sourceUris: ["user:api-policy"] }],
};

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "trylo-experts-"));
  const store = createFileExpertStore(root);
  let prompts = 0;
  let permit = true;
  let cancelNext = false;
  const authorization = createPermissionExpertAuthorization({ permission: {
    async request(action) {
      prompts += 1;
      return { ticketId: action.toolCallId, toolCallId: action.toolCallId };
    },
    async awaitDecision() {
      if (cancelNext) {
        cancelNext = false;
        return { resolution: "cancelled", scope: "once" };
      }
      return { resolution: permit ? "approved" : "denied", scope: "once" };
    },
  }, async consumeUserAction(id) { return id === "trusted-click"; } });
  const library = new ExpertLibrary({ store, authorization, builder: { async build() { return structuredClone(configuration); } } });

  return { root, store, library, authorization, prompts: () => prompts, deny: () => { permit = false; }, cancelOnce: () => { cancelNext = true; } };
}

test("cancelled manual revision approval resumes the existing config without invoking construction", async () => {
  const f = fixture();
  try {
    const seed = await f.library.submitRequest({ origin: "settings", instruction: "Seed" }, { userActionId: "trusted-click" });

    await f.library.build(seed.requestId);
    await f.library.retain(seed.requestId, { kind: "save" }, { userActionId: "trusted-click" });
    f.cancelOnce();
    const pending = await f.library.draftRevision(seed.expertId);

    assert.equal(pending.state, "awaiting_creation");
    const resumed = await f.library.authorizeCreation(pending.requestId, { userActionId: "trusted-click" });

    assert.equal(resumed.state, "awaiting_retention");
    assert.deepEqual(resumed.configuration, f.library.get(seed.expertId)?.configuration);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("create, configure, revise, save, reopen and reuse stable expert versions", async () => {
  const f = fixture();
  try {
    let request = await f.library.submitRequest({ origin: "settings", instruction: "创建 TypeScript API 专家" }, { userActionId: "trusted-click" });

    assert.equal(request.state, "authorized");
    request = await f.library.build(request.requestId);
    assert.equal(f.library.query().length, 0, "a draft is not a saved expert");
    request = await f.library.edit(request.requestId, { constraints: ["Never change public signatures without user consent"] }, { userActionId: "trusted-click" });
    request = await f.library.retain(request.requestId, { kind: "revise", feedback: "Improve method details" });
    request = await f.library.build(request.requestId);
    assert.deepEqual(request.configuration?.constraints, ["Never change public signatures without user consent"]);
    request = await f.library.retain(request.requestId, { kind: "save" }, { userActionId: "trusted-click" });
    assert.equal(request.state, "saved");
    assert.equal(f.prompts(), 0, "explicit trusted actions must not prompt a second time");
    const reopened = new ExpertLibrary({ store: createFileExpertStore(f.root), authorization: f.authorization,
      builder: { async build() { return configuration; } } });
    const version1 = reopened.query("TypeScript")[0]!;

    assert.equal(version1.version, 1);
    request = await reopened.submitRequest({ origin: "personal_agent", instruction: "Improve the same expert", expertId: version1.expertId });
    request = await reopened.build(request.requestId);
    request = await reopened.retain(request.requestId, { kind: "save" });
    assert.equal(reopened.get(version1.expertId)?.version, 2);
    assert.equal(reopened.get(version1.expertId)?.experienceKey, version1.experienceKey);
    assert.deepEqual(reopened.get(version1.expertId)?.configuration.constraints, version1.configuration.constraints);
    assert.equal(reopened.get(version1.expertId, 1)?.version, 1);
    const instance = await instantiateExpertFromLibrary(reopened, { expertId: version1.expertId }, {
      memberId: "api-member", runId: "run-api", task: "Check TypeScript public API", surface: "code", catalog: [],
      parent: { model: "inherit", allowedTools: [], maxIterations: 10 }, signal: new AbortController().signal,
    });

    assert.equal(instance.identity.version, 2);
    assert.equal(instance.identity.experienceKey, version1.experienceKey);
    assert.match(instance.member.role.prompt!, /Consumer contract check/);
    assert.match(instance.member.role.prompt!, /Never change public signatures/);
    assert.equal(instance.toolResolutions[0]?.state, "pending");
    const manual = await reopened.draftRevision(version1.expertId, { userActionId: "trusted-click" });

    assert.equal(manual.state, "awaiting_retention");
    assert.deepEqual(manual.configuration, reopened.get(version1.expertId)?.configuration);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("public commands reject model-provided authority and malformed inputs before library calls", () => {
  assert.throws(() => parseExpertCommand({ operation: "retain", requestId: "r", result: { kind: "save" }, userActionId: "approve-myself" }), { code: "invalid_input" });
  assert.throws(() => parseExpertCommand({ operation: "retain", requestId: "r", result: null }), { code: "invalid_input" });
  assert.throws(() => parseExpertCommand({ operation: "query", text: {} }), { code: "invalid_input" });
  assert.throws(() => parseExpertCommand({ operation: "submit", origin: "personal_agent", instruction: "create", useScope: { workspaceId: "fake", taskId: "fake" } }), { code: "invalid_input" });
  assert.throws(() => validateEdits({ constraints: 7 }), { code: "invalid_input" });
  assert.deepEqual(parseExpertCommand({ operation: "submit", origin: "collaboration", instruction: "improve", association: { jobId: "j" } }),
    { operation: "submit", origin: "collaboration", instruction: "improve", association: { jobId: "j" } });
});

test("automatic creation denial prevents builds; retention denial leaves an authorized temporary expert", async () => {
  const f = fixture();
  try {
    f.deny();
    const denied = await f.library.submitRequest({ origin: "collaboration", instruction: "Create specialist" });

    assert.equal(denied.state, "rejected");
    await assert.rejects(f.library.build(denied.requestId), { code: "invalid_state" });
    let temporary = await f.library.submitRequest({ origin: "personal_agent", instruction: "User authorized temporary creation" }, { userActionId: "trusted-click" });

    temporary = await f.library.build(temporary.requestId);
    temporary = await f.library.retain(temporary.requestId, { kind: "save" });
    assert.equal(temporary.state, "temporary");
    assert.equal(f.library.get(temporary.expertId), undefined);
    assert.ok(temporary.creationAuthorization);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("two drafts cannot overwrite a newly saved expert version", async () => {
  const f = fixture();
  try {
    let first = await f.library.submitRequest({ origin: "settings", instruction: "Create" });

    first = await f.library.build(first.requestId);
    await f.library.retain(first.requestId, { kind: "save" });
    const a = await f.library.submitRequest({ origin: "personal_agent", instruction: "A", expertId: first.expertId });
    const b = await f.library.submitRequest({ origin: "collaboration", instruction: "B", expertId: first.expertId });

    await f.library.build(a.requestId);
    await f.library.build(b.requestId);
    await f.library.retain(a.requestId, { kind: "save" });
    await assert.rejects(f.library.retain(b.requestId, { kind: "save" }), { code: "conflict" });
    assert.equal(f.library.get(first.expertId)?.version, 2);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
