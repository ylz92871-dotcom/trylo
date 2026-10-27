import assert from "node:assert/strict";
import { test } from "node:test";
import type { TranscriptItem } from "../protocol/transcript.js";
import { summarizeTranscript, validateSummary } from "./summary.js";

function request(): TranscriptItem[] {
  const items: TranscriptItem[] = [{ kind: "user", sequence: 0, text: "CURRENT_CASE: inspect sources, start processes, keep their identity." }];
  for (let i = 0; i < 20; i++) {
    items.push({ kind: "tool_call", sequence: items.length, toolCallId: "read-" + i, name: "read_file", arguments: { path: "source-" + i } });
    items.push({ kind: "tool_result", sequence: items.length, toolCallId: "read-" + i, name: "read_file", output: "Source details ".repeat(40), outcome: "succeeded", truncated: false });
  }
  return items;
}

function start(items: TranscriptItem[], id: string, background: boolean, output: string, outcome: "succeeded" | "failed" = "succeeded"): void {
  items.push({ kind: "tool_call", sequence: items.length, toolCallId: id, name: "run_shell", arguments: { command: "PRIVATE_COMMAND", env: { PRIVATE_ENV: "never copy input" }, runInBackground: background } });
  items.push({ kind: "tool_result", sequence: items.length, toolCallId: id, name: "run_shell", output, outcome, truncated: false });
}

function progress(items: TranscriptItem[]): void {
  for (let i = 0; i < 120; i++) {
    items.push({ kind: "tool_call", sequence: items.length, toolCallId: "poll-" + i, name: "write_stdin", arguments: { sessionId: "ps_current" } });
    items.push({ kind: "tool_result", sequence: items.length, toolCallId: "poll-" + i, name: "write_stdin", output: "LATEST_STATE_" + i + " Progress detail ".repeat(30), outcome: "succeeded", truncated: false });
  }
}

test("the first request preserves multiple middle process origins without copying command or env inputs", () => {
  const items = request();
  start(items, "a", true, "Started in the background as session ps_one.");
  start(items, "b", true, "Started in the background as session ps_two.");
  progress(items);
  const summary = summarizeTranscript(items);
  assert.ok(summary.includes("ps_one")); assert.ok(summary.includes("ps_two"));
  assert.ok(summary.includes("LATEST_STATE_119")); assert.ok(summary.includes("CURRENT_CASE"));
  assert.equal(summary.includes("PRIVATE_COMMAND"), false); assert.equal(summary.includes("PRIVATE_ENV"), false);
  assert.equal(validateSummary(summary).ok, true);
});

test("repeated tool ids preserve only the matching successful background occurrence as a process origin", () => {
  const items = request();
  start(items, "same", false, "FOREGROUND_ONLY");
  start(items, "same", true, "Started in the background as session ps_actual.");
  start(items, "same", true, "FAILED_START", "failed");
  items.push({ kind: "tool_call", sequence: items.length, toolCallId: "same", name: "run_shell", arguments: { runInBackground: false } });
  progress(items);
  const summary = summarizeTranscript(items, { previousSummary: "Earlier context." });
  const origins = summary.split("[background process starts in this request]\n")[1]?.split("\nuser:")[0] ?? "";
  assert.ok(origins.includes("ps_actual"));
  assert.equal(origins.includes("FOREGROUND_ONLY"), false); assert.equal(origins.includes("FAILED_START"), false);
});

test("many process origins remain bounded with explicit elision and the newest state", () => {
  const items = request();
  for (let i = 0; i < 40; i++) start(items, "start-" + i, true, "Started in the background as session ps_" + i + ". " + "Start detail ".repeat(10));
  progress(items);
  const summary = summarizeTranscript(items);
  assert.ok(summary.includes("[elided ")); assert.ok(summary.includes("ps_39"));
  assert.ok(summary.includes("LATEST_STATE_119")); assert.ok(summary.length <= 4000);
  assert.equal(validateSummary(summary).ok, true);
});

test("small custom summary budgets and disclosure scrubbing still bound process observations", () => {
  const items = request();
  start(items, "start", true, "Started in the background as session ps_safe. token=credential-value /private/source");
  progress(items);
  for (const maxChars of [80, 300, 1000, 4000]) {
    const summary = summarizeTranscript(items, { maxChars, previousSummary: "Earlier context." });
    assert.ok(summary.length <= maxChars); assert.equal(validateSummary(summary).ok, true);
    assert.equal(summary.includes("credential-value"), false);
  }
});
