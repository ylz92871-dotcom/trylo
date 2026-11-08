import assert from "node:assert/strict";
import { test } from "node:test";
import { createCompactionService } from "../compaction/service.js";
import { estimateMessagesTokens } from "../compaction/token-estimate.js";
import type { CompactionInput } from "./compact-boundary.js";
import { runCompactionFor } from "./compaction-gap.js";
import { createCompactionLedger, journalView, adoptResumedWindow } from "./compact-ledger.js";
import { promptViewMessages } from "./prompt-view.js";
import type { TranscriptItem } from "../protocol/transcript.js";

function appendExchange(items: TranscriptItem[], id: string, output: string): void {
  items.push({ kind: "assistant_text", sequence: items.length, blockId: `text-${id}`, text: `Inspect ${id}.` });
  items.push({ kind: "tool_call", sequence: items.length, toolCallId: id, name: "read_file", arguments: { path: `${id}.txt` } });
  items.push({ kind: "tool_result", sequence: items.length, toolCallId: id, name: "read_file", output,
    truncated: false, outcome: "succeeded" });
}

function inputFor(items: TranscriptItem[]): CompactionInput {
  return {
    seedMessages: [], transcript: items, ledger: createCompactionLedger(), sessionId: "retention", tools: undefined,
    contextTokenLimit: 40_000, reported: undefined,
    wiring: { port: createCompactionService(), estimatePromptTokens: estimateMessagesTokens,
      summarize: () => "Older operations were inspected.", now: () => "2026-11-07T00:00:00.000Z" },
  };
}

function longTask(): TranscriptItem[] {
  const items: TranscriptItem[] = [{ kind: "user", sequence: 0, text: "Repair the current layout and preserve the public interface." }];
  for (let index = 0; index < 10; index++) appendExchange(items, `old-${index}`, `OLD-RESULT-${index}:` + "x".repeat(17_900));
  appendExchange(items, "current-repair", "CURRENT-REPAIR-FACT: controls hidden while idle; current verification succeeded.\n" + "r".repeat(4_900));
  for (let index = 0; index < 3; index++) appendExchange(items, `recent-${index}`, `RECENT-OBSERVATION-${index}:` + "n".repeat(1_900));
  return items;
}

test("automatic compaction retains recent completed exchanges before the newest tool batch", async () => {
  const input = inputFor(longTask());
  const result = await runCompactionFor(input);

  assert.equal(result.storedWindow, true);
  const messages = promptViewMessages(input);
  const visible = messages.map(message => message.content).join("\n");

  assert.match(visible, /CURRENT-REPAIR-FACT/);
  assert.match(visible, /RECENT-OBSERVATION-0/);
  assert.doesNotMatch(visible, /OLD-RESULT-0/);
  assert.ok(input.ledger.replacedPrefix < input.transcript.length - 3, "more than the newest exchange remains verbatim");
  const calls = messages.flatMap(message => message.toolCalls ?? []).map(call => call.toolCallId);
  const results = messages.filter(message => message.role === "tool").map(message => message.toolCallId);

  assert.deepEqual(calls, results, "the retained suffix never separates a call from its result");
});

test("a partial window remains partial after journal projection and resume", async () => {
  const input = inputFor(longTask());

  assert.equal((await runCompactionFor(input)).storedWindow, true);
  const records = journalView("retention", input.transcript, input.ledger.entries);
  const projected = input.wiring!.port.projectForPrompt({ records });

  assert.equal(projected.ok, true);

  if (!projected.ok) return;

  assert.ok(projected.view.items.some(item => item.kind === "tool_result" && item.output.includes("CURRENT-REPAIR-FACT")));
  const resumed = createCompactionLedger();

  adoptResumedWindow(resumed, projected.view.window, records, input.transcript);
  assert.equal(resumed.replacedPrefix, input.ledger.replacedPrefix);
  assert.deepEqual(promptViewMessages({ ...input, ledger: resumed }), promptViewMessages(input));
});

test("later partial compactions advance prior windows even when their records follow retained items", async () => {
  const input = inputFor(longTask());

  assert.equal((await runCompactionFor(input)).storedWindow, true);
  const firstCut = input.ledger.replacedPrefix;

  assert.ok(firstCut < input.transcript.length - 3);

  for (let index = 0; index < 10; index++) appendExchange(input.transcript as TranscriptItem[], `later-${index}`, "l".repeat(17_900));

  input.ledger.attempted = false;
  const result = await runCompactionFor(input);

  assert.equal(result.storedWindow, true);
  assert.equal(input.ledger.entries.length, 2);
  assert.ok(input.ledger.replacedPrefix > firstCut);
  assert.ok(input.ledger.entries[1]!.draft.payload.replacedFromSequence > input.ledger.entries[0]!.draft.payload.replacedToSequence);
  assert.equal(input.ledger.entries[1]!.draft.payload.windowId, "w2");
  assert.equal(input.wiring!.port.projectForPrompt({ records: journalView("retention", input.transcript, input.ledger.entries) }).ok, true);
});

test("retained parallel exchanges keep both calls when results settle in reverse order", async () => {
  const items = longTask();
  const start = items.length;

  items.push(
    { kind: "tool_call", sequence: start, toolCallId: "parallel-a", name: "read_file", arguments: { path: "a.txt" } },
    { kind: "tool_call", sequence: start + 1, toolCallId: "parallel-b", name: "read_file", arguments: { path: "b.txt" } },
    { kind: "tool_result", sequence: start + 2, toolCallId: "parallel-b", name: "read_file", output: "PARALLEL-B", outcome: "succeeded", truncated: false },
    { kind: "tool_result", sequence: start + 3, toolCallId: "parallel-a", name: "read_file", output: "PARALLEL-A", outcome: "succeeded", truncated: false },
  );
  appendExchange(items, "after-parallel", "Latest complete result.");
  const input = inputFor(items);

  assert.equal((await runCompactionFor(input)).storedWindow, true);
  const messages = promptViewMessages(input);

  assert.equal(messages.filter(message => message.role === "tool" && message.content.startsWith("PARALLEL-")).length, 2);
  const parallel = messages.find(message => message.toolCalls?.some(call => call.toolCallId === "parallel-a"));

  assert.deepEqual(parallel?.toolCalls?.map(call => call.toolCallId), ["parallel-a", "parallel-b"]);
});

test("partial retention uses canonical ordinals with gaps and preserves repeated call occurrences", async () => {
  const items = longTask();

  appendExchange(items, "reused", "FIRST-REUSED-RESULT");
  appendExchange(items, "reused", "SECOND-REUSED-RESULT");
  const input = inputFor(items.map((item, index) => ({ ...item, sequence: index * 3 + 7 })));

  assert.equal((await runCompactionFor(input)).storedWindow, true);
  const records = journalView("retention", input.transcript, input.ledger.entries);
  const projected = input.wiring!.port.projectForPrompt({ records });

  assert.ok(projected.ok);
  const resumed = createCompactionLedger();

  adoptResumedWindow(resumed, projected.view.window, records, input.transcript);
  const visible = promptViewMessages({ ...input, ledger: resumed });

  assert.equal(visible.flatMap(message => message.toolCalls ?? []).filter(call => call.toolCallId === "reused").length, 2);
  assert.equal(visible.filter(message => message.role === "tool" && message.toolCallId === "reused").length, 2);
  assert.deepEqual(visible, promptViewMessages(input));
});

test("forcing an empty view reports nothing to compact instead of throwing", async () => {
  const result = await runCompactionFor(inputFor([]), { force: true });
  assert.equal(result.storedWindow, false);
  assert.equal(result.events[0]?.payload["reason"], "nothing_to_compact");
});

test("a malformed explicit prefix boundary cannot silently replace all history", () => {
  const port = createCompactionService();
  const records = journalView("retention", longTask(), []);

  for (const replacedToSequence of [Number.NaN, -1, 1.5]) {
    const result = port.compact({ records, sessionId: "retention", at: "2026-11-07T00:00:00.000Z",
      summary: "Observed older operations.", replacedToSequence });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "compact_window_not_monotonic");
  }
});
