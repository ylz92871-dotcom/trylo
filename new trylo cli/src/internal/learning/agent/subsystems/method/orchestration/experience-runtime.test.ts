import assert from "node:assert/strict";
import test from "node:test";
import { variantOf } from "../assets/archive.js";
import { createExperienceRuntime, type ExperienceRuntimeOptions, type ExperienceView } from "./experience-runtime.js";

const EMPTY: ExperienceView = { sequence: 0, facts: [], observations: [], variants: [], versions: [] };

function runtime(options: Pick<ExperienceRuntimeOptions, "store">, emit: ExperienceRuntimeOptions["emit"] = () => {}) {
  return createExperienceRuntime({ ...options, emit, correct: async () => {}, revise: async () => {} });
}

test("slot read failure fails closed even when its diagnostic sink is broken", async () => {
  const method = runtime({ store: { load: async () => { throw new Error("unreadable"); }, append: async () => EMPTY } }, () => { throw new Error("sink_failed"); });
  assert.equal(await method.slot("task"), undefined);
});

test("failed scope registration emits degraded and does not break the execution request", async () => {
  const events: unknown[] = [];
  const variant = variantOf({ versionId: "v1", proposalId: "p1", accounting: [], card: { schemaVersion: 1, hint: "Check the format.",
    labels: [], appliesWhen: {}, lineage: { createdFrom: { turnId: "origin", beat: 1, reason: "containment" } } } });
  const method = runtime({ store: { load: async () => ({ ...EMPTY, variants: [variant] }),
    append: async () => { throw new Error("scope_write_failed"); } } }, (_kind, payload) => events.push(payload));

  assert.equal(await method.slot("task"), undefined);
  assert.equal(events.length, 1);
  assert.ok(JSON.stringify(events).includes('"degraded":true'));
});

test("an already cancelled endTurn does no learning IO or model calls", async () => {
  let reads = 0, calls = 0;
  const controller = new AbortController();
  controller.abort();
  const method = createExperienceRuntime({ store: { load: async () => {
    reads++;
    return EMPTY;
  }, append: async () => EMPTY },
    emit: () => {}, correct: async () => {}, revise: async () => {}, model: { review: async () => {
      calls++;
      return { decision: "defer", score: 0, reason: "unused", sources: [] };
    } } });

  await method.endTurn(controller.signal);
  assert.equal(reads, 0);
  assert.equal(calls, 0);
});

test("a reused runtime maintains and reviews once per actual task boundary", async () => {
  let reads = 0;
  const method = runtime({ store: { load: async () => {
    reads++;
    return EMPTY;
  }, append: async () => EMPTY } });

  await method.slot("first-task");
  const first = reads;

  await method.endTurn();
  assert.equal(reads, first + 1);
  await method.endTurn();
  assert.equal(reads, first + 1, "duplicate close does not repeat maintenance");
  await method.slot("next-task");
  const next = reads;

  await method.endTurn();
  assert.equal(reads, next + 1, "a later task still runs withdrawal and eligible review");
});

test("PA and normal close share one review opportunity until the next task", async () => {
  let reads = 0;
  const method = runtime({ store: { load: async () => {
    reads++;
    return EMPTY;
  }, append: async () => EMPTY } });
  await method.slot("task");
  assert.equal(method.claimReview!(), true);
  assert.equal(method.claimReview!(), false);
  const before = reads;
  await method.endTurn();
  assert.equal(reads, before);
  await method.slot("next");
  assert.equal(method.claimReview!(), true);
});
