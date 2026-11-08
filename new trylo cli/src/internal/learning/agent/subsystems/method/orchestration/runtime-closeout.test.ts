import assert from "node:assert/strict";
import test from "node:test";
import { variantOf } from "../assets/archive.js";
import { createExperienceRuntime, type ExperienceStore, type ExperienceView } from "./experience-runtime.js";
import { experienceFactError, matureReview, snapshotOf, scopesOf } from "../domain/experience-state.js";
import type { MethodExperienceFact } from "../domain/experience-facts.js";
import type { MethodObservation } from "../domain/inference.js";
import { adoptionUnitKey } from "../domain/adoption-window.js";
import { closeMissedAdoptionWindows } from "./adoption-window.js";
import type { MethodExecutionSpan } from "../domain/execution-trace.js";

const V = "runtime-v", S = "base";
const CONTEXT = { taskId: "task", opportunityId: "first", situation: "Read JSON", features: { format: "json" } };
const SPAN: MethodExecutionSpan = { firstSequence: 11, lastSequence: 12, toolNames: ["read_file"] };

function harness() {
  const card = { schemaVersion: 1 as const, hint: "Inspect schema before changing JSON.", labels: [], appliesWhen: {},
    lineage: { createdFrom: { turnId: "origin", beat: 1, reason: "containment" as const } } };
  const scope: MethodExperienceFact = { kind: "scope", versionId: V, factId: "scope", sequence: 1, description: "JSON",
    hypothesis: { id: "h", versionId: V, scopeId: S, proposedSequence: 0,
      predicate: { all: [{ feature: "format", value: "json" }], exclude: [] } } };
  let view: ExperienceView = { sequence: 1, facts: [scope], observations: [], versions: [{ versionId: V, hint: card.hint }],
    variants: [variantOf({ versionId: V, proposalId: "p", card, accounting: [] })], fieldings: [] };
  let failWindow = false;
  const store: ExperienceStore = { load: async () => view, append: async make => {
    const fact = make(view);
    const prior = view.facts.find(item => item.factId === fact.factId);
    if (prior !== undefined) return view;
    if (failWindow && fact.kind === "adoption_window_closed") throw new Error("disk_failed");
    const error = experienceFactError(view, fact);
    if (error !== undefined) throw new Error(error);
    view = { ...view, sequence: fact.sequence, facts: [...view.facts, fact] };
    return view;
  } };
  const runtime = (usingStore = store) => createExperienceRuntime({ store: usingStore, emit: () => {}, revise: async () => {},
    correct: async (id, outcome, _reason, application) => {
      const prior = view.observations.find(item => item.observationId === id)!;
      view = { ...view, observations: [...view.observations, { ...prior, revision: prior.revision + 1, outcome,
        ...(application === undefined ? {} : { application }) }] };
    } });
  const field = async (method: ReturnType<typeof runtime>, context = CONTEXT, beat = 1, boundary = 10) => {
    await method.context(context);
    const delivery = await method.slot(context.taskId, ["method_context", "read_file"], undefined, undefined, boundary);
    const receipt = delivery!.receipts[0]!;
    assert.ok(receipt);
    view = { ...view, sequence: view.sequence + 1, fieldings: [...(view.fieldings ?? []), { exposureId: `e${view.sequence}`,
      versionId: V, turnId: context.taskId, scope: S, beat, useSequence: view.sequence + 1, binding: receipt.binding! }] };
    return receipt;
  };

  return { store, runtime, field, view: () => view, set: (next: ExperienceView) => { view = next; }, fail: (value: boolean) => { failWindow = value; } };
}

const adopt = { versionId: V, scopeId: S, action: "adopt" as const, reason: "Use schema-first practice" };
const report = (span = SPAN, beat = 1) => ({ turnId: "task", beat, failures: [], succeededTools: ["read_file"], toolNames: ["read_file"], executionSpan: span });

test("fresh unadopted work closes the parent unit across renamed opportunities and restart", async () => {
  const h = harness(), method = h.runtime();
  await h.field(method);
  await method.observeBeat!(report());
  assert.equal(h.view().facts.filter(item => item.kind === "adoption_window_closed").length, 1);
  await method.context({ ...CONTEXT, opportunityId: "renamed" });
  await assert.rejects(method.decide(adopt), /adoption_window_closed/);
  await method.decide({ ...adopt, action: "deviate" });
  const resumed = h.runtime();
  await resumed.slot("task", ["method_context"], undefined, undefined, 20, SPAN);
  await resumed.context({ ...CONTEXT, opportunityId: "after-restart" });
  await assert.rejects(resumed.decide(adopt), /adoption_window_closed/);
  assert.equal(h.view().observations.length, 0, "window closure is not a negative Bernoulli result");
});

test("same-gun adoption before settlement stays valid and permits fresh trace only", async () => {
  const h = harness(), method = h.runtime();
  await h.field(method);
  await method.decide(adopt);
  await method.observeBeat!(report());
  assert.equal(h.view().facts.some(item => item.kind === "adoption_window_closed"), false);
  await h.field(method, CONTEXT, 2, 20);
  await method.observeBeat!(report({ firstSequence: 21, lastSequence: 22, toolNames: ["read_file"] }, 2));
  assert.equal(h.view().facts.filter(item => item.kind === "execution").length, 1);
  const tail = h.runtime();
  await h.field(tail, { ...CONTEXT, taskId: "old-tail" }, 1, 30);
  await tail.decide(adopt);
  await tail.observeBeat!({ ...report({ firstSequence: 1, lastSequence: 2, toolNames: ["read_file"] }), turnId: "old-tail" });
  assert.equal(h.view().facts.filter(item => item.kind === "execution").length, 1);
});

test("context round trips and cancelled control tools never become method execution traces", async () => {
  const h = harness(), method = h.runtime();
  await h.field(method);
  await method.decide(adopt);
  await h.field(method, CONTEXT, 2, 20);
  await method.context({ ...CONTEXT, opportunityId: "B" });
  await method.context(CONTEXT);
  await method.observeBeat!(report({ firstSequence: 21, lastSequence: 25, toolNames: ["read_file", "method_context"] }, 2));
  assert.equal(h.view().facts.some(item => item.kind === "execution"), false);
});

test("failed closure is fail-closed for this task until real replay, without contaminating another task", async () => {
  const h = harness(), method = h.runtime();
  await h.field(method);
  h.fail(true);
  await method.observeBeat!(report());
  await assert.rejects(method.decide(adopt), /adoption_window/);
  const unavailable = await method.slot("task", ["method_context"]);

  assert.equal(unavailable?.receipts.length, 0);
  assert.match(unavailable!.message.content, /正常分析/);
  await method.context({ ...CONTEXT, taskId: "other" });
  await assert.rejects(method.context(CONTEXT), /adoption_window_unavailable/);
  h.fail(false);
  await method.slot("task", ["method_context"], undefined, undefined, 20, SPAN);
  await method.context(CONTEXT);
  await assert.rejects(method.decide(adopt), /adoption_window_closed/);
});

test("a legitimate concurrent adoption removes stale local closure on reconciliation", async () => {
  const h = harness(), method = h.runtime();
  await h.field(method);
  await method.decide(adopt);
  const local = new Set([adoptionUnitKey({ versionId: V, taskId: "task" })]);
  await closeMissedAdoptionWindows({ store: h.store, emit: () => {}, correct: async () => {}, revise: async () => {} }, "task", SPAN, local);
  assert.equal(local.size, 0);
  assert.equal(h.view().facts.some(item => item.kind === "adoption_window_closed"), false);
});

test("the synchronous append construction rechecks an adoption already in flight when settlement closes", async () => {
  const h = harness();
  let release!: () => void, entered!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  let gate = true;
  const store: ExperienceStore = { load: h.store.load, append: async make => {
    if (gate) {
      gate = false;
      entered();
      await blocked;
    }
    return h.store.append(make);
  } };
  const method = h.runtime(store);
  await h.field(method);
  const pending = method.decide(adopt);
  await started;
  await method.observeBeat!(report());
  release();
  await assert.rejects(pending, /adoption_window/);
  assert.equal(h.view().facts.some(item => item.kind === "decision" && item.decision.action === "adopt"), false);
});

function observation(index: number): MethodObservation {
  return { observationId: `o${index}`, taskId: `origin${index}`, opportunityId: "use", versionId: V, scopeId: S,
    sequence: index + 1, revision: 0, adoption: "adopted", outcome: "helped", source: "self_report", features: { format: "json" } };
}

test("source correction replaces one outcome: 10→9/1 and 100→99/1 retain the remaining evidence", async () => {
  for (const count of [10, 100]) {
    const h = harness();
    h.set({ ...h.view(), sequence: count + 2, observations: Array.from({ length: count }, (_v, i) => observation(i)) });
    const method = h.runtime();
    await method.correct({ observationId: "o0", outcome: "unhelpful", reason: "actual counterexample" });
    const snapshot = snapshotOf(h.view(), scopesOf(h.view(), V)[0]!.hypothesis);
    assert.equal(snapshot.evidence.successes, count - 1);
    assert.equal(snapshot.evidence.failures, 1);
    assert.equal(h.view().facts.some(item => item.kind === "exit"), false);
    if (count === 100) assert.ok(snapshot.posterior.confidence > .95);
  }
});

test("correcting a former compilation or old source epoch cannot withdraw its successor", async () => {
  const h = harness(), initial = Array.from({ length: 10 }, (_v, i) => observation(i));
  const compact = { when: "JSON", action: "Inspect schema", exceptions: "Unknown: inspect" };
  const old: MethodExperienceFact = { kind: "review", factId: "C1", versionId: V, scopeId: S, sequence: 20,
    snapshotId: "s1", evidenceRevisions: initial.map(item => `${item.observationId}:0`),
    review: { decision: "promote", score: .9, reason: "prior qualified", sources: [V], compact } };
  const later = initial.map((item, i) => ({ ...item, observationId: `new${i}`, taskId: `new-task${i}`, sequence: 32 + i }));
  const fresh: MethodExperienceFact = { ...old, factId: "C2", sequence: 50, snapshotId: "s2", evidenceRevisions: later.map(item => `${item.observationId}:0`) };

  h.set({ ...h.view(), sequence: 50, observations: [...initial, ...later, { ...observation(11), observationId: "compiled-old", sequence: 22, compilationId: "C1" }],
    facts: [...h.view().facts, old, { kind: "exit", factId: "epoch", versionId: V, scopeId: S, sequence: 30, mode: "stable", reason: "real withdrawal" }, fresh] });
  const method = h.runtime();
  await method.correct({ observationId: "o0", outcome: "unhelpful", reason: "late source correction" });
  assert.equal(matureReview(h.view(), scopesOf(h.view(), V)[0]!.hypothesis)?.factId, "C2");
  await method.correct({ observationId: "compiled-old", outcome: "unhelpful", reason: "old compilation failed" });
  assert.equal(matureReview(h.view(), scopesOf(h.view(), V)[0]!.hypothesis)?.factId, "C2");
});
