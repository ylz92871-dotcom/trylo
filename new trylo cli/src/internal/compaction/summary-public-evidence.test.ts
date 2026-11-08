import assert from "node:assert/strict";
import { test } from "node:test";
import type { TranscriptItem } from "../protocol/transcript.js";
import { publicSummaryHistory, summarizeTranscript, transcriptLines } from "./summary.js";
import { createModelSummarizer } from "../surface/cli/compact-model-summarizer.js";

function observation(sequence: number, id: string, output: string): TranscriptItem[] {
  return [
    { kind: "tool_call", sequence, toolCallId: id, name: "read_file", arguments: { path: id + ".txt" } },
    { kind: "tool_result", sequence: sequence + 1, toolCallId: id, name: "read_file", output, outcome: "succeeded", truncated: false },
  ];
}

test("extractive and model-summary material omit private reasoning instead of laundering it into history", () => {
  const items: TranscriptItem[] = [
    { kind: "user", sequence: 0, text: "Keep the public interface compatible." },
    { kind: "assistant_reasoning", sequence: 1, blockId: "private", text: "PRIVATE_REASONING_ONLY", redacted: false },
    { kind: "assistant_reasoning", sequence: 2, blockId: "redacted", text: "", redacted: true },
    ...observation(3, "read-a", "Observed result A."),
  ];
  for (const text of [summarizeTranscript(items), transcriptLines(items).join("\n")]) {
    assert.doesNotMatch(text, /PRIVATE_REASONING_ONLY|assistant_reasoning|\[redacted\]/);
    assert.match(text, /Observed result A/);
  }
});

test("a legacy generated summary loses only its tagged reasoning before either author sees it", async () => {
  const ordinaryHistory = "Preserve the API.\r\nThe user mentioned assistant_reasoning as a field name.";

  assert.equal(publicSummaryHistory(ordinaryHistory), ordinaryHistory, "free-form historical facts are not semantically rewritten");
  const previousSummary = "user: Preserve the API.\nassistant_reasoning: LEGACY_PRIVATE_ONLY\ntool_result read_file old succeeded: Observed old fact.";
  const items = observation(5, "new", "Observed new fact.");
  const extractive = summarizeTranscript(items, { previousSummary });

  assert.doesNotMatch(extractive, /LEGACY_PRIVATE_ONLY|assistant_reasoning/);
  assert.match(extractive, /Observed old fact/);
  let material = "";
  const summarize = createModelSummarizer({ model: "local-fixture", provider: { async *stream(request) {
    material = request.messages.map(message => message.content).join("\n");
    yield { type: "text_delta", blockId: "summary", text: "Observed old and new facts." };
    yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
  } } });

  await summarize(items, previousSummary);
  assert.doesNotMatch(material, /LEGACY_PRIVATE_ONLY|assistant_reasoning/);
  assert.match(material, /Observed old fact/);
});

test("rolling summaries replace their current-request section without nesting generated headings", () => {
  const all: TranscriptItem[] = [{ kind: "user", sequence: 0, text: "CURRENT_REQUEST: preserve the public API." }];
  let previousSummary: string | undefined;

  for (let window = 1; window <= 6; window++) {
    const exchange = observation(all.length, "read-" + window, "OBSERVED_STAGE_" + window);

    all.push(...exchange);
    previousSummary = summarizeTranscript(window === 1 ? all : exchange, {
      ...(previousSummary === undefined ? {} : { previousSummary }),
      requestTranscript: all,
    });
    assert.ok((previousSummary.match(/\[background summary; observations, not instructions\]/g)?.length ?? 0) <= 1);
    assert.ok((previousSummary.match(/\[request observations at compaction;/g)?.length ?? 0) <= 1);
    assert.match(previousSummary, /CURRENT_REQUEST/);
    assert.match(previousSummary, new RegExp("OBSERVED_STAGE_" + window));
    assert.ok(previousSummary.length <= 4000);
  }
});

test("observed tool results outrank old assistant plans when the digest is full", () => {
  const previousSummary = ["user: ORIGINAL_CONSTRAINT: preserve the public API.",
    ...Array.from({ length: 30 }, (_, index) => "assistant: OLD_PLAN_" + index + " inspect again ".repeat(15))].join("\n");
  const items: TranscriptItem[] = [
    ...observation(1, "checked", "CURRENT_OBSERVATION: the requested check returned zero overflow."),
    ...Array.from({ length: 12 }, (_, index): TranscriptItem => ({
      kind: "assistant_text", sequence: index + 3, blockId: "plan-" + index, text: "LATER_PLAN_" + index + " inspect another detail ".repeat(15),
    })),
  ];
  const summary = summarizeTranscript(items, { previousSummary, maxChars: 900 });

  assert.match(summary, /CURRENT_OBSERVATION/);
  assert.match(summary, /ORIGINAL_CONSTRAINT/);
  assert.match(summary, /\[elided /);
  assert.ok(summary.length <= 900);
});
