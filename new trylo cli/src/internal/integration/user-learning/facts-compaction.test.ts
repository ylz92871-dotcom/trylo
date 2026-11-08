import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFileFactStore, USER_FACTS_FILE, USER_FACTS_LOCK } from "./facts-file.js";
import { createUserMemoryService } from "./memory-service.js";
import { importLegacyFacts, type LegacyFactEntry } from "./legacy-import.js";
import { deleteUserMemory } from "./memory-delete.js";
import { activeFacts, foldFacts, type UserFactRecord } from "../../learning/domains/user/memory-fact.js";

function withRoot(body: (root: string) => void): void {
  const root = mkdtempSync(path.join(tmpdir(), "wpcl-compact-"));
  try { body(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

function fact(id: string, version = 1, status: "active" | "retracted" = "active"): UserFactRecord {
  return { record: "user_fact", id, version, status, subject: id, statement: `${id}-v${version}`, factKind: "identity_fact",
    scope: { kind: "user", userId: "u" }, source: { kind: "user_statement", eventId: "e" },
    commandId: `s:t:${id}-${version}`, createdAt: version, ...(version > 1 ? { supersedes: version - 1 } : {}) };
}

function compact(root: string): { readonly ok: boolean; readonly reason?: string } {
  const store = createFileFactStore(root);
  const method: unknown = Reflect.get(store, "compact");
  assert.equal(typeof method, "function", "formal store must expose an atomic compaction transaction");
  return Reflect.apply(method as (...args: never[]) => unknown, store, []) as { readonly ok: boolean; readonly reason?: string };
}

function service(root: string, text: string) {
  return createUserMemoryService({ store: createFileFactStore(root), userId: "u", workspaceId: "w", now: () => 20,
    switchValue: "user", turn: { sessionId: "s", turnId: "t", userText: text, userEventId: "e" } });
}

test("B14 compact retains current/retracted versions through 600 noise records and rejects old save/revision commands", () => {
  withRoot((root) => {
    const rows = [fact("identity"), fact("identity", 2), fact("forgotten"), fact("forgotten", 2, "retracted"),
      ...Array.from({ length: 610 }, (_, index) => fact(`noise-${index}`))];

    assert.equal(createFileFactStore(root).append(rows).ok, true);
    assert.equal(compact(root).ok, true);
    const read = createFileFactStore(root).read();

    assert.equal(read.ok, true);

    if (!read.ok) return;

    assert.equal(read.records.length, 612);
    assert.equal(foldFacts(read.records).find((row) => row.id === "identity")?.version, 2);
    assert.equal(activeFacts(read.records).some((row) => row.id === "forgotten"), false);
    const text = "请记住 forgotten-v1";
    const replay = service(root, text).remember({ commandId: "forgotten-1", subject: "forgotten", statement: "forgotten-v1", factKind: "identity_fact", scopeKind: "user" });

    assert.equal(replay.result, "rejected");

    if (replay.result === "rejected") assert.equal(replay.reason, "command_conflict");

    const changed = service(root, "请更正身份为 new text").correct({ recordId: "forgotten", expectedVersion: 2, commandId: "forgotten-1", statement: "new text" });

    assert.equal(changed.result, "rejected");

    if (changed.result === "rejected") assert.equal(changed.reason, "command_conflict");

    assert.equal(compact(root).ok, true);
    assert.equal(service(root, "").visible().some((row) => row.id === "forgotten"), false);
  });
});

test("B14 read and write capacity failures are explicit and leave existing bytes untouched", () => {
  withRoot((root) => {
    const file = path.join(root, USER_FACTS_FILE);

    writeFileSync(file, "");
    truncateSync(file, 16 * 1024 * 1024 + 1);
    const large = createFileFactStore(root).read();

    assert.equal(large.ok, false);

    if (!large.ok) assert.equal(large.reason, "facts_capacity_exceeded:bytes");

    writeFileSync(file, `${JSON.stringify(fact("kept"))}\n`);
    const original = readFileSync(file);
    const huge = createFileFactStore(root).append([{ ...fact("oversized"), statement: "x".repeat(65_536) }]);

    assert.equal(huge.ok, false);
    assert.deepEqual(readFileSync(file), original);
    writeFileSync(file, "\n".repeat(32_769));
    assert.equal(createFileFactStore(root).read().ok, true, "empty separators do not consume record quota");
    const row = `${JSON.stringify(fact("same"))}\n`;

    writeFileSync(file, row.repeat(32_769));
    const many = createFileFactStore(root).read();

    assert.equal(many.ok, false);

    if (!many.ok) assert.equal(many.reason, "facts_capacity_exceeded:records");
  });
});

test("B14 compact cannot race an active writer, consume a foreign temporary file, or rewrite corrupt bytes", () => {
  withRoot((root) => {
    const store = createFileFactStore(root);

    store.append([fact("kept")]);
    const file = path.join(root, USER_FACTS_FILE), lock = path.join(root, USER_FACTS_LOCK);
    const before = readFileSync(file);

    writeFileSync(lock, "other writer");
    assert.equal(compact(root).ok, false);
    assert.equal(readFileSync(lock, "utf8"), "other writer");
    rmSync(lock);
    const temporary = `${file}.compact.tmp`;

    writeFileSync(temporary, "other interrupted transaction");
    assert.equal(compact(root).ok, false);
    assert.equal(readFileSync(temporary, "utf8"), "other interrupted transaction");
    assert.deepEqual(readFileSync(file), before);
    rmSync(temporary);
    writeFileSync(file, "{broken\n");
    assert.equal(compact(root).ok, false);
    assert.equal(readFileSync(file, "utf8"), "{broken\n");
    assert.deepEqual(readdirSync(root), [USER_FACTS_FILE]);
  });
});

test("B17 legacy retry after revision, retraction and compact never imports an active old version", () => {
  withRoot((root) => {
    const entry: LegacyFactEntry = { legacyId: "old-1", subject: "old", statement: "old identity", factKind: "identity_fact",
      scope: { kind: "user", userId: "u" }, provenance: "user_stated", status: "active", createdAt: 1 };
    const imported = importLegacyFacts(createFileFactStore(root), [entry], () => 1)[0];

    assert.equal(imported?.outcome, "imported");

    if (imported === undefined) return;

    assert.equal(service(root, "撤回").retract({ recordId: imported.recordId, expectedVersion: 1, commandId: "forget" }).result, "saved");
    assert.equal(compact(root).ok, true);
    assert.equal(importLegacyFacts(createFileFactStore(root), [entry], () => 30)[0]?.outcome, "already");
    assert.equal(service(root, "").visible().length, 0);
  });
});

test("B14 persisted command history has a strict codec and cannot hide malformed command IDs", () => {
  withRoot((root) => {
    writeFileSync(path.join(root, USER_FACTS_FILE), `${JSON.stringify({ ...fact("invalid"), previousCommandIds: ["old", 23] })}\n`);
    const read = createFileFactStore(root).read();
    assert.equal(read.ok && read.unreadable, 1);
    assert.equal(compact(root).ok, false);
  });
});

test("B10 semantic dedupe consumes a new command ID, survives fold/compact, and conflicts after correction", () => {
  withRoot((root) => {
    const memory = service(root, "请记住 old identity 和 changed identity");
    const request = { commandId: "save", subject: "old", statement: "old identity", factKind: "identity_fact" as const, scopeKind: "user" as const };
    const first = memory.remember(request);

    assert.equal(first.result, "saved");

    if (first.result !== "saved") return;

    const alias = { ...request, commandId: "alias" };

    assert.equal(memory.remember(alias).result, "already_saved");
    const conflict = memory.remember({ ...alias, statement: "changed identity" });

    assert.equal(conflict.result, "rejected");
    assert.equal(compact(root).ok, true);
    assert.equal(service(root, "请记住 old identity").remember(alias).result, "already_saved");
    assert.equal(service(root, "请更正身份为 changed identity").correct({ commandId: "correct", recordId: first.recordId, expectedVersion: 1, statement: "changed identity" }).result, "saved");
    assert.equal(compact(root).ok, true);
    assert.equal(service(root, "请记住 old identity").remember(alias).result, "rejected");
    assert.equal(memory.visible().filter((record) => record.id === first.recordId).length, 1);
    assert.equal(memory.visible().find((record) => record.id === first.recordId)?.statement, "changed identity");
  });
});

test("B17 semantic legacy mapping survives later retraction and compact", () => {
  withRoot((root) => {
    const memory = service(root, "请记住 old identity");
    const saved = memory.remember({ commandId: "save", subject: "old", statement: "old identity", factKind: "identity_fact", scopeKind: "user" });

    assert.equal(saved.result, "saved");

    if (saved.result !== "saved") return;

    const entry: LegacyFactEntry = { legacyId: "mapped", subject: "old", statement: "old identity", factKind: "identity_fact",
      scope: { kind: "user", userId: "u" }, provenance: "user_stated", status: "active", createdAt: 1 };

    assert.equal(importLegacyFacts(createFileFactStore(root), [entry], () => 2)[0]?.outcome, "already");
    assert.equal(service(root, "请撤回这条记忆").retract({ commandId: "forget", recordId: saved.recordId, expectedVersion: 1 }).result, "saved");
    assert.equal(compact(root).ok, true);
    assert.equal(importLegacyFacts(createFileFactStore(root), [entry], () => 3)[0]?.outcome, "already");
    assert.equal(memory.visible().length, 0);
  });
});

test("B10 pending same-key same-payload is idempotent and changed payload is a conflict", () => {
  withRoot((root) => {
    const memory = service(root, "我是 old identity，也叫 changed identity");
    const request = { commandId: "pending", subject: "old", statement: "old identity", factKind: "identity_fact" as const, scopeKind: "user" as const };
    const first = memory.remember(request);

    assert.equal(first.result, "pending");
    const before = readFileSync(path.join(root, USER_FACTS_FILE));

    assert.deepEqual(memory.remember(request), first);
    assert.deepEqual(readFileSync(path.join(root, USER_FACTS_FILE)), before);
    const changed = memory.remember({ ...request, statement: "changed identity" });

    assert.equal(changed.result, "rejected");

    if (changed.result === "rejected") assert.equal(changed.reason, "command_conflict");

    assert.deepEqual(readFileSync(path.join(root, USER_FACTS_FILE)), before);
  });
});

test("B20 delete-all removes crash-left compact plaintext under the shared lock", () => {
  withRoot((root) => {
    const temporary = `${USER_FACTS_FILE}.compact.tmp`;

    writeFileSync(path.join(root, temporary), `${JSON.stringify(fact("private"))}\n`);
    writeFileSync(path.join(root, "other-owner"), "keep");
    assert.equal(deleteUserMemory(root).ok, true);
    assert.deepEqual(readdirSync(root), ["other-owner"]);
    const read = createFileFactStore(root).read();

    assert.deepEqual(read.ok ? read.records : ["failed"], []);
    assert.equal(compact(root).ok, true);
    assert.deepEqual(service(root, "").visible(), []);
  });
});

test("B14 new compacted command semantics use v2 while v1 facts remain readable", () => {
  withRoot((root) => {
    const file = path.join(root, USER_FACTS_FILE);

    writeFileSync(file, `${JSON.stringify(fact("legacy"))}\n`);
    assert.equal(service(root, "").visible().length, 1);
    assert.equal(compact(root).ok, true);
    assert.equal(JSON.parse(readFileSync(file, "utf8").trim()).formatVersion, 2);
    writeFileSync(file, `${JSON.stringify({ ...fact("invalid"), formatVersion: 1, previousCommandIds: ["old-key"] })}\n`);
    const read = createFileFactStore(root).read();

    assert.equal(read.ok && read.unreadable, 1, "v1 must not disguise v2 command consumption fields");
  });
});
