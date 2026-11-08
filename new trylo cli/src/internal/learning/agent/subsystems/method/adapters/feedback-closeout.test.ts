import { testScratchPath } from "../../../../../testing/scratch.js";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { createMethodBoardWriter } from "./board-writer.js";
import { createExperienceStore } from "./experience-store.js";
import { createExperienceRuntime } from "../orchestration/experience-runtime.js";
import { createBoardReader } from "../../../../../adapters/learning-store/file-event-store.js";
import { observationForFeedback } from "./experience-feedback.js";
import { evidenceOf } from "../domain/inference-observations.js";
import type { ExperienceContext } from "../experience-port.js";
import type { FeedbackInput } from "../port.js";

const V = "feedback-v", AT = "2026-11-03T22:30:00.000Z";
const context = (opportunityId = "one", format = "json"): ExperienceContext =>
  ({ taskId: "parent", opportunityId, situation: `Use ${format}`, features: { format } });

async function board(run: (h: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const parent = testScratchPath("method-feedback-closeout");
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(path.join(parent, "board-"));
  try { await run(await setup(root)); }
  finally {
    assert.equal(path.dirname(path.resolve(root)), parent);
    rmSync(root, { recursive: true, force: true });
  }
}

async function setup(root: string) {
  const writer = createMethodBoardWriter(root);
  const committed = await writer.commitCard({ card: { schemaVersion: 1, hint: "Read the schema before editing JSON.", labels: [], appliesWhen: {},
    lineage: { createdFrom: { turnId: "origin", beat: 1, reason: "containment" } } }, nicheId: "n", versionId: V,
    proposalId: "p", evidenceId: "e", writeId: "seed", sample: "unknown_schema", observedAt: AT });
  assert.ok(committed.ok);
  const store = createExperienceStore(root, () => AT);

  await store.append(view => ({ kind: "scope", factId: "scope", versionId: V, sequence: view.sequence + 1, description: "structured documents",
    hypothesis: { id: "scope-h", versionId: V, scopeId: "base", proposedSequence: view.sequence,
      predicate: { all: [{ feature: "format", value: "json" }], exclude: [] } } }));
  const runtime = createExperienceRuntime({ store, correct: async () => {}, revise: async () => {}, emit: () => {} });
  const field = async (ctx = context(), beat = 1) => {
    await runtime.context(ctx);
    const delivery = await runtime.slot(ctx.taskId, ["method_context"], undefined, undefined, beat * 10);
    const receipt = delivery!.receipts[0]!;
    assert.ok(receipt);
    const exposureId = `exposure-${beat}`;
    const used = await writer.recordUse({ writeId: exposureId, exposureId, versionId: V, proposalId: "p", turnId: ctx.taskId,
      beat, requestId: `request-${beat}`, scope: "base", observedAt: AT, binding: receipt.binding! });
    assert.ok(used.ok);
    return { writeId: `feedback-${beat}`, exposureId, versionId: V, turnId: ctx.taskId, helped: true, observedAt: AT } satisfies FeedbackInput;
  };
  const adopt = () => runtime.decide({ versionId: V, scopeId: "base", action: "adopt", reason: "Schema-first applies here" });

  return { root, writer, store, runtime, field, adopt };
}

test("feedback uses the delivered context after later context replacement, and block preserves actual adoption", async () => board(async h => {
  const original = { ...context(), features: { format: "json" } }, feedback = await h.field(original);
  await h.adopt();
  original.features.format = "mutated";
  await h.runtime.decide({ versionId: V, scopeId: "base", action: "block", reason: "schema assumption failed" });
  await h.runtime.context({ ...context("later"), taskId: "another" });
  assert.ok((await h.writer.recordFeedback({ ...feedback, context: context("wrong"), helped: false })).ok);
  const view = await h.store.load(), observed = view.observations[0]!;

  assert.equal(observed.opportunityId, "one");
  assert.equal(observed.features.format, "json");
  assert.equal(observed.adoption, "adopted");
  assert.equal(observed.outcome, "unhelpful");
}));

test("missing first representative feedback cannot be replaced by a later successful opportunity", async () => board(async h => {
  await h.field(context("first"));
  await h.adopt();
  const feedback = await h.field(context("second"), 2);
  await h.adopt();
  assert.ok((await h.writer.recordFeedback(feedback)).ok);
  const view = await h.store.load();
  assert.equal(view.observations[0]!.clusterRepresentative, false);
  const evidence = evidenceOf(view.observations, { versionId: V });
  assert.equal(evidence.successes, 0);
  assert.equal(evidence.dependent, 1);
}));

test("the public persistent writer rejects omitted representative metadata and hidden adopted failures", async () => board(async h => {
  const feedback = await h.field();
  await h.adopt();
  const loaded = await createBoardReader(h.root).load();
  assert.ok(loaded.ok);
  const observation = observationForFeedback(loaded.state, { ...feedback, helped: false })!;
  assert.ok(observation);
  const { clusterRepresentative: _marker, ...missing } = observation;

  assert.equal((await h.writer.recordFeedback({ ...feedback, helped: false, observation: missing })).ok, false);
  assert.equal((await h.writer.recordFeedback({ ...feedback, helped: false,
    observation: { ...observation, adoption: "displayed", clusterRepresentative: false } })).ok, false);
  assert.ok((await h.writer.recordFeedback({ ...feedback, helped: false, observation })).ok);
  assert.equal(evidenceOf((await h.store.load()).observations, { versionId: V }).failures, 1);
}));

test("application retries are idempotent and a changed same-revision report is rejected", async () => board(async h => {
  const feedback = await h.field();
  await h.adopt();
  const application = { practice: "Read declared schema", result: "Schema identified" };

  assert.ok((await h.writer.recordFeedback({ ...feedback, application })).ok);
  assert.ok((await h.writer.recordFeedback({ ...feedback, application })).ok);
  assert.equal((await h.writer.recordFeedback({ ...feedback, application: { ...application, result: "different" } })).ok, false);
  const view = await h.store.load();
  assert.equal(view.observations.length, 1);
  assert.deepEqual(view.observations[0]!.application, application);
}));
