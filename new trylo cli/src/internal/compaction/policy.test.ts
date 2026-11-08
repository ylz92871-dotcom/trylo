import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SUMMARY_MAX_CHARS,
  type CompactionProbe,
  type PromptView,
} from "../ports/compaction.js";
import type { TranscriptItem } from "../protocol/transcript.js";
import { hasDisclosureRisk } from "./disclosure.js";
import { shouldCompact } from "./policy.js";
import { summarizeTranscript, validateSummary } from "./summary.js";

/**
 * Threshold and summary rules.
 *
 * Both sides of every boundary are exercised: the hold side and the trigger
 * side, accepted text and refused text. A suite that only proves compaction can
 * be avoided proves nothing about the policy that is supposed to fire.
 */

function items(count: number): readonly TranscriptItem[] {
  const built: TranscriptItem[] = [];
  for (let index = 0; index < count; index += 1) {
    built.push({ kind: "user", sequence: index, text: `message ${index}` });
  }
  return built;
}

function probe(overrides: Partial<CompactionProbe> = {}): CompactionProbe {
  const base: CompactionProbe = {
    view: { items: items(3), window: undefined, horizonSequence: undefined },
    contextTokenLimit: 1_000,
    estimatedPromptTokens: 400,
  };
  return { ...base, ...overrides };
}

test("an estimate below the auto-compaction threshold holds", () => {
  const decision = shouldCompact(probe({ estimatedPromptTokens: 899 }));
  assert.deepEqual(decision, { outcome: "hold", reason: "within_limit" });
});

test("an estimate exactly at ninety percent compacts", () => {
  // Compact before the hard ceiling so the next request has room to grow.
  const decision = shouldCompact(probe({ estimatedPromptTokens: 900 }));
  assert.deepEqual(decision, { outcome: "compact", reason: "estimated_tokens_reached_limit" });
});

test("an estimate above the limit compacts", () => {
  const decision = shouldCompact(probe({ estimatedPromptTokens: 250_000 }));
  assert.equal(decision.outcome, "compact");
});

test("an empty prompt view never compacts", () => {
  const empty: PromptView = { items: [], window: undefined, horizonSequence: undefined };
  const decision = shouldCompact(probe({ view: empty, estimatedPromptTokens: 500_000 }));
  assert.deepEqual(decision, { outcome: "hold", reason: "nothing_to_compact" });
});

test("the decision ignores nothing but the probe: same probe, same answer", () => {
  const first = shouldCompact(probe({ estimatedPromptTokens: 900 }));
  const second = shouldCompact(probe({ estimatedPromptTokens: 900 }));
  assert.deepEqual(first, second);
});

test("a summary carrying an api key is refused before it can reach disk", () => {
  const validated = validateSummary("the user configured api_key= sk-liveabc123456789 later");
  assert.equal(validated.ok, false);
  if (!validated.ok) {
    assert.equal(validated.code, "summary_unsafe");
  }
});

test("a summary carrying a windows absolute path is refused", () => {
  const validated = validateSummary("edited C:\\Users\\someone\\project\\main.ts twice");
  assert.equal(validated.ok, false);
  if (!validated.ok) {
    assert.equal(validated.code, "summary_unsafe");
  }
});

test("a summary carrying a posix absolute path is refused", () => {
  const validated = validateSummary("edited /home/someone/project/main.ts twice");
  assert.equal(validated.ok, false);
  if (!validated.ok) {
    assert.equal(validated.code, "summary_unsafe");
  }
});

test("a summary longer than the bound is refused rather than trimmed", () => {
  const validated = validateSummary("x".repeat(SUMMARY_MAX_CHARS + 1));
  assert.equal(validated.ok, false);
  if (!validated.ok) {
    assert.equal(validated.code, "summary_too_long");
  }
});

test("a summary at exactly the bound is accepted", () => {
  assert.deepEqual(validateSummary("x".repeat(SUMMARY_MAX_CHARS)), { ok: true });
});

test("a blank summary is refused", () => {
  const validated = validateSummary("   ");
  assert.equal(validated.ok, false);
  if (!validated.ok) {
    assert.equal(validated.code, "summary_empty");
  }
});

test("the built-in digest scrubs absolute paths instead of carrying them", () => {
  const digest = summarizeTranscript([
    { kind: "assistant_text", sequence: 0, blockId: "b1", text: "wrote C:\\secrets\\key.pem and /etc/hosts" },
  ]);
  assert.equal(hasDisclosureRisk(digest), false);
  assert.ok(digest.includes("[path]"));
});

test("the built-in digest scrubs credential shapes instead of carrying them", () => {
  const digest = summarizeTranscript([
    { kind: "user", sequence: 0, text: "my token: abcdef1234567890 lives here" },
  ]);
  assert.equal(hasDisclosureRisk(digest), false);
  assert.ok(digest.includes("[secret]"));
});

test("the built-in digest excludes redacted reasoning from public history", () => {
  const digest = summarizeTranscript([
    { kind: "assistant_reasoning", sequence: 0, blockId: "b1", text: "", redacted: true },
  ]);
  assert.equal(digest.includes("[redacted]"), false);
  assert.equal(digest.includes("assistant_reasoning"), false);
});

test("the built-in digest is bounded", () => {
  const many = items(500);
  const digest = summarizeTranscript(many);
  assert.equal(digest.length <= SUMMARY_MAX_CHARS, true);
});

test("the built-in digest is deterministic across calls", () => {
  const once = summarizeTranscript(items(12));
  const twice = summarizeTranscript(items(12));
  assert.equal(once, twice);
});

test("the built-in digest stays inside its own smaller bound when asked", () => {
  const digest = summarizeTranscript(items(200), { maxChars: 200 });
  assert.equal(digest.length <= 200, true);
});

test("every public item kind contributes a line without exposing reasoning", () => {
  const digest = summarizeTranscript([
    { kind: "system", sequence: 0, text: "you are an assistant" },
    { kind: "user", sequence: 1, text: "hello" },
    { kind: "assistant_text", sequence: 2, blockId: "b1", text: "hi" },
    { kind: "assistant_reasoning", sequence: 3, blockId: "b2", text: "thinking", redacted: false },
    { kind: "tool_call", sequence: 4, toolCallId: "c1", name: "read", arguments: {} },
    {
      kind: "tool_result",
      sequence: 5,
      toolCallId: "c1",
      name: "read",
      output: "done",
      truncated: false,
      outcome: "succeeded",
    },
  ]);

  assert.equal(digest.split("\n").length, 5);
  assert.equal(digest.includes("thinking"), false);
});
