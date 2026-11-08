import assert from "node:assert/strict";
import test from "node:test";
import type { JsonObject } from "../../../../protocol/envelope.js";
import type { Transcript } from "../../../../protocol/transcript.js";
import { skillProposalReceipts, skillReviewToolFailures } from "./proposal-receipts.js";

const tool = "mcp__trylo-hermes-learning__skill_propose";
const stage = (id: string) => JSON.stringify({ success: true, staged: true, pending_id: id });

function exchange(sequence: number, args: JsonObject, output: string,
  options: { readonly outcome?: "succeeded" | "failed"; readonly truncated?: boolean; readonly callName?: string } = {}): Transcript {
  const toolCallId = `call-${sequence}`;
  return [
    { kind: "tool_call", sequence, toolCallId, name: options.callName ?? tool, arguments: args },
    { kind: "tool_result", sequence: sequence + 1, toolCallId, name: tool, output,
      outcome: options.outcome ?? "succeeded", truncated: options.truncated ?? false },
  ];
}

test("only paired native stage receipts identify a coherent skill's multiple pending writes", () => {
  const transcript: Transcript = [
    { kind: "assistant_text", sequence: 0, blockId: "claim", text: "Saved and approved fake-pending." },
    ...exchange(1, { name: "release-procedure", action: "create" }, stage("main")),
    ...exchange(3, { name: "release-procedure", action: "write_file", file_path: "references/release.md" }, stage("reference")),
  ];

  assert.deepEqual(skillProposalReceipts(transcript), [
    { name: "release-procedure", action: "create", pendingId: "main" },
    { name: "release-procedure", action: "write_file", pendingId: "reference" },
  ]);
  assert.equal(skillReviewToolFailures(transcript), 0);
});

test("transport, native, truncation and causal-name failures cannot become stage receipts", () => {
  const args = { name: "release-procedure", action: "patch" };
  const variants: readonly Transcript[] = [
    exchange(0, args, stage("failed-transport"), { outcome: "failed" }),
    exchange(0, args, JSON.stringify({ success: false, staged: true, pending_id: "rejected" })),
    exchange(0, args, JSON.stringify({ success: true, staged: false, pending_id: "not-staged" })),
    exchange(0, args, stage("incomplete"), { truncated: true }),
    exchange(0, args, stage("wrong-cause"), { callName: "read_file" }),
    exchange(0, args, "{malformed"),
    [{ kind: "tool_result", sequence: 0, toolCallId: "missing", name: tool, output: stage("orphan"), outcome: "succeeded", truncated: false }],
  ];

  for (const transcript of variants) assert.deepEqual(skillProposalReceipts(transcript), []);
});

test("tool failure accounting distinguishes a clean no-op from unavailable Hermes tools", () => {
  const args = { name: "release-procedure", action: "patch" };
  const transcript: Transcript = [
    ...exchange(0, args, JSON.stringify({ success: true, skills: [] })),
    ...exchange(2, args, JSON.stringify({ success: false, error: "read required" })),
    ...exchange(4, args, "dependency not available", { outcome: "failed" }),
    ...exchange(6, args, "{truncated"),
    ...exchange(8, args, JSON.stringify({ success: true, content: "partial but valid JSON" }), { truncated: true }),
  ];

  assert.equal(skillReviewToolFailures(transcript), 4);
  assert.deepEqual(skillProposalReceipts(transcript), []);
});

test("create and linked support writes keep their actual actions when provider requests reuse one call id", () => {
  const transcript: Transcript = [
    { kind: "tool_call", sequence: 0, toolCallId: "reused", name: tool, arguments: { name: "release-procedure", action: "create" } },
    { kind: "tool_result", sequence: 1, toolCallId: "reused", name: tool, output: stage("main"), outcome: "succeeded", truncated: false },
    { kind: "tool_call", sequence: 2, toolCallId: "reused", name: tool,
      arguments: { name: "release-procedure", action: "write_file", file_path: "references/release.md" } },
    { kind: "tool_result", sequence: 3, toolCallId: "reused", name: tool, output: stage("support"), outcome: "succeeded", truncated: false },
  ];
  assert.deepEqual(skillProposalReceipts(transcript), [
    { pendingId: "main", name: "release-procedure", action: "create" },
    { pendingId: "support", name: "release-procedure", action: "write_file" },
  ]);
});

test("a staged result cannot claim a future call or skip a nearer differently named occurrence", () => {
  const transcript: Transcript = [
    { kind: "tool_result", sequence: 0, toolCallId: "future", name: tool, output: stage("future-claim"), outcome: "succeeded", truncated: false },
    { kind: "tool_call", sequence: 1, toolCallId: "future", name: tool, arguments: { name: "future-only", action: "create" } },
    { kind: "tool_call", sequence: 2, toolCallId: "mixed", name: tool, arguments: { name: "earlier-unanswered", action: "patch" } },
    { kind: "tool_call", sequence: 3, toolCallId: "mixed", name: "read_file", arguments: { path: "current.txt" } },
    { kind: "tool_result", sequence: 4, toolCallId: "mixed", name: tool, output: stage("wrong-name-claim"), outcome: "succeeded", truncated: false },
  ];
  assert.deepEqual(skillProposalReceipts(transcript), []);
});
