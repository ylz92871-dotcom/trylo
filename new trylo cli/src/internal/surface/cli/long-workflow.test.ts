import assert from "node:assert/strict";
import { test } from "node:test";
import { compactionWiring } from "./compaction-wiring.js";
import { runCompactionFor, promptMessages, type CompactionInput } from "../../loop/compact-boundary.js";
import { adoptResumedWindow, createCompactionLedger, journalView } from "../../loop/compact-ledger.js";
import type { TranscriptItem } from "../../protocol/transcript.js";

function scenario() {
  const transcript: TranscriptItem[] = [{ kind: "user", sequence: 0, text: "Keep the public API compatible. Verify the migration before finishing." }];
  const ledger = createCompactionLedger();
  const input: CompactionInput = {
    transcript, ledger, seedMessages: [], sessionId: "s", contextTokenLimit: 200,
    wiring: compactionWiring({ nowMs: 0, summarize: () => "The task is still in progress." }),
    tools: undefined, reported: undefined,
  };

  return { input, transcript, ledger };
}

test("a short first gap must not disable compaction when the same task later grows", async () => {
  const { input, transcript } = scenario();
  assert.equal((await runCompactionFor(input)).storedWindow, false);
  transcript.push({ kind: "assistant_text", sequence: 1, blockId: "b1", text: "inspection detail ".repeat(100) });
  assert.equal((await runCompactionFor(input)).storedWindow, true);
});

test("one long task can compact repeatedly after each successful reduction", async () => {
  const { input, transcript, ledger } = scenario();

  for (let round = 1; round <= 5; round += 1) {
    transcript.push({ kind: "assistant_text", sequence: round, blockId: `b${round}`, text: "new investigation facts ".repeat(100) });
    const outcome = await runCompactionFor(input);
    assert.equal(outcome.storedWindow, true, `window ${round} must be stored`);
    assert.ok(outcome.projectedPromptTokens! < input.contextTokenLimit!);
  }

  assert.equal(ledger.entries.length, 5);
});

test("successive compaction and resume retain the original requirements", async () => {
  const { input, transcript, ledger } = scenario();
  const real = { ...input, wiring: compactionWiring({ nowMs: 0 }) };

  await runCompactionFor(real, { force: true });

  for (let round = 1; round <= 3; round += 1) {
    transcript.push({ kind: "user", sequence: round, text: `Continue migration stage ${round}.` });
    assert.equal((await runCompactionFor(real, { force: true })).storedWindow, true);
    assert.match(ledger.window!.summary, /Keep the public API compatible/);
    assert.match(ledger.window!.summary, /Verify the migration/);
    assert.match(ledger.window!.summary, new RegExp(`stage ${round}`));
  }

  const records = journalView("s", transcript, ledger.entries);
  const resumed = createCompactionLedger();

  adoptResumedWindow(resumed, ledger.window, records, transcript);
  transcript.push({ kind: "user", sequence: 4, text: "Now verify the restored session." });
  const resumedInput = { ...real, ledger: resumed };

  await runCompactionFor(resumedInput, { force: true });
  const prompt = promptMessages(resumedInput).map(message => message.content).join("\n");

  assert.match(prompt, /Keep the public API compatible/);
  assert.match(prompt, /verify the restored session/);
});
