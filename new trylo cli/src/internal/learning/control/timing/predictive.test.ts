import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { sha256Hex } from "../hash.js";
import { analyzeLearningTiming } from "./predictive.js";
import type { PredictiveTimingAnalysis } from "./predictive.js";
import type { ExactLiteral } from "./exact.js";
import type { PredictiveActionInput, PredictiveTimingModel, PredictiveValueInput } from "./predictive-contract.js";

const closed = (id: string, firstControl: string, value: ExactLiteral | PredictiveValueInput): PredictiveActionInput => ({
  kind: "closed", id, firstControl, programRef: `program:${id}`,
  value: typeof value === "number" || typeof value === "string" ? [value, value] : value,
});
const frontier = (id: string, firstControl: string, upper: ExactLiteral): PredictiveActionInput => ({
  kind: "closed_upper_frontier", id, firstControl, frontierScopeRef: `frontier:${id}`, upper,
});
const edge = (id: string, firstControl: string, immediate: ExactLiteral,
  outcomes: readonly Readonly<{ observed: string; weight: ExactLiteral; next: string }>[]): PredictiveActionInput => ({
  kind: "edge", id, firstControl, operationRef: `operation:${id}`, firstLeg: "source-declared-feasible",
  immediate: [immediate, immediate], outcomeCoverage: "complete", outcomes,
});
const context = (id: string, actions: readonly PredictiveActionInput[], noMoreAction: string | null = null) => ({
  id, actionCoverage: "complete" as const, noMoreAction, actions,
});

function model(contexts: PredictiveTimingModel["contexts"], root = "root",
  reference: PredictiveTimingModel["reference"] = null): PredictiveTimingModel {
  return { schemaVersion: 1, modelKind: "finite_predictive_expected", sourceScope: "declared-contract-case",
    basisRef: "basis:contract-case", evaluationRef: "evaluation:same-terminal", utilityUnit: "case-utility",
    coverage: "complete-declared-family", root, reference, contexts };
}

function complementaryCase(): PredictiveTimingModel {
  const second = (id: string, zero: string, one: string) => context(id, [closed("stop", "no_more_processing", 2),
    edge("query-y", "query_y", -1, [{ observed: "y0", weight: 1, next: zero }, { observed: "y1", weight: 1, next: one }])], "stop");
  return model([context("root", [closed("now", "process", 2), closed("x-only", "query_x", 1),
    closed("y-only", "query_y", 1), edge("query-x", "query_x", -1,
      [{ observed: "x0", weight: 1, next: "x0" }, { observed: "x1", weight: 1, next: "x1" }])]),
    second("x0", "bad", "good"), second("x1", "good", "bad"),
    context("good", [closed("verified-response", "process", 10)]),
    context("bad", [closed("stop", "no_more_processing", 2)], "stop")]);
}

function partialCase(upper: ExactLiteral): PredictiveTimingModel {
  return model([context("root", [closed("now", "process", 6), frontier("retain-bound", "retain", upper),
    edge("await", "await_evidence", -1, [{ observed: "known", weight: 1, next: "known" },
      { observed: "unresolved", weight: 1, next: "unresolved" }])]),
    context("known", [closed("complete", "process", 4)]),
    context("unresolved", [frontier("no-more-bound", "no_more_processing", 8)], "no-more-bound")]);
}

interface SavedBound { low: string; high: string; }

interface SavedPolicy { action: string; children: { observed: string; policy: SavedPolicy }[]; }

interface SavedBridge {
  central_predictive_kernel: { prior: string[]; root: string; evaluation_ref: string; contexts: {
    identity: string; no_more_processing: SavedBound[]; actions: { name: string; conditional_immediate: SavedBound[];
      signals: { observed: string; conditional_probability: string[]; next_context: string }[] }[] }[] };
  new_root_complete_values: Record<string, SavedBound>; new_lower_policy: SavedPolicy;
}

const literal = (value: string): ExactLiteral => value.includes("/") ? value : `${value}/1`;
const bound = (values: SavedBound[]): PredictiveValueInput => {
  assert.equal(values.length, 1);
  return [literal(values[0]!.low), literal(values[0]!.high)];
};

/** Test-only saved declaration adapter. Run from new trylo cli; no old source/solver executes. */
async function savedCurvedCase() {
  const source = await readFile(resolve("../_workspace/tasks/legacy-work/learning-timing-20261104/research/predictive_kernel_bridge_results.json"), "utf8");

  assert.equal(sha256Hex(source), "7c42a6e4880b636d5f0221b9a9de63a6c0feeb34742729af230fce593e650dc1");
  const saved = JSON.parse(source) as SavedBridge, kernel = saved.central_predictive_kernel;

  assert.deepEqual(kernel.prior, ["1"]);
  const contexts = kernel.contexts.map(item => {
    const actions: PredictiveActionInput[] = item.actions.map(row => row.signals.length === 0
      ? { kind: "closed", id: row.name, firstControl: row.name,
        programRef: `${kernel.evaluation_ref}:${item.identity}:${row.name}`, value: bound(row.conditional_immediate) }
      : { kind: "edge", id: row.name, firstControl: row.name, operationRef: `${item.identity}:${row.name}`,
        firstLeg: "source-declared-feasible", immediate: bound(row.conditional_immediate), outcomeCoverage: "complete",
        outcomes: row.signals.map(signal => {
          assert.equal(signal.conditional_probability.length, 1);
          return { observed: signal.observed, weight: literal(signal.conditional_probability[0]!), next: signal.next_context };
        }) });

    actions.push({ kind: "closed", id: "no_more_processing", firstControl: "no_more_processing",
      programRef: `${item.identity}:saved-complete-no-more`, value: bound(item.no_more_processing) });

    return { id: item.identity, actionCoverage: "complete" as const, noMoreAction: "no_more_processing", actions };
  });
  const root = kernel.contexts.find(item => item.identity === kernel.root)!;
  const model: PredictiveTimingModel = { schemaVersion: 1, modelKind: "finite_predictive_expected", sourceScope: "saved-curved-T4",
    basisRef: `saved:${sha256Hex(source)}`, evaluationRef: kernel.evaluation_ref, utilityUnit: "declared-utility",
    coverage: "complete-declared-family", root: kernel.root,
    reference: { scopeRef: "saved-explicit-root-no-more", value: bound(root.no_more_processing) }, contexts };

  // Expected answers are returned separately; they never feed adaptation above.
  return { model, expectedValues: Object.fromEntries(Object.entries(saved.new_root_complete_values).map(([id, value]) =>
    [id, { low: literal(value.low), high: literal(value.high) }])), expectedPolicy: saved.new_lower_policy };
}

const analyze = (input: unknown, options?: unknown): PredictiveTimingAnalysis => {
  const result = analyzeLearningTiming(JSON.stringify(input), options);
  if (result.status !== "analyzed") assert.fail(JSON.stringify(result));
  return result;
};
const node = (result: PredictiveTimingAnalysis, id = result.root) => {
  const found = result.contexts.find(item => item.context === id);
  assert.ok(found);
  return found;
};

function unroll(result: PredictiveTimingAnalysis, id = result.root): SavedPolicy {
  const witness = node(result, id).lowerWitness;
  assert.ok(witness);
  return { action: witness.action, children: witness.children.map(child => ({ observed: child.observed,
    policy: unroll(result, child.nextContext) })) };
}

const noPartial = (result: ReturnType<typeof analyzeLearningTiming>) => {
  for (const key of ["value", "contexts", "bestKnownLowerWitness", "firstControlCertificate"]) assert.equal(Object.hasOwn(result, key), false);
};

test("new predictive implementation preserves the saved curved declaration's four values and complete observed policy", async () => {
  const saved = await savedCurvedCase(), result = analyze(saved.model), root = node(result);

  assert.deepEqual(Object.fromEntries(root.actions.map(action => [action.id, action.value])), saved.expectedValues);
  assert.deepEqual(unroll(result), saved.expectedPolicy);
  assert.equal(result.visitedContexts, 17);
  assert.deepEqual(result.firstControlCertificate, { strict: [], nonInferior: ["active-wait", "retain"],
    exactOptimalTies: ["active-wait", "retain"], exactTieExhaustive: true });
  const wait = root.actions.find(action => action.id === "active-wait")!;

  assert.deepEqual(wait.immediate, { low: "-1/64", high: "-1/64" });
  assert.deepEqual(wait.children.map(child => child.weightedContribution),
    [{ low: "47/128", high: "47/128" }, { low: "43/128", high: "43/128" }]);
});

test("a complete sequential policy retains complementary observation continuations", () => {
  const result = analyze(complementaryCase()), root = node(result);
  assert.deepEqual(root.actions.find(action => action.id === "x-only")!.value, { low: "1/1", high: "1/1" });
  assert.deepEqual(root.actions.find(action => action.id === "query-x")!.value, { low: "4/1", high: "4/1" });
  assert.deepEqual(result.firstControlCertificate.strict, ["query_x"]);
  assert.equal(unroll(result).children.length, 2);
});

test("negative actual no-more and its explicit reference are never clamped to zero", () => {
  const result = analyze(model([context("root", [closed("stop", "no_more_processing", -2), closed("run", "process", -3)], "stop")],
    "root", { scopeRef: "negative-base", value: [-2, -2] }));
  assert.deepEqual(result.value, { low: "-2/1", high: "-2/1" });
  assert.deepEqual(result.increment, { low: "0/1", high: "0/1" });
  assert.deepEqual(result.firstControlCertificate.strict, ["no_more_processing"]);
});

test("upper-only frontiers exclude competitors without manufacturing an edge or no-more lower witness", () => {
  const certified = analyze(partialCase("11/2")), root = node(certified);

  assert.deepEqual(certified.firstControlCertificate.strict, ["process"]);
  const process = root.controls.find(control => control.firstControl === "process")!;

  assert.equal(process.competitorUpper, "11/2");
  assert.equal(process.guaranteedMargin, "1/2");
  assert.equal(root.actions.find(action => action.id === "await")!.value.low, null);
  const unresolved = node(certified, "unresolved");

  assert.equal(unresolved.noMoreAction, "no-more-bound");
  assert.equal(unresolved.witnessStatus, "no_witness");
  assert.equal(unresolved.gap, null);
  assert.equal(unresolved.lowerWitness, null);
  const open = analyze(partialCase(7));

  assert.deepEqual(open.value, { low: "6/1", high: "7/1" });
  assert.deepEqual(open.firstControlCertificate.nonInferior, []);
  const source = partialCase(7), child = source.contexts.find(item => item.id === "unresolved")!;
  const noWitness = analyze({ ...source, root: child.id, contexts: [child] });

  assert.equal(noWitness.witnessStatus, "no_witness");
  assert.equal(noWitness.value.low, null);
  assert.equal(noWitness.gap, null);
  assert.equal(noWitness.bestKnownLowerWitness, null);
  assert.deepEqual(noWitness.firstControlCertificate.strict, []);
});

test("fraction literals preserve a rare positive branch below binary64 range and skip only exact zero", () => {
  const denominator = `1${"0".repeat(330)}`, payoff = `2${"0".repeat(330)}`;
  const result = analyze(model([context("root", [closed("now", "process", "1/3"), edge("wait", "await_evidence", 0, [
    { observed: "rare", weight: `1/${denominator}`, next: "rare" }, { observed: "common", weight: 1, next: "common" },
    { observed: "impossible", weight: 0, next: "no-posterior" }])]),
    context("rare", [closed("complete", "process", `${payoff}/1`)]), context("common", [closed("stop", "no_more_processing", 0)], "stop")]));
  const expected = `${payoff}/${BigInt(denominator) + 1n}`;

  assert.deepEqual(result.value, { low: expected, high: expected });
  assert.deepEqual(result.firstControlCertificate.strict, ["await_evidence"]);
  assert.equal(result.visitedContexts, 3);
  assert.equal(node(result).actions.find(action => action.id === "wait")!.children.length, 2);
});

test("strict variant shapes and work limits fail without an apparent partial optimum", () => {
  const source = complementaryCase();
  const closedChild = { ...source, contexts: source.contexts.map((item, index) => index !== 0 ? item :
    { ...item, actions: [{ ...closed("bad", "process", 1), outcomes: [] }] }) };
  const bad = analyzeLearningTiming(JSON.stringify(closedChild));

  assert.equal(bad.status, "invalid_input");
  noPartial(bad);
  const limited = analyzeLearningTiming(JSON.stringify(source), { nodeLimit: 1 });

  assert.equal(limited.status, "planning_limit");
  noPartial(limited);
  const numeric = analyzeLearningTiming(JSON.stringify(model([context("root", [closed("large", "process", "65537/1")])])), { maxBits: 16 });

  assert.equal(numeric.status, "numeric_limit");
  noPartial(numeric);
  const invalidOptions = analyzeLearningTiming(JSON.stringify(source), { nodeLimit: null });

  assert.equal(invalidOptions.status, "invalid_input");
  noPartial(invalidOptions);
  const mixed = { ...source, contexts: [context("root", [closed("one", "process", 1)])].map(item =>
    ({ ...item, actions: item.actions.map(action => ({ ...action, firstControl: ["now", "retain"] })) })) };
  const mixedResult = analyzeLearningTiming(JSON.stringify(mixed));

  assert.equal(mixedResult.status, "unsupported_model");
  noPartial(mixedResult);
});
