import assert from "node:assert/strict";
import test from "node:test";
import { variantOf } from "../assets/archive.js";
import { snapshotOf } from "../domain/experience-state.js";
import { createExperienceRuntime, type ExperienceView, type ExperienceStore } from "./experience-runtime.js";
import { createMethodBoard } from "./board.js";
import type { MethodArchivePort } from "../port.js";

// Pure planning fixtures earn their view's dual gate through synthetic observations;
// these packets do not stand in for real-provider or persistence acceptance.
function viewOf(count: number, stable = true): ExperienceView {
  let view: ExperienceView = { sequence: 0, facts: [], observations: [], versions: [], variants: [] };

  for (let index = 0; index < count; index += 1) {
    const id = `v${index}`, hint = `ORIGINAL_LONG_METHOD_BODY_${index}_` + "inspect and compare several approaches before choosing. ".repeat(2);
    const variant = variantOf({ versionId: id, proposalId: `p${index}`, accounting: [], card: { schemaVersion: 1, hint,
      labels: [], appliesWhen: {}, lineage: { createdFrom: { turnId: "origin", beat: 1, reason: "repeat_call" } } } });
    const proposedSequence = view.sequence;
    const scope = { id: `h${index}`, versionId: id, scopeId: "base", proposedSequence,
      predicate: { all: [{ feature: "format", value: "json" }], exclude: [] } };

    view = { ...view, sequence: proposedSequence + 1, variants: [...view.variants, variant],
      versions: [...view.versions, { versionId: id, hint }], facts: [...view.facts, { kind: "scope", factId: `scope-${index}`,
        versionId: id, sequence: proposedSequence + 1, hypothesis: scope, description: hint }] };

    for (let use = 0; use < 10; use += 1) view = { ...view, sequence: view.sequence + 1,
      observations: [...view.observations, { observationId: `${id}-o${use}`, versionId: id, taskId: `${id}-t${use}`,
        opportunityId: "lookup", scopeId: "base", sequence: view.sequence + 1, revision: 0,
        source: "self_report", adoption: "adopted", outcome: "helped", features: { format: "json" } }] };

    if (stable) {
      const snapshot = snapshotOf(view, scope);
      assert.ok(snapshot.posterior.confidence >= .95);
      view = { ...view, sequence: view.sequence + 1, facts: [...view.facts, { kind: "review", factId: `compile-${index}`,
        versionId: id, scopeId: "base", sequence: view.sequence + 1, snapshotId: snapshot.snapshotId,
        evidenceRevisions: snapshot.revisions, review: { decision: "promote", score: .9, reason: "synthetic packet contract",
          sources: [id], compact: { when: `JSON known-key lookup ${index}`, action: "Read the keyed file.", exceptions: "Follow index if moved." } } }] };
    }
  }

  return view;
}

function runtime(load: () => ExperienceView) {
  const store: ExperienceStore = { async load() { return load(); }, async append() { throw new Error("unexpected write"); } };
  return createExperienceRuntime({ store, emit: () => {}, correct: async () => {}, revise: async () => {} });
}

test("the first planning hook replaces stable original bodies and packs complete JSON within its full budget", async () => {
  const view = viewOf(24), service = runtime(() => view);
  const first = await service.slot("fresh");
  assert.ok(first);
  assert.equal(first.message.content.includes("ORIGINAL_LONG_METHOD_BODY"), false);
  assert.ok(first.message.content.length <= 1200);
  const entries = first.message.content.split("\n").filter(line => line.startsWith("{"));

  assert.ok(entries.length > 0 && entries.length < 24);

  for (const line of entries) assert.ok(JSON.parse(line).predicate);

  await service.context({ taskId: "fresh", opportunityId: "lookup", situation: "JSON lookup", features: { format: "json" } });
  const bound = await service.slot("fresh");
  assert.ok(bound);
  assert.ok(bound.message.content.length <= 1200, "header and feedback instructions count too");
  assert.equal(bound.message.content.includes("ORIGINAL_LONG_METHOD_BODY"), false);
  assert.ok(bound.message.content.includes("[method adoption]"), "a displayed match must keep the adoption step at the actual execution boundary");
  assert.ok(bound.message.content.includes("operation=adopt"));
});

test("the same planning read invalidates both bound adoption and unbound legacy trials after external retirement", async () => {
  let view = viewOf(1, false);
  const service = runtime(() => view);
  const archive: MethodArchivePort = { async load() { return { ok: true, variants: view.variants, shadowActivations: {} }; },
    commitCard: async () => ({ ok: true, events: 0, duplicate: false }), recordAccount: async () => ({ ok: true, events: 0, duplicate: false }),
    recordUse: async () => ({ ok: true, events: 0, duplicate: false }), recordFeedback: async () => ({ ok: true, events: 0, duplicate: false }) };
  const board = createMethodBoard({ archive, experience: service, emit: () => {}, now: () => "2026-11-03T00:00:00.000Z" });
  const initial = await board.requestSlot({ turnId: "legacy", beat: 1, toolNames: [] });
  assert.equal(initial?.receipts.length, 1);
  assert.equal(initial?.message.content.includes("method_context"), false, "a missing tool must not be advertised by the hook");
  view = { ...view, variants: view.variants.map(item => ({ ...item, retention: "evicted" })) };
  const retired = await board.requestSlot({ turnId: "legacy", beat: 2, toolNames: [] });

  assert.equal(retired?.receipts.length ?? 0, 0);
  assert.equal(retired?.message.content.includes("ORIGINAL_LONG_METHOD_BODY") ?? false, false);
  view = viewOf(1);
  await service.context({ taskId: "bound", opportunityId: "lookup", situation: "JSON lookup", features: { format: "json" } });
  assert.equal((await service.slot("bound"))?.receipts.length, 1);
  view = { ...view, sequence: view.sequence + 1, facts: [...view.facts, { kind: "exit", factId: "replaced", versionId: "v0",
    sequence: view.sequence + 1, mode: "archive", reason: "replacement" }] };
  assert.equal((await service.slot("bound"))?.receipts.length, 0);
});

test("unknown and external-failure corrections withdraw evidence without creating a global failure epoch", async () => {
  const view = viewOf(1);
  let corrections = 0, exits = 0;
  const service = createExperienceRuntime({ emit: () => {}, revise: async () => {},
    correct: async () => { corrections += 1; }, store: { load: async () => view,
      async append() {
        exits += 1;
        throw new Error("unknown must not create a global exit");
      } } });

  for (const outcome of ["unknown", "external_failure"] as const) {
    await service.correct({ observationId: view.observations[0]!.observationId, outcome, reason: "result attribution is unknown" });
  }

  assert.equal(corrections, 2);
  assert.equal(exits, 0);
});

test("tool availability invalidates selection and its cache when a required tool disappears or returns", async () => {
  const initial = viewOf(1);
  const view = { ...initial, variants: initial.variants.map(item => ({ ...item,
    card: { ...item.card, appliesWhen: { tools: ["read_file"] } } })) };
  const service = runtime(() => view);
  const context = { taskId: "task", opportunityId: "lookup", situation: "JSON lookup", features: { format: "json" } };

  await service.slot("task", ["method_context", "read_file"]);
  assert.equal((await service.context(context)).length, 1);
  assert.equal((await service.slot("task", ["method_context"]))?.receipts.length, 0);
  assert.equal((await service.context(context)).length, 0);
  await service.slot("task", ["method_context", "read_file"]);
  assert.equal((await service.context(context)).length, 1, "returning tools must trigger a fresh match");
});

test("missing registered facts are offered once for clarification and never inferred from situation text", async () => {
  const view = viewOf(1), service = runtime(() => view);
  const context = { taskId: "fresh", opportunityId: "lookup", situation: "Read schema-v1 JSON by key", features: { task_type: "lookup" } };

  assert.deepEqual(await service.context(context), []);
  const pending = service.takeContextConditions?.();
  assert.equal(pending?.length, 1);
  assert.deepEqual(pending?.[0]?.missing, [{ relation: "required", feature: "format", expectedValue: "json" }]);
  assert.deepEqual(context.features, { task_type: "lookup" }, "the host cannot turn narrative meaning into a true feature");
  assert.deepEqual(await service.context(context), []);
  assert.deepEqual(service.takeContextConditions?.(), [], "unchanged unknown context cannot prompt a clarification loop");
  assert.equal((await service.context({ ...context, features: { format: "json" } })).length, 1);
  assert.equal((await service.slot("fresh"))?.receipts.length, 1);
  assert.deepEqual(await service.context({ ...context, features: { format: "csv" } }), []);
  assert.deepEqual(service.takeContextConditions?.(), [], "an explicit mismatch never requests a fabricated match");
});
