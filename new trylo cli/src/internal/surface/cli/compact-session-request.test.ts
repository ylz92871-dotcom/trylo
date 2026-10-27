import assert from "node:assert/strict";
import { test } from "node:test";
import type { JsonObject } from "../../protocol/envelope.js";
import type { SessionRecord } from "../../ports/session.js";
import { compactionWiring } from "./compaction-wiring.js";
import { createModelSummarizer } from "./compact-model-summarizer.js";
import { compactSession } from "./compact-session.js";

for (const mode of ["extractive", "model"] as const) test(`manual ${mode} compaction preserves current request origin after an earlier window`, async () => {
  const records: SessionRecord[] = [];
  const append = (payload: JsonObject): void => { records.push({ formatVersion: "1", sequence: records.length,
    type: "transcript_item", sessionId: "manual-current", at: "2026-10-25T00:00:00Z", payload: { ...payload, sequence: records.length } }); };
  append({ kind: "user", text: "An earlier completed request." });
  for (let i = 0; i < 200; i++) append({ kind: "assistant_text", blockId: "old-" + i, text: "Historical observation ".repeat(40) });
  append({ kind: "user", text: "MANUAL_CURRENT_CASE: start the process once." });
  append({ kind: "tool_call", toolCallId: "start", name: "run_shell", arguments: { command: "node interactive.mjs" } });
  append({ kind: "tool_result", toolCallId: "start", name: "run_shell", output: "Started in the background as session ps_manual123.", truncated: false, outcome: "succeeded" });
  const summarize = createModelSummarizer({ model: "fixture", provider: { async *stream() {
    yield { type: "text_delta", blockId: "summary", text: "Earlier observations were verified." };
    yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
  } } });
  const wiring = compactionWiring({ nowMs: 0, ...(mode === "model" ? { summarize } : {}) });
  const first = await compactSession({ now: () => 0 }, "manual-current", records, undefined, { wiring });
  assert.equal(first.ok, true); if (!first.ok) return;
  records.push({ formatVersion: "1", sequence: records.length, type: "compact", sessionId: "manual-current", at: "2026-10-25T00:00:00Z", payload: { ...first.window } });
  for (let i = 0; i < 120; i++) {
    append({ kind: "tool_call", toolCallId: "poll-" + i, name: "write_stdin", arguments: { sessionId: "ps_manual123" } });
    append({ kind: "tool_result", toolCallId: "poll-" + i, name: "write_stdin", output: `Session ps_manual123 running. MANUAL_CHECKPOINT_${i} ` + "Progress ".repeat(30), truncated: false, outcome: "succeeded" });
  }
  const second = await compactSession({ now: () => 0 }, "manual-current", records, undefined, { wiring });
  assert.equal(second.ok, true); if (!second.ok) return;
  assert.ok(second.window.summary.includes("Started in the background as session ps_manual123"));
  assert.ok(second.window.summary.includes("MANUAL_CURRENT_CASE"));
  assert.ok(second.window.summary.includes("MANUAL_CHECKPOINT_119"));
});
