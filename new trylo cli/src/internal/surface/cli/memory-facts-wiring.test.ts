import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { memoryPortFor } from "./memory-wiring.js";
import { createFileFactStore } from "../../integration/user-learning/facts-file.js";
import { createUserMemoryService } from "../../integration/user-learning/memory-service.js";

/**
 * WP-CL / B：保存之后，同一次运行的下一次检索必须看得到它。
 *
 * 这条用例是"存了但读不回来"的直接反面：事实源接进 `memoryPortFor` 之后，
 * 命中结果要带 `user-memory` 来源，模型才有依据说"我记得"。
 */

test("a saved fact is retrievable in the same run and names its origin", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "wpcl-retrieval-"));
  try {
    const service = createUserMemoryService({
      store: createFileFactStore(root), userId: "local-user", workspaceId: "ws-a",
      now: () => 1_760_000_000_000, switchValue: "user",
      turn: { sessionId: "s1", turnId: "t1", userText: "我是 YL Z，Trylo 的开发者，请记住", userEventId: "s1:t1:user" },
    });
    const saved = service.remember({
      commandId: "call-1", subject: "YL Z", statement: "我是 YL Z，Trylo 的开发者，请记住",
      factKind: "identity_fact", scopeKind: "user",
    });

    assert.equal(saved.result, "saved");

    const port = memoryPortFor({ facts: () => service.visible() });

    assert.ok(port, "facts alone must be enough to build a memory port");
    const outcome = await port.search({
      queries: ["YL Z"], matchMode: "any", contextLines: 0, caseSensitive: true,
      normalized: false, maxResults: 10,
    }, new AbortController().signal);

    assert.equal(outcome.ok, true);
    assert.equal(outcome.ok ? outcome.matches.length : 0, 1);
    assert.equal(outcome.ok ? outcome.matches[0]?.origin : undefined, "user-memory");

    const read = await port.read({ documentId: "user-memory:" + (saved.result === "saved" ? saved.recordId : ""), lineOffset: 1 },
      new AbortController().signal);

    assert.equal(read.ok, true);
    assert.match(read.ok ? read.content : "", /YL Z/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("no facts and no other source means no memory port at all", () => {
  assert.equal(memoryPortFor({}), undefined);
});
