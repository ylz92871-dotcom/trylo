import assert from "node:assert/strict";
import test from "node:test";
import type { Transcript } from "../../../../../protocol/transcript.js";
import type { ProviderEvent, ProviderPort, ProviderRequest } from "../../../../../ports/provider.js";
import type { CentralLearningGrant } from "../../../../control/coordination-contract.js";
import type { SkillCentralFunding } from "../control/contracts.js";
import { hermesReviewExecution } from "./review-execution.js";
import { withSkillCentralFunding } from "./funded-provider.js";

test("accepted review history is not a new failure/product; admission is diagnostic and generation is separately bounded", async () => {
  const history: Transcript = [
    { kind: "tool_call", sequence: 0, toolCallId: "denied", name: "skill_propose", arguments: { name: "example", action: "patch" } },
    { kind: "tool_result", sequence: 1, toolCallId: "denied", name: "skill_propose", outcome: "succeeded", truncated: false,
      output: JSON.stringify({ success: false, error: "read current target first" }) },
    { kind: "tool_call", sequence: 2, toolCallId: "older-stage", name: "skill_propose", arguments: { name: "example", action: "patch" } },
    { kind: "tool_result", sequence: 3, toolCallId: "older-stage", name: "skill_propose", outcome: "succeeded", truncated: false,
      output: JSON.stringify({ success: true, staged: true, pending_id: "older-pending" }) },
  ];
  const current = hermesReviewExecution([...history,
    { kind: "assistant_text", sequence: 4, blockId: "new-answer", text: "No durable change remains after the confirmed work." }], "completed", history);
  assert.equal(current.toolFailures, 0);
  assert.deepEqual(current.proposals, []);
  assert.match(current.answer, /^No durable change/);
  assert.equal(hermesReviewExecution(history, "completed").toolFailures, 1, "old failure is retained in its own execution");

  let reserves = 0, upstream = 0, settlements = 0, selectedOutput: number | undefined;
  const grant: CentralLearningGrant = { schemaVersion: 2, grantId: "grant", jobId: "job", issueId: "issue", scope: "scope",
    domain: "skill", focusRevision: 1, status: "open", steps: 0, reservations: [], allowance: {
      schemaVersion: 2, unit: "total_model_tokens", maxTokens: 320000, maxCalls: 16, maxSteps: 16, maxPromptChars: 8 } };
  const funding: SkillCentralFunding = {
    async inspect() { return { ok: true, active: true, grant, remaining: { tokens: 320000, calls: 16, steps: 16 } }; },
    async reserve() { reserves += 1; return { ok: true, status: "reserved", grant, remaining: { tokens: 320000, calls: 15, steps: 15 } }; },
    async settle() { settlements += 1; return { ok: true, status: "settled", grant, remaining: { tokens: 319988, calls: 15, steps: 15 } }; },
  };
  const transport: ProviderPort = { async *stream(request) {
    upstream += 1; selectedOutput = request.maxOutputTokens;
    yield { type: "usage", usage: { mode: "snapshot", inputTokens: 10, outputTokens: 2, totalTokens: 12,
      cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } };
    yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
  } };
  const provider = withSkillCentralFunding(transport, { funding, newId: () => "call", maxOutputTokens: 32768 });
  const request: ProviderRequest = { attemptId: "request", model: "fixture", messages: [
    { role: "user", content: "do-not-log-private-source-body" }], tools: [], maxOutputTokens: 320000 };
  const events: ProviderEvent[] = [];
  await assert.rejects(async () => { for await (const event of provider.stream(request, new AbortController().signal)) events.push(event); }, /skill_learning_prompt_limit/);
  assert.equal(reserves, 0); assert.equal(upstream, 0); assert.equal(settlements, 0);
  const warning = events.find(event => event.type === "warning");
  assert.ok(warning?.type === "warning");
  const diagnostic = JSON.parse(warning.message);
  assert.equal(diagnostic.reason, "skill_learning_prompt_limit");
  assert.ok(diagnostic.promptChars > diagnostic.promptLimit);
  assert.doesNotMatch(warning.message, /do-not-log-private-source-body/);

  const admitted = { ...funding, async inspect() { const snapshot = await funding.inspect(); return snapshot.ok ? {
    ...snapshot, grant: { ...grant, allowance: { ...grant.allowance, maxPromptChars: 160000 } } } : snapshot; } };
  const continued = withSkillCentralFunding(transport, { funding: admitted, newId: () => "new-call", maxOutputTokens: 32768 });
  for await (const _event of continued.stream(request, new AbortController().signal)) { /* Drain the actual owner boundary. */ }
  assert.equal(reserves, 1); assert.equal(upstream, 1); assert.equal(settlements, 1);
  assert.equal(selectedOutput, 32768);
  assert.equal(grant.allowance.maxTokens, 320000, "single-response allocation never rewrites the lifetime grant");
});
