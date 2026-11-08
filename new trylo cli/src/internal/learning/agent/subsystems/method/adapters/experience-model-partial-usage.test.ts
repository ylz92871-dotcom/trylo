import assert from "node:assert/strict";
import test from "node:test";
import { emptyUsage, type ProviderPort } from "../../../../../ports/provider.js";
import type { CentralLearningUsage } from "../../../../control/coordination-contract.js";
import { createExperienceModel, type ExperienceFundingPort } from "./experience-model.js";

test("usage before a hung transport cannot release the unknown remainder of its reservation", async () => {
  let entered: () => void = () => {}, expire: () => void = () => {};
  const hung = new Promise<void>(resolve => { entered = resolve; });
  const settlements: CentralLearningUsage[] = [];
  const child: ProviderPort = { async *stream() {
    yield { type: "stream_start", providerId: "test", model: "test", warnings: [] };
    yield { type: "usage", usage: { ...emptyUsage(), inputTokens: 10, totalTokens: 10 } };
    entered();
    await new Promise<void>(() => {});
  } };
  const funding: ExperienceFundingPort = {
    async inspect() { return { ok: true, active: true, remaining: { tokens: 24000, calls: 4, steps: 4 }, maxPromptChars: 12000 }; },
    async reserve() { return { ok: true, status: "reserved" }; },
    async settle(input) {
      settlements.push(input.usage);
      return { ok: true };
    },
  };
  const model = createExperienceModel({ provider: { fork: () => child, stream: child.stream }, funding, model: "test", turnId: "task",
    scheduler: (_delay, fire) => {
      expire = fire;
      return { cancel() {} };
    } });
  const pending = model.review({ snapshotId: "snapshot", versionId: "v", method: "Inspect.", confidence: .99,
    observations: [], counterexamples: [], scope: { id: "h", scopeId: "s", versionId: "v", proposedSequence: 0,
      predicate: { all: [{ feature: "format", value: "json" }], exclude: [] } } }, new AbortController().signal);

  await hung;
  expire();
  await assert.rejects(pending, { reason: "method_review_timeout" });
  assert.deepEqual(settlements, [{ kind: "unknown", reason: "method_review_timeout" }]);
});
