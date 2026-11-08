import assert from "node:assert/strict";
import { test } from "node:test";
import { recover } from "../../adapters/session-store/recovery.js";
import { projectForPrompt } from "../../compaction/projection.js";
import { COMPACT_WINDOW_KEYS } from "../../ports/compaction.js";
import type { SessionRecord } from "../../ports/session.js";
import { planFork, type ForkSnapshotRequest } from "./session-fork.js";

const fingerprint = { schemaVersion: "1", providerId: "fixture", model: "m", toolCatalogHash: "h", workspaceId: "w" };

function record(sequence: number, type: SessionRecord["type"], payload: SessionRecord["payload"]): SessionRecord {
  return { formatVersion: "1", sequence, type, sessionId: "parent", at: "2026-11-08T00:00:00.000Z", payload };
}

function compact(sequence: number, windowId: string, from: number, to: number): SessionRecord {
  return record(sequence, "compact", {
    formatVersion: "1", windowId, replacedFromSequence: from, replacedToSequence: to, summary: `public summary ${windowId}`,
  });
}

function journal(): SessionRecord[] {
  return [
    record(0, "session_start", { fingerprint }),
    record(1, "stream_partial", { kind: "assistant_text", blockId: "p", text: "unfinished" }),
    record(2, "transcript_item", { kind: "user", sequence: 0, text: "old request" }),
    record(3, "transcript_item", { kind: "assistant_text", sequence: 1, blockId: "old", text: "old answer" }),
    record(4, "stream_partial", { kind: "assistant_text", blockId: "p2", text: "unfinished" }),
    compact(5, "w1", 1, 4),
    record(6, "transcript_item", { kind: "user", sequence: 0, text: "second request" }),
    record(7, "stream_partial", { kind: "assistant_text", blockId: "p3", text: "unfinished" }),
    record(8, "transcript_item", { kind: "assistant_text", sequence: 1, blockId: "second", text: "second answer" }),
    compact(9, "w2", 6, 8),
    record(10, "stream_partial", { kind: "assistant_text", blockId: "p4", text: "unfinished" }),
    record(11, "transcript_item", { kind: "user", sequence: 0, text: "live request" }),
    record(12, "transcript_item", { kind: "tool_call", sequence: 1, toolCallId: "call", name: "read_file", arguments: { path: "public.txt" } }),
    record(13, "transcript_item", { kind: "tool_result", sequence: 2, toolCallId: "call", name: "read_file", output: "live evidence", truncated: false, outcome: "succeeded" }),
    record(14, "envelope", { type: "provider_checkpoint", opaque: { formatVersion: "1", sourceSequence: 13, native: { encrypted: "opaque fixture" } } }),
  ];
}

function fork(records: readonly SessionRecord[], snapshot: ForkSnapshotRequest = { mode: "settled-prefix" }): SessionRecord[] {
  const planned = planFork({ records, tornTail: false, snapshot, parentSessionId: "parent", childSessionId: "child", at: "2026-11-08T01:00:00.000Z" });
  if (!planned.ok) throw new Error(planned.code);
  const first = records[0];
  assert.ok(first);
  return [{ ...first, sessionId: "child" }, ...planned.records.map((item, index) => ({ ...item, formatVersion: "1", sequence: index + 1 }))];
}

function publicView(records: readonly SessionRecord[]): unknown {
  const projection = projectForPrompt({ records });
  if (!projection.ok) throw new Error(projection.code);
  return { summary: projection.view.window?.summary, items: projection.view.items.filter(item => item.kind !== "assistant_reasoning") };
}

test("settled fork retains the same effective public history after dropping stream partials", () => {
  const parent = journal();
  const before = JSON.stringify(parent);
  const child = fork(parent);

  assert.deepEqual(publicView(child), publicView(parent));
  assert.equal(JSON.stringify(parent), before, "planning never mutates the parent");
  assert.deepEqual(child.filter(item => item.type === "compact").map(item => item.payload), [
    { ...parent[5]?.payload, replacedFromSequence: 1, replacedToSequence: 2 },
    { ...parent[9]?.payload, replacedFromSequence: 4, replacedToSequence: 5 },
  ]);

  for (const window of child.filter(item => item.type === "compact")) {
    assert.deepEqual(Object.keys(window.payload).sort(), [...COMPACT_WINDOW_KEYS].sort());
  }
});

test("before-user-message remaps the compacted prefix without leaking the later turn", () => {
  const parent = journal();
  const child = fork(parent, { mode: "before-user-message", n: 3 });
  assert.deepEqual(publicView(child), publicView(parent.slice(0, 11)));
  assert.deepEqual(child.filter(item => item.type === "compact").map(item => item.payload.replacedToSequence), [2, 5]);
});

test("format 1 journals without dropped records keep compact and opaque native payloads unchanged", () => {
  const parent = journal().filter(item => item.type !== "stream_partial").map((item, sequence) => ({ ...item, sequence }));
  const windows = parent.filter(item => item.type === "compact");
  const first = windows[0];
  const second = windows[1];

  assert.ok(first && second);
  const compatible = parent.map(item => item === first
    ? { ...item, payload: { ...item.payload, replacedFromSequence: 1, replacedToSequence: 2 } }
    : item === second ? { ...item, payload: { ...item.payload, replacedFromSequence: 4, replacedToSequence: 5 } } : item);
  const child = fork(compatible);

  assert.deepEqual(child.map(item => item.payload), compatible.map(item => item.payload));
  assert.deepEqual(publicView(child), publicView(compatible));
  assert.equal(recover(child, false).ok, true);
});

test("rebasing the journal does not reinterpret opaque provider checkpoint payloads", () => {
  const parent = journal();
  const child = fork(parent);
  assert.deepEqual(child.find(item => item.type === "envelope")?.payload, parent[14]?.payload);
  assert.deepEqual(child.filter(item => item.type === "transcript_item").map(item => item.payload), parent.filter(item => item.type === "transcript_item").map(item => item.payload));
});

test("an unknown compact format is refused before a child can claim a valid projection", () => {
  const parent = journal().map(item => item.type === "compact" ? { ...item, payload: { ...item.payload, formatVersion: "future" } } : item);
  const planned = planFork({ records: parent, tornTail: false, snapshot: { mode: "settled-prefix" }, parentSessionId: "parent", childSessionId: "child", at: "2026-11-08T01:00:00.000Z" });
  assert.equal(planned.ok, false);
  if (!planned.ok) assert.equal(planned.code, "parent_unreadable");
});
