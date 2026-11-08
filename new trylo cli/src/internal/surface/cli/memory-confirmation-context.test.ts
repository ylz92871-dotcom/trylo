import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { memoryForTurnInput } from "./memory-wiring.js";

test("a restored user event confirms the same pending proposal created before exit", () => {
  const root = mkdtempSync(path.join(tmpdir(), "wpcl-event-"));
  try {
    const userLearning = { homeDir: root, env: { TRYLO_HOME: root }, workspaceId: "ws", now: () => 1, warn: () => undefined };
    const request = { commandId: "call", subject: "Alice", statement: "我是 Alice", factKind: "identity_fact" as const, scopeKind: "user" as const };
    const first = memoryForTurnInput({ userLearning, sessionId: "s", turnId: "t1", text: "我是 Alice" }).write;

    assert.equal(first?.remember(request).result, "pending");
    const resumed = memoryForTurnInput({ userLearning, sessionId: "s", turnId: "t2", text: "好的", resumeRecords: [
      { formatVersion: "1", sequence: 1, type: "transcript_item", sessionId: "s", turnId: "t1", at: "fixture",
        payload: { kind: "user", sequence: 0, text: "我是 Alice" } },
    ] }).write;

    assert.equal(resumed?.remember(request).result, "saved");
    const fact = resumed?.visible()[0];

    assert.equal(fact?.source.kind, "user_confirmation");
    assert.equal(fact?.source.kind === "user_confirmation" && fact.source.confirmsEventId, "s:t1:user");
    assert.equal(existsSync(path.join(root, "learning/user/facts.ndjson")), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
