import assert from "node:assert/strict";
import { test } from "node:test";
import type { TranscriptItem } from "../protocol/transcript.js";
import { createCompactionLedger } from "../loop/compact-ledger.js";
import { runCompactionFor } from "../loop/compaction-gap.js";
import { promptViewMessages } from "../loop/prompt-view.js";
import { compactionWiring } from "../surface/cli/compaction-wiring.js";
import { createModelSummarizer } from "../surface/cli/compact-model-summarizer.js";
import { validateSummary } from "./summary.js";
import { childCompaction } from "../subagent/context-budget.js";

for (const mode of ["extractive", "model", "model-fallback", "child"] as const) {
 for (const [preparationReads, priorRequest] of [[0, true], [20, true], [20, false]] as const) {
  test(`${mode} preserves current process origin after ${preparationReads} preparation reads (prior request: ${priorRequest}) through three automatic windows`, async () => {
    const items: TranscriptItem[] = [];
    if (priorRequest) {
      items.push({ kind: "user", sequence: 0, text: "Earlier completed request." });
      for (let i = 1; i <= 200; i++) items.push({ kind: "assistant_text", sequence: i, blockId: "old-" + i, text: "Historical observation ".repeat(40) });
    }
    items.push({ kind: "user", sequence: items.length, text: "CURRENT_CASE: start the interactive process only once." });
    for (let i = 0; i < preparationReads; i++) {
      const sequence = items.length;
      items.push({ kind: "tool_call", sequence, toolCallId: "read-" + i, name: "read_file", arguments: { path: "source-" + i + ".mjs" } },
        { kind: "tool_result", sequence: sequence + 1, toolCallId: "read-" + i, name: "read_file", output: "Verified source detail ".repeat(40), outcome: "succeeded", truncated: false });
    }
    const startSequence = items.length;
    items.push({ kind: "tool_call", sequence: startSequence, toolCallId: "start", name: "run_shell", arguments: { command: "node interactive.mjs", runInBackground: true } },
      { kind: "tool_result", sequence: startSequence + 1, toolCallId: "start", name: "run_shell", output: "Started in the background as session ps_current123.", outcome: "succeeded", truncated: false });
    const summarize = createModelSummarizer({ model: "local-fixture", provider: { async *stream() {
      if (mode === "model-fallback") { yield { type: "error", class: "server", retryable: false, phase: "before_headers", message: "fixture failure" }; return; }
      yield { type: "text_delta", blockId: "summary", text: "Earlier observations were verified." };
      yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
    } } });
    const ledger = createCompactionLedger();
    const context = { wiring: mode === "child" ? childCompaction({ async *stream() {} }) : compactionWiring({ nowMs: 0, ...(mode === "extractive" ? {} : { summarize }) }),
      ledger, sessionId: "rolling-request", contextTokenLimit: 10000, transcript: items, seedMessages: [], tools: undefined, reported: undefined };
    for (let window = 1; window <= 3; window++) {
      if (window > 1 || preparationReads > 0) for (let i = 0; i < 120; i++) {
        const sequence = items.length;
        items.push({ kind: "tool_call", sequence, toolCallId: `poll-${window}-${i}`, name: "write_stdin", arguments: { sessionId: "ps_current123" } },
          { kind: "tool_result", sequence: sequence + 1, toolCallId: `poll-${window}-${i}`, name: "write_stdin",
            output: `Session ps_current123 is running. CHECKPOINT_${window}_${i} ` + "Progress detail ".repeat(30), outcome: "succeeded", truncated: false });
      }
      const compacted = await runCompactionFor(context);
      assert.equal(compacted.storedWindow, true);
      assert.equal(ledger.window?.windowId, "w" + window);
      const summary = ledger.window?.summary ?? "";
      const view = JSON.stringify(promptViewMessages(context));
      assert.ok(view.includes("Started in the background as session ps_current123"), `window ${window} lost the current process origin`);
      assert.ok(view.includes("CURRENT_CASE"));
      assert.equal(validateSummary(summary).ok, true);
      if (window > 1) assert.ok(summary.includes(`CHECKPOINT_${window}_119`), "the origin must not crowd out the latest state");
    }
    const sequence = items.length;
    items.push({ kind: "user", sequence, text: "NEXT_CASE: a new request." },
      { kind: "tool_call", sequence: sequence + 1, toolCallId: "next-start", name: "run_shell", arguments: { command: "node next.mjs" } },
      { kind: "tool_result", sequence: sequence + 2, toolCallId: "next-start", name: "run_shell", output: "Started in the background as session ps_next456.", outcome: "succeeded", truncated: false });
    for (let i = 0; i < 100; i++) items.push({ kind: "assistant_text", sequence: items.length, blockId: "next-" + i, text: "New request detail ".repeat(40) });
    assert.equal((await runCompactionFor(context)).storedWindow, true);
    const summary = ledger.window?.summary ?? "";
    const pinned = summary.slice(summary.lastIndexOf("[request observations"));
    assert.ok(pinned.includes("NEXT_CASE")); assert.ok(pinned.includes("ps_next456"));
    assert.equal(pinned.includes("CURRENT_CASE"), false);
    assert.equal(pinned.includes("ps_current123"), false);
  });
 }
}
