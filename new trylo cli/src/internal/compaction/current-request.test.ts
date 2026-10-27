import assert from "node:assert/strict";
import { test } from "node:test";
import { summarizeTranscript, validateSummary } from "./summary.js";
import type { TranscriptItem } from "../protocol/transcript.js";
import { createModelSummarizer } from "../surface/cli/compact-model-summarizer.js";
import { createCompactionLedger } from "../loop/compact-ledger.js";
import { promptViewMessages } from "../loop/prompt-view.js";

function transcript(): TranscriptItem[] {
  const items: TranscriptItem[] = [{ kind: "user", sequence: 0, text: "Old request already finished: OLD_CASE." }];
  for (let i = 1; i <= 200; i++) items.push({ kind: "assistant_text", sequence: i, blockId: "old-" + i, text: "Historical verified observation ".repeat(20) });
  items.push({ kind: "user", sequence: 201, text: "Fresh request FRESH_CASE: start the unique interactive process only once." },
    { kind: "tool_call", sequence: 202, toolCallId: "start", name: "run_shell", arguments: { command: "node fresh.mjs", runInBackground: true } },
    { kind: "tool_result", sequence: 203, toolCallId: "start", name: "run_shell", output: "Started in the background as session ps_fresh123.", truncated: false, outcome: "succeeded" },
    { kind: "assistant_text", sequence: 204, blockId: "fresh", text: "Send the first input to the process just started." },
    { kind: "assistant_reasoning", sequence: 205, blockId: "private", text: "PRIVATE-REASONING", redacted: false },
    { kind: "tool_call", sequence: 206, toolCallId: "hello", name: "write_stdin", arguments: { sessionId: "ps_fresh123", chars: "hello\n" } },
    { kind: "tool_result", sequence: 207, toolCallId: "hello", name: "write_stdin", output: "Session ps_fresh123 is running. challenge1:FRESH_CHALLENGE", truncated: false, outcome: "succeeded" });
  return items;
}

test("a lossy rolling digest pins current request identity, process origin and latest tool state together", () => {
  const summary = summarizeTranscript(transcript());
  const pinned = summary.slice(summary.indexOf("[request observations"));
  assert.ok(summary.includes("[request observations"));
  assert.ok(pinned.includes("FRESH_CASE")); assert.ok(pinned.includes("Started in the background as session ps_fresh123"));
  assert.ok(pinned.includes("FRESH_CHALLENGE")); assert.equal(pinned.includes("OLD_CASE"), false);
  assert.equal(pinned.includes("PRIVATE-REASONING"), false);
  assert.ok(summary.length <= 4000); assert.equal(validateSummary(summary).ok, true);
});

test("an accepted model-authored summary cannot omit the deterministic current-request observations", async () => {
  const summarize = createModelSummarizer({ model: "fixture", provider: { async *stream() {
    yield { type: "text_delta", blockId: "s", text: "Earlier observations were verified." };
    yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
  } } });
  const summary = await summarize(transcript());
  assert.ok(summary.includes("Earlier observations were verified."));
  assert.ok(summary.includes("[request observations")); assert.ok(summary.includes("FRESH_CASE"));
  assert.ok(summary.includes("ps_fresh123")); assert.ok(summary.includes("FRESH_CHALLENGE"));
});

test("the provider view explains a compaction inside this request without inventing a new user turn", () => {
  const items = transcript(), ledger = createCompactionLedger();
  ledger.replacedPrefix = items.length;
  ledger.window = { windowId: "w1", replacedFromSequence: 0, replacedToSequence: 207, summary: "Historical context.", formatVersion: "1" };
  const messages = promptViewMessages({ seedMessages: [], transcript: items, ledger });
  assert.ok(messages.some(message => message.role === "system" && message.content.includes("during the latest user request")));
  assert.equal(messages.filter(message => message.role === "assistant").flatMap(message => message.toolCalls ?? []).filter(call => call.toolCallId === "hello").length, 1);
});

test("a later live user input is not labeled as the request covered by an older window", () => {
  const items = transcript(), ledger = createCompactionLedger();
  ledger.replacedPrefix = items.length;
  ledger.window = { windowId: "w1", replacedFromSequence: 0, replacedToSequence: 207, summary: "Historical context.", formatVersion: "1" };
  items.push({ kind: "user", sequence: 208, text: "A different current request." });
  const messages = promptViewMessages({ seedMessages: [], transcript: items, ledger });
  assert.equal(messages.some(message => message.role === "system" && message.content.includes("during the latest user request")), false);
});
