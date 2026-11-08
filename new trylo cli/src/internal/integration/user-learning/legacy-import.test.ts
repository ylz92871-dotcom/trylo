import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFileFactStore } from "./facts-file.js";
import { decodeLegacyDocument, importLegacyFacts, legacyRecordId, type LegacyFactEntry } from "./legacy-import.js";
import { activeFacts } from "../../learning/domains/user/memory-fact.js";

/**
 * WP-CL / B17：旧面板记录导入。
 *
 * 两条线必须同时成立：**有用户来源的搬得进来**，**模型推断的搬不进来**。
 * 后者如果放行，等于把"模型猜的"洗成"用户说的"，比不导入严重得多。
 */

const stated: LegacyFactEntry = {
  legacyId: "old-1", subject: "YL Z", statement: "我是 YL Z，Trylo 的开发者",
  factKind: "identity_fact", scope: { kind: "user", userId: "local-user" },
  provenance: "user_stated", status: "active", createdAt: 1_760_000_000_000,
};

function recordsOf(store: ReturnType<typeof createFileFactStore>) {
  const read = store.read();
  return read.ok ? read.records : [];
}

function withStore(body: (store: ReturnType<typeof createFileFactStore>) => void): void {
  const root = mkdtempSync(path.join(tmpdir(), "wpcl-legacy-"));
  try {
    body(createFileFactStore(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("a user-stated legacy fact is imported once and maps to a stable record id", () => {
  withStore((store) => {
    const first = importLegacyFacts(store, [stated], () => 1);

    assert.deepEqual(first, [{ legacyId: "old-1", outcome: "imported", recordId: legacyRecordId("old-1"), version: 1 }]);
    assert.equal(legacyRecordId("old-1"), legacyRecordId("old-1"), "the mapping must be stable across runs");

    const again = importLegacyFacts(store, [stated], () => 2);

    assert.equal(again[0]?.outcome, "already");
    assert.equal(activeFacts(recordsOf(store)).length, 1);
  });
});

test("assistant-inferred and unknown provenance stay where they are", () => {
  withStore((store) => {
    const decisions = importLegacyFacts(store, [
      { ...stated, legacyId: "a", provenance: "assistant_inferred" },
      { ...stated, legacyId: "b", provenance: "unknown" },
    ], () => 1);

    assert.deepEqual(decisions.map((decision) => decision.outcome), ["skipped", "skipped"]);
    assert.deepEqual(decisions.map((decision) => decision.outcome === "skipped" ? decision.reason : ""),
      ["provenance_assistant_inferred", "provenance_unknown"]);
    assert.equal(recordsOf(store).length, 0, "nothing may be written");
  });
});

test("candidate and retracted entries are not promoted", () => {
  withStore((store) => {
    const decisions = importLegacyFacts(store, [
      { ...stated, legacyId: "c", status: "candidate" },
      { ...stated, legacyId: "d", status: "retracted" },
    ], () => 1);
    assert.deepEqual(decisions.map((decision) => decision.outcome === "skipped" ? decision.reason : ""),
      ["status_candidate", "status_retracted"]);
  });
});

test("a fact the user already saved in a conversation is reused, not duplicated", () => {
  withStore((store) => {
    const manual = {
      record: "user_fact" as const, id: "fact-manual", version: 1, status: "active" as const,
      factKind: "identity_fact" as const, subject: stated.subject, statement: stated.statement,
      scope: stated.scope, source: { kind: "user_statement" as const, eventId: "e" },
      commandId: "c", createdAt: 1,
    };

    assert.equal(store.transact(() => ({ result: 0, commit: [manual] })).ok, true);
    const decisions = importLegacyFacts(store, [stated], () => 1);

    assert.equal(decisions[0]?.outcome, "already");
    assert.equal(decisions[0]?.outcome === "already" ? decisions[0].recordId : "", "fact-manual");
  });
});

test("a panel backup carrying cliImport is unwrapped exactly once", () => {
  // The Desktop export is one file for two purposes: a backup of everything and
  // the narrow document the CLI imports. Unwrapping one level keeps the CLI
  // ignorant of the panel's own snapshot schema.
  const wrapped = { schemaVersion: 7, conversations: { chat: {} }, cliImport: { version: 1, facts: [stated] } };
  const decoded = decodeLegacyDocument(wrapped);

  assert.equal(decoded.ok, true);

  if (decoded.ok) assert.equal(decoded.value.facts[0]?.legacyId, "old-1");

  const tooDeep = { version: 2, cliImport: { version: 2, cliImport: { version: 1, facts: [] } } };

  assert.equal(decodeLegacyDocument(tooDeep).ok, false, "one level only");
});

test("a malformed document is refused whole, never partially imported", () => {
  assert.equal(decodeLegacyDocument({ version: 2, facts: [] }).ok, false);
  assert.equal(decodeLegacyDocument({ version: 1, facts: [{}] }).ok, false);
  const good = decodeLegacyDocument({ version: 1, facts: [stated] });
  assert.equal(good.ok, true);
  if (good.ok) assert.equal(good.value.facts.length, 1);
});
