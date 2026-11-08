import assert from "node:assert/strict";
import { test } from "node:test";
import { createCompactionLedger, journalView } from "../loop/compact-ledger.js";
import { currentPromptBasis, runCompactionFor } from "../loop/compaction-gap.js";
import { promptViewMessages } from "../loop/prompt-view.js";
import { promptContextFor, type CompactionInput } from "../loop/compact-boundary.js";
import type { TranscriptItem } from "../protocol/transcript.js";
import { compactionWiring } from "../surface/cli/compaction-wiring.js";

const MIDDLE_FACT = "CURRENT_RELEASE_IS_R73919";
const LONG_OUTPUT = "ordinary record\n".repeat(1_000) + MIDDLE_FACT + "\n" + "ordinary record\n".repeat(1_000);

function appendRead(items: TranscriptItem[], id: string, output: string): void {
  items.push({ kind: "tool_call", sequence: items.length, toolCallId: id, name: "read_file", arguments: { path: `${id}.txt` } });
  items.push({ kind: "tool_result", sequence: items.length, toolCallId: id, name: "read_file", output,
    outcome: "succeeded", truncated: false });
}

function inputFor(items: TranscriptItem[], contextTokenLimit: number): CompactionInput {
  return { transcript: items, seedMessages: [], ledger: createCompactionLedger(), sessionId: "retention-contract",
    contextTokenLimit, tools: undefined, reported: undefined, wiring: compactionWiring({ nowMs: 0 }) };
}

function requestMessages(input: CompactionInput) {
  return promptViewMessages(promptContextFor({ seedMessages: input.seedMessages, transcript: input.transcript,
    compaction: input.ledger, state: { sessionId: "retention-contract" }, budget: { contextTokenLimit: input.contextTokenLimit! } },
  input.wiring, input.tools));
}

test("a consumed large tool result remains complete while the context budget has room", async () => {
  const items: TranscriptItem[] = [{ kind: "user", sequence: 0, text: "Read both records and retain the current release." }];

  appendRead(items, "large-record", LONG_OUTPUT);
  items.push({ kind: "assistant_text", sequence: items.length, blockId: "checked", text: "The first record was read; inspect the second." });
  appendRead(items, "small-record", "SECOND_RECORD_CHECKED");
  const input = inputFor(items, 1_048_576);
  const compacted = await runCompactionFor(input);

  assert.equal(compacted.storedWindow, false);
  assert.ok((currentPromptBasis(input) ?? Number.POSITIVE_INFINITY) < input.contextTokenLimit!);

  const projected = input.wiring!.port.projectForPrompt({ records: journalView(input.sessionId!, items, []) });

  assert.ok(projected.ok);
  const retained = projected.view.items.find(item => item.kind === "tool_result" && item.toolCallId === "large-record");

  assert.ok(retained?.kind === "tool_result");
  assert.ok(retained.output.includes(MIDDLE_FACT), "an ample window must preserve the previously consumed middle fact");
  assert.ok(retained.output === LONG_OUTPUT, "an ample window must retain the whole previously consumed result");
  assert.equal(retained.truncated, false);

  const request = requestMessages(input);

  assert.ok(request.find(message => message.role === "tool" && message.toolCallId === "large-record")?.content === LONG_OUTPUT,
    "the sender and the journal projection must preserve the same middle fact");
});

test("context pressure preserves a complete recent large result beside its paired call", async () => {
  const items: TranscriptItem[] = [{ kind: "user", sequence: 0, text: "Audit the records and preserve recent verified release facts." }];

  for (let index = 0; index < 10; index++) appendRead(items, `old-${index}`, "old observation ".repeat(1_100));

  appendRead(items, "recent-large", LONG_OUTPUT);
  items.push({ kind: "assistant_text", sequence: items.length, blockId: "consume-large", text: "The recent record is complete; finish the last check." });
  appendRead(items, "latest", "LATEST_CHECK_COMPLETE");
  const input = inputFor(items, 40_000);
  const compacted = await runCompactionFor(input);

  assert.equal(compacted.storedWindow, true);
  assert.ok(input.ledger.replacedPrefix < items.length - 2, "recent completed exchanges remain outside the summarized prefix");
  const request = requestMessages(input);
  const calls = request.flatMap(message => message.toolCalls ?? []).filter(call => call.toolCallId === "recent-large");
  const results = request.filter(message => message.role === "tool" && message.toolCallId === "recent-large");

  assert.equal(calls.length, 1);
  assert.equal(results.length, 1);
  assert.ok(results[0]?.content.includes(MIDDLE_FACT), "the retained exchange keeps its middle fact under pressure");
  assert.ok(results[0]?.content === LONG_OUTPUT, "pressure uses whole-exchange retention rather than a head/tail stub");
  assert.ok((currentPromptBasis(input) ?? Number.POSITIVE_INFINITY) < input.contextTokenLimit!);
});
