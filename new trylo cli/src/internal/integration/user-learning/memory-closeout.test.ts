import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, appendFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFileFactStore, USER_FACTS_FILE } from "./facts-file.js";
import { createUserMemoryService, type UserMemoryDeps } from "./memory-service.js";
import { deleteUserMemory } from "./memory-delete.js";
import { createMemoryWriteTools } from "../../adapters/tools/memory/write.js";
import { memoryDocuments } from "../../adapters/tools/memory/source.js";
import { createMemoryReadPort } from "../../adapters/tools/memory/port.js";
import { createMemoryTools } from "../../adapters/tools/memory/index.js";

function fixture(body: (deps: UserMemoryDeps, root: string) => void): void {
  const root = mkdtempSync(path.join(tmpdir(), "wpcl-closeout-"));
  try {
    body({ store: createFileFactStore(root), userId: "alice", workspaceId: "ws-a", now: () => 100,
      switchValue: "user", turn: { sessionId: "s", turnId: "t", userEventId: "u", userText: "我是 Alice，请记住" } }, root);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

const remember = { commandId: "save", subject: "Alice", statement: "我是 Alice", factKind: "identity_fact" as const, scopeKind: "user" as const };

test("after an identity correction retrieval quotes the current statement with unambiguous mutation metadata", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "wpcl-retrieval-"));
  try {
    const deps: UserMemoryDeps = { store: createFileFactStore(root), userId: "alice", workspaceId: "ws", switchValue: "user", now: () => 1,
      turn: { sessionId: "s", turnId: "t1", userEventId: "u1", userText: "我是 Alice，请记住" } };
    const saved = createUserMemoryService(deps).remember(remember);
    if (saved.result !== "saved") return assert.fail("save failed");

    const current = createUserMemoryService({ ...deps, turn: { ...deps.turn, turnId: "t2", userText: "我叫 Alex，请更正" } });

    assert.equal(current.correct({ recordId: saved.recordId, expectedVersion: 1, commandId: "edit", statement: "我叫 Alex" }).result, "saved");
    const tool = createMemoryTools(createMemoryReadPort(async () => memoryDocuments({ facts: () => current.visible() })));
    const result = await tool.execute({ toolCallId: "read", name: "memory_search", arguments: { queries: [] } }, new AbortController().signal);

    assert.equal(result.outcome, "result");

    if (result.outcome !== "result") return;

    assert.match(result.output, /我叫 Alex/u);
    assert.doesNotMatch(result.output, /Alice/u);
    assert.match(result.output, new RegExp(`record_id: ${saved.recordId}; expected_version: 2`));
    assert.doesNotMatch(result.output, new RegExp(`user-memory:${saved.recordId}:\\d`));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a generic OK without a bound proposal cannot persist an earlier identity", () => fixture((deps) => {
  const service = createUserMemoryService({ ...deps, turn: { ...deps.turn, userText: "好的",
    priorUser: [{ text: "我是 Alice", eventId: "u1" }] } });
  assert.equal(service.remember(remember).result, "rejected");
  assert.deepEqual(service.visible(), []);
}));

test("a memory confirmation cannot reach past the most recent user instruction", () => fixture((deps) => {
  const service = createUserMemoryService({ ...deps, turn: { ...deps.turn, userText: "记住吧",
    priorUser: [{ text: "我是 Alice，请记住", eventId: "u1" }, { text: "先看看报错", eventId: "u2" }] } });
  assert.equal(service.remember(remember).result, "rejected");
}));

test("a generic OK can confirm a pending proposal bound to the preceding user event", () => fixture((deps) => {
  const first = createUserMemoryService({ ...deps, turn: { ...deps.turn, userText: "我是 Alice" } });
  assert.equal(first.remember(remember).result, "pending");
  const second = createUserMemoryService({ ...deps, turn: { ...deps.turn, turnId: "t2", userText: "好的",
    priorUser: [{ text: "我是 Alice", eventId: deps.turn.userEventId }] } });
  assert.equal(second.remember(remember).result, "saved");
}));

test("another profile cannot revise or retract a record even if it knows the id", () => fixture((deps) => {
  const saved = createUserMemoryService(deps).remember(remember);

  assert.equal(saved.result, "saved");

  if (saved.result !== "saved") return;

  const stranger = createUserMemoryService({ ...deps, userId: "bob", turn: { ...deps.turn, userText: "请更正身份为：我是 Bob；请撤回这条记忆" } });
  const update = stranger.correct({ commandId: "edit", recordId: saved.recordId, expectedVersion: 1, statement: "我是 Bob" });

  assert.equal(update.result, "rejected");
  assert.equal(update.result === "rejected" && update.reason, "scope_not_permitted");
  assert.equal(stranger.retract({ commandId: "remove", recordId: saved.recordId, expectedVersion: 1 }).result, "rejected");
}));

test("punctuation-only statements cannot pass user grounding", () => fixture((deps) => {
  assert.equal(createUserMemoryService(deps).remember({ ...remember, statement: "!!!" }).result, "rejected");
}));

test("a negative remember instruction never authorizes a save", () => fixture((deps) => {
  const result = createUserMemoryService({ ...deps, turn: { ...deps.turn, userText: "我是 Alice，不要记住" } }).remember(remember);
  assert.notEqual(result.result, "saved");
}));

test("a stale command replay does not claim a retracted record is still saved", () => fixture((deps) => {
  const service = createUserMemoryService(deps), saved = service.remember(remember);
  if (saved.result !== "saved") return assert.fail("initial save failed");
  createUserMemoryService({ ...deps, turn: { ...deps.turn, userText: "请撤回这条记忆" } })
    .retract({ commandId: "remove", recordId: saved.recordId, expectedVersion: 1 });
  assert.notEqual(service.remember(remember).result, "already_saved");
}));

test("a correction retry returns the committed version instead of a spurious conflict", () => fixture((deps) => {
  const saved = createUserMemoryService(deps).remember(remember);
  if (saved.result !== "saved") return assert.fail("initial save failed");
  const service = createUserMemoryService({ ...deps, turn: { ...deps.turn, turnId: "edit", userText: "请更正身份为：我叫 Alex" } });
  const edit = { commandId: "edit", recordId: saved.recordId, expectedVersion: 1, statement: "我叫 Alex" };
  assert.equal(service.correct(edit).result, "saved");
  assert.equal(service.correct(edit).result, "already_saved");
}));

test("a malformed fact line blocks writes instead of silently editing a partial ledger", () => fixture((deps, root) => {
  const service = createUserMemoryService(deps);
  service.remember(remember);
  appendFileSync(path.join(root, USER_FACTS_FILE), "{broken\n");
  const result = service.remember({ ...remember, commandId: "other" });
  assert.equal(result.result, "failed");
}));

test("a malformed memory source cannot look like an empty successful retrieval", () => fixture((deps, root) => {
  const service = createUserMemoryService(deps);
  service.remember(remember);
  appendFileSync(path.join(root, USER_FACTS_FILE), "{broken\n");
  assert.throws(() => service.visible(), /source_unavailable/u);
}));

test("delete-all refuses a held fact lock instead of stealing it", () => fixture((deps, root) => {
  createUserMemoryService(deps).remember(remember);
  writeFileSync(path.join(root, "facts.lock"), "other-writer");
  const deleted = deleteUserMemory(root);
  assert.equal(deleted.ok, false);
  assert.equal(existsSync(path.join(root, "facts.lock")), true);
  assert.equal(existsSync(path.join(root, USER_FACTS_FILE)), true);
}));

test("the model correction tool updates the same record and retraction has a truthful receipt", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "wpcl-correct-tool-"));
  try {
    const store = createFileFactStore(root);
    const deps: UserMemoryDeps = { store, userId: "alice", workspaceId: "ws", switchValue: "user", now: () => 100,
      turn: { sessionId: "s", turnId: "first", userEventId: "u1", userText: "我是 Alice，请记住" } };
    const saved = createUserMemoryService(deps).remember(remember);
    if (saved.result !== "saved") return assert.fail("initial save failed");

    const service = createUserMemoryService({ ...deps, turn: { ...deps.turn, turnId: "second", userText: "请更正身份为我叫 Alex；请撤回这条记忆" } });
    const tools = createMemoryWriteTools(service), signal = new AbortController().signal;
    const edited = await tools.execute({ name: "memory_correct", toolCallId: "edit", arguments: { record_id: saved.recordId, expected_version: 1, statement: "我叫 Alex" } }, signal);

    assert.equal(edited.outcome, "result");
    assert.equal(service.visible()[0]?.version, 2);
    const removed = await tools.execute({ name: "memory_forget", toolCallId: "remove", arguments: { record_id: saved.recordId, expected_version: 2 } }, signal);

    assert.equal(removed.outcome, "result");
    assert.match(removed.outcome === "result" ? removed.output : "", /已撤回/u);
    assert.equal(service.visible().length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
