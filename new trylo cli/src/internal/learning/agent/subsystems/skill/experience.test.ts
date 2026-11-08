import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import type { TranscriptItem } from "../../../../protocol/transcript.js";
import type { JsonObject } from "../../../../protocol/envelope.js";
import { skillExperience } from "./experience.js";

function exchange(index: number, options: { readonly name?: string; readonly output?: string; readonly failed?: boolean } = {}): TranscriptItem[] {
  const name = options.name ?? `observed_tool_${index}`;
  return [
    { kind: "tool_call", sequence: index * 2, toolCallId: `call-${index}`, name, arguments: { step: index } },
    { kind: "tool_result", sequence: index * 2 + 1, toolCallId: `call-${index}`, name,
      output: options.output ?? `Observed result ${index}`, outcome: options.failed ? "failed" : "succeeded", truncated: false },
  ];
}

function messages(experience: JsonObject): JsonObject[] {
  assert.ok(Array.isArray(experience.messages));
  return experience.messages.map(item => {
    assert.ok(item !== null && typeof item === "object" && !Array.isArray(item));
    return item;
  });
}

test("more than 24 short exchanges survive intact when the whole visible projection fits", () => {
  const transcript = Array.from({ length: 40 }, (_, index) => exchange(index)).flat();
  const experience = skillExperience(transcript), observed = messages(experience);
  assert.equal(observed.length, 40);
  assert.equal(experience.omittedEntries, 0);
  assert.equal(experience.truncated, false);
  assert.deepEqual(observed.map(item => item.name), Array.from({ length: 40 }, (_, index) => `observed_tool_${index}`));
  assert.ok(observed.every(item => item.role === "tool_exchange"));
  assert.equal(observed[0]?.output, "Observed result 0");
  assert.equal(observed.at(-1)?.output, "Observed result 39");
});

test("an early failed attempt and its successful repair remain causal evidence beyond the old tail", () => {
  const transcript = [
    ...exchange(0, { name: "render_report", output: "Empty groups were missing from the report.", failed: true }),
    ...exchange(1, { name: "patch_report", output: "Preserve the input group order before rendering." }),
    ...exchange(2, { name: "render_report", output: "Empty groups and their original order are now present." }),
    ...Array.from({ length: 30 }, (_, index) => exchange(index + 3)).flat(),
  ];
  const observed = messages(skillExperience(transcript));

  assert.deepEqual(observed.slice(0, 3).map(item => [item.sequence, item.name, item.outcome, item.output]), [
    [0, "render_report", "failed", "Empty groups were missing from the report."],
    [2, "patch_report", "succeeded", "Preserve the input group order before rendering."],
    [4, "render_report", "succeeded", "Empty groups and their original order are now present."],
  ]);
});

test("actual overflow retains old tool names and outcomes as data within the same total bound", () => {
  const transcript = Array.from({ length: 60 }, (_, index) => exchange(index, {
    name: index === 0 ? "early_failed_probe" : `observed_tool_${index}`,
    output: JSON.stringify({ token: `private-tool-output-${index}`, observation: "detail ".repeat(100) }), failed: index === 0,
  })).flat();
  const experience = skillExperience(transcript), observed = messages(experience), early = observed[0];

  assert.ok(JSON.stringify(experience).length <= 40_000);
  assert.equal(experience.truncated, true);
  assert.equal(experience.omittedEntries, 0);
  assert.deepEqual(early, { sequence: 0, role: "tool_summary", kind: "data", name: "early_failed_probe", outcome: "failed", compacted: true });
  assert.ok(observed.slice(0, 36).every(item => item.role === "tool_summary" && item.kind === "data"));
  assert.equal(observed.at(-1)?.role, "tool_exchange");
  assert.doesNotMatch(JSON.stringify(observed.slice(0, 36)), /private-tool-output-|observation|arguments/);

  for (const budget of [1024, 2048, 8000, 40_000]) {
    const bounded = skillExperience(transcript, budget);
    assert.ok(JSON.stringify(bounded).length <= budget, String(budget));
    assert.equal(bounded.truncated, true);
  }
});

test("newly retained early tool details still cross the real prompt privacy boundary", async () => {
  const first = exchange(0, { output: '{"api_key":"early-output-secret","observation":"keep empty groups"}', failed: true });

  first[0] = { kind: "tool_call", sequence: 0, toolCallId: "call-0", name: "observed_tool_0",
    arguments: { token: "early-argument-secret", order: ["A", "B"] } };
  const experience = skillExperience([
    { kind: "system", sequence: -2, text: "PRIVATE_INTERNAL_SYSTEM" },
    { kind: "assistant_reasoning", sequence: -1, blockId: "private", text: "PRIVATE_HIDDEN_REASONING", redacted: false },
    ...first, ...Array.from({ length: 30 }, (_, index) => exchange(index + 1)).flat(),
  ]);

  assert.match(JSON.stringify(experience), /early-output-secret/, "this pure transport projection leaves privacy to the existing prompt boundary");
  assert.doesNotMatch(JSON.stringify(experience), /PRIVATE_INTERNAL_SYSTEM|PRIVATE_HIDDEN_REASONING/);
  const require = createRequire(import.meta.url);
  const { createNativeReviewBackend } = require("./host/review-backend.mjs");
  const backend = createNativeReviewBackend({ loadPrompt: async () => ({ success: true, prompt: "Official review guidance fixture." }) });
  const store = { root: "experience-transport-contract", memento: { get: (_key: string, fallback: unknown) => fallback, update: async () => {} },
    compatibility: { pendingList: async () => ({ ok: true, pending: [] }) } };
  const prepared = await backend.begin(store, { trigger: "implicit", workspaceRoot: "workspace", experience }, "review");

  try {
    assert.equal(prepared.status, "ready");
    assert.match(prepared.prompt, /keep empty groups/);
    assert.match(prepared.prompt, /observed_tool_0/);
    assert.doesNotMatch(prepared.prompt, /early-output-secret|early-argument-secret/);
    assert.match(prepared.prompt, /REDACTED/);
  } finally { backend.release(store, "review"); }
});
