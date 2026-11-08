import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNdjsonSessionStore } from "../../../adapters/session-store/ndjson.js";
import { readSessionContent, sessionContentRecordRef } from "./session.js";

test("real session read transports original requirement and paired tool result while excluding reasoning and host learning tools", async () => {
  const root = await mkdtemp(join(tmpdir(), "trylo-content-session-"));
  const session = createNdjsonSessionStore({ path: join(root, "session.ndjson") });

  try {
    assert.ok((await session.start({ sessionId: "session:1", createdAt: "2026-11-04T12:00:00Z", fingerprint: {
      schemaVersion: "1", providerId: "local", model: "contract", toolCatalogHash: "catalog", workspaceId: "workspace:a" } })).ok);
    const append = async (payload: Parameters<typeof session.append>[0]["payload"]) => session.append({
      type: "transcript_item", sessionId: "session:1", turnId: "turn:1", at: "2026-11-04T12:01:00Z", payload });
    const user = await append({ kind: "user", sequence: 0, text: "Find the complete owning source and preserve file references." });
    assert.ok(user.ok);
    assert.ok((await append({ kind: "tool_call", sequence: 1, toolCallId: "read:1", name: "Read", arguments: { file: "owner.ts" } })).ok);
    const result = await append({ kind: "tool_result", sequence: 2, toolCallId: "read:1", name: "Read", output: "export function owner() {}", truncated: false, outcome: "succeeded" });
    assert.ok(result.ok);
    assert.ok((await append({ kind: "assistant_reasoning", sequence: 3, blockId: "private", text: "private reasoning", redacted: false })).ok);
    assert.ok((await append({ kind: "tool_call", sequence: 4, toolCallId: "learning:1", name: "ContentPrepare", arguments: {} })).ok);
    assert.ok((await append({ kind: "tool_result", sequence: 5, toolCallId: "learning:1", name: "ContentPrepare", output: "internal material packet", truncated: false, outcome: "succeeded" })).ok);
    const read = await readSessionContent({ session, sessionId: "session:1", turnId: "turn:1", scope: "repo:a", subsystem: "tool",
      enabled: () => true, excludeToolNames: ["ContentPrepare"] }, new AbortController().signal);

    assert.ok(read.ok);
    assert.equal(read.value.batch.requirements[0]?.requirement, "Find the complete owning source and preserve file references.");
    assert.equal(read.value.batch.records[0]?.ref, sessionContentRecordRef("session:1", user.sequence));
    assert.equal(read.value.batch.records.find(row => row.sequence === result.sequence)?.text, "export function owner() {}");
    assert.equal(read.value.batch.records.length, 3);
    assert.equal(read.value.coverage.workspaceId, "workspace:a");
    assert.ok(!JSON.stringify(read.value.batch).includes("private reasoning"));
    assert.ok(!JSON.stringify(read.value.batch).includes("internal material packet"));
    const bounded = await readSessionContent({ session, sessionId: "session:1", turnId: "turn:1", scope: "repo:a", subsystem: "tool",
      enabled: () => true, maximumRecords: 2, excludeToolNames: ["ContentPrepare"] }, new AbortController().signal);

    assert.ok(bounded.ok);
    assert.equal(bounded.value.batch.requirements.length, 1);
    assert.ok(bounded.value.coverage.omitted.includes(sessionContentRecordRef("session:1", result.sequence)));
  } finally {
    await session.release();
    await rm(root, { recursive: true, force: true });
  }
});

test("disabled automatic session source never reads the journal", async () => {
  let reads = 0;
  const result = await readSessionContent({ session: { async readRecords() {
    reads++;
    throw new Error("must not read");
  } },
    sessionId: "s", turnId: "t", scope: "repo:a", subsystem: "method", enabled: () => false }, new AbortController().signal);
  assert.deepEqual(result, { ok: false, reason: "collect_disabled" });
  assert.equal(reads, 0);
});
