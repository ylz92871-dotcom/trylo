import assert from "node:assert/strict";
import test from "node:test";
import { emptyUsage, type ProviderEvent, type ProviderPort } from "../../../../../ports/provider.js";
import type { CentralLearningUsage } from "../../../../control/coordination-contract.js";
import { createExperienceModel, type ExperienceFundingPort } from "./experience-model.js";

for (const warningPosition of ["before_finish", "after_finish"] as const) {
  test(`usage-tail timeout ${warningPosition} retains the reservation without changing a valid review`, async () => {
    const review = { decision: "defer", score: .6, reason: "More distinct task evidence is needed.", sources: ["v1"] };
    const settlements: CentralLearningUsage[] = [], reservations: number[] = [];
    const warning: ProviderEvent = { type: "warning", code: "stream_finish_tail_timeout", message: "bounded synthetic usage tail timeout" };
    const child: ProviderPort = { async *stream() {
      yield { type: "stream_start", providerId: "test", model: "test", warnings: [] };
      yield { type: "text_delta", blockId: "text", text: JSON.stringify(review) };
      yield { type: "usage", usage: { ...emptyUsage(), inputTokens: 10, totalTokens: 10 } };
      if (warningPosition === "before_finish") yield warning;
      yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
      if (warningPosition === "after_finish") yield warning;
    } };
    const funding: ExperienceFundingPort = {
      async inspect() { return { ok: true, active: true, remaining: { tokens: 24000, calls: 4, steps: 4 }, maxPromptChars: 12000 }; },
      async reserve(input) {
        reservations.push(input.maxTokens);
        return { ok: true, status: "reserved" };
      },
      async settle(input) {
        settlements.push(input.usage);
        return { ok: true };
      },
    };
    const model = createExperienceModel({ provider: { fork: () => child, stream: child.stream }, funding, model: "test", turnId: "task",
      scheduler: () => ({ cancel() {} }) });
    const result = await model.review({ snapshotId: "snapshot", versionId: "v1", method: "Inspect before retrying.", confidence: .99,
      observations: [], counterexamples: [], scope: { id: "scope-hypothesis", scopeId: "scope", versionId: "v1", proposedSequence: 0,
        predicate: { all: [{ feature: "operation", value: "retry" }], exclude: [] } } }, new AbortController().signal);

    assert.deepEqual(result, review);
    assert.equal(reservations.length, 1);
    assert.ok(reservations[0]! > 10);
    assert.deepEqual(settlements, [{ kind: "unknown", reason: "provider_usage_tail_incomplete" }]);
  });
}
