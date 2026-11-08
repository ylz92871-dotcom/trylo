import assert from "node:assert/strict";
import test from "node:test";
import { emptyUsage, type ProviderEvent, type ProviderPort, type ProviderRequest } from "../../../../../ports/provider.js";
import type { CentralLearningGrant, LearningIssue } from "../../../../control/coordination-contract.js";
import type { CentralFundingPort } from "../control/contracts.js";
import { createCollaborationDecisionModel } from "./decision-model.js";

type Scenario = "normal" | "error" | "cancel" | "eof" | "tail_timeout" | "overrun";

const at = "2026-11-04T04:00:00.000Z", sourceRef = "report:usage";
const issue: LearningIssue = { schemaVersion: 1, issueId: "issue:usage", scope: "scope:usage", problemKey: "usage-boundary",
  revision: 1, reports: [], decision: { kind: "focused_learning", reason: "Existing PA focus", sourceRefs: [sourceRef], decidedAt: at, revision: 1 },
  createdAt: at, updatedAt: at };
const remaining = { tokens: 100000, calls: 4, steps: 4 };
const grant: CentralLearningGrant = { schemaVersion: 2, grantId: "grant:usage", issueId: issue.issueId, scope: issue.scope,
  jobId: "job:usage", domain: "collaboration", focusRevision: 1, steps: 0, reservations: [], status: "open",
  allowance: { schemaVersion: 2, unit: "total_model_tokens", maxTokens: remaining.tokens, maxCalls: remaining.calls,
    maxSteps: remaining.steps, maxPromptChars: 50000 } };
const finish: ProviderEvent = { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
const text: ProviderEvent = { type: "text_delta", blockId: "action", text: JSON.stringify({ kind: "no_change",
  reason: "No supported change in this synthetic receipt test", sourceRefs: [sourceRef] }) };
const usage = (tokens: number): ProviderEvent => ({ type: "usage", usage: { ...emptyUsage(), inputTokens: tokens, totalTokens: tokens } });

async function scenario(kind: Scenario) {
  const controller = new AbortController(), requests: ProviderRequest[] = [];
  const reservations: Parameters<CentralFundingPort["reserve"]>[0][] = [], settlements: Parameters<CentralFundingPort["settle"]>[0][] = [];
  let forks = 0, parentCalls = 0, cancelledTimers = 0;
  const funding: CentralFundingPort = {
    inspect: async () => ({ ok: true, active: true, grant, remaining }),
    reserve: async input => {
      reservations.push(input);
      return { ok: true, status: "reserved", grant, remaining };
    },
    settle: async input => {
      settlements.push(input);
      return { ok: true, status: "settled", grant, remaining };
    },
  };
  const isolated: ProviderPort = { async *stream(request) {
    requests.push(request);
    yield usage(kind === "overrun" ? 1000000 : 100);

    if (kind === "error") yield { type: "error", class: "network", phase: "after_stream_started", retryable: false, message: "Synthetic redacted failure" };
    else if (kind === "cancel") {
      controller.abort();
      yield { type: "cancel_ack" };
    }
    else if (kind === "normal" || kind === "tail_timeout") {
      yield text;
      yield finish;
      if (kind === "tail_timeout") yield { type: "warning", code: "stream_finish_tail_timeout", message: "Synthetic missing usage tail" };
    }
  } };
  const provider: ProviderPort = { fork(messages) {
    assert.deepEqual(messages, []);
    forks += 1;
    return isolated;
  },
    async *stream() {
      parentCalls += 1;
      throw new Error("Parent provider must never be streamed");
    } };
  const model = createCollaborationDecisionModel({ provider, model: "synthetic-no-network", enabled: () => true,
    scheduler: () => ({ cancel: () => { cancelledTimers += 1; } }) });
  const result = await model.decide({ issue, material: {}, step: 0, knownSourceRefs: [sourceRef], jobId: grant.jobId,
    claimId: "claim:usage", funding, maxPromptChars: grant.allowance.maxPromptChars, signal: controller.signal });

  assert.equal(forks, 1);
  assert.equal(parentCalls, 0);
  assert.equal(requests.length, 1);
  assert.equal(reservations.length, 1);
  assert.equal(settlements.length, 1);
  assert.equal(cancelledTimers, 1);
  assert.equal(settlements[0]!.reservationId, reservations[0]!.reservationId);
  assert.deepEqual(requests[0]!.tools, []);
  assert.equal(requests[0]!.continuationScope, grant.jobId);

  return { result, reservation: reservations[0]!, settlement: settlements[0]! };
}

test("successful completion and complete usage remain a reported settlement", async () => {
  const value = await scenario("normal");
  assert.equal(value.result.ok, true);
  assert.deepEqual(value.settlement.usage, { kind: "reported", inputTokens: 100, outputTokens: 0,
    totalTokens: 100, model: "synthetic-no-network" });
});

for (const kind of ["error", "cancel", "eof"] as const) {
  test(`usage followed by ${kind} stays unknown rather than releasing the partial observed amount`, async () => {
    const value = await scenario(kind);
    assert.equal(value.result.ok, false);
    assert.equal(value.settlement.usage.kind, "unknown");
    assert.ok(value.reservation.maxTokens > 100, "the unknown classification preserves the original larger reservation");
  });
}

test("a finish-tail timeout warning makes observed usage unknown even after a normal finish", async () => {
  const value = await scenario("tail_timeout");
  assert.deepEqual(value.settlement.usage, { kind: "unknown", reason: "provider_usage_tail_incomplete" });
});

test("an observed overrun is retained as a reported lower bound without clamping or asserting final billing", async () => {
  const value = await scenario("overrun");
  assert.equal(value.result.ok, false);
  if (!value.result.ok) assert.equal(value.result.reason, "learning_provider_exceeded_reservation");
  assert.deepEqual(value.settlement.usage, { kind: "reported", inputTokens: 1000000, outputTokens: 0,
    totalTokens: 1000000, model: "synthetic-no-network" });
  assert.ok(value.reservation.maxTokens < 1000000);
});
