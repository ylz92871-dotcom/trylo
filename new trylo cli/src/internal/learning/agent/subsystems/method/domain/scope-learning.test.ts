import { test } from "node:test";
import assert from "node:assert/strict";
import { isScopeHypothesis, matchesScope, scopeMatch, scopeEvidenceOf, scopePosteriorOf, scopePredicateKey as key, type ScopeHypothesis } from "./scope-learning.js";
import * as scopeLearning from "./scope-learning.js";
import type { MethodObservation } from "./inference-observations.js";
import { logMarginalOf } from "./inference.js";

const hypothesis: ScopeHypothesis = { id: "json", versionId: "v1", scopeId: "json", proposedSequence: 20,
  predicate: { all: [{ feature: "format", value: "json" }], exclude: [] } };

test("scope predicate identity is invariant to literal and object key order while preserving literal groups", () => {
  const original = { all: [{ feature: "format", value: "json" }, { feature: "platform", value: "windows" }],
    exclude: [{ feature: "encoding", value: "legacy" }, { feature: "mode", value: "unsafe" }] };
  const reordered = { all: [...original.all].reverse().map(item => ({ value: item.value, feature: item.feature })),
    exclude: [...original.exclude].reverse().map(item => ({ value: item.value, feature: item.feature })) };

  assert.equal(key(original), key(reordered));
  assert.notEqual(key(original), key({ all: original.all.slice(1), exclude: [...original.exclude, original.all[0]!] }));
  assert.throws(() => scopePosteriorOf([{ ...hypothesis, predicate: original },
    { ...hypothesis, id: "same-range-reordered", scopeId: "other", predicate: reordered }], []), /duplicate_scope_hypothesis/);
});

function observation(index: number, format: string, helped: boolean): MethodObservation {
  return { observationId: `o${index}`, taskId: `t${index}`, opportunityId: "main", versionId: "v1", scopeId: "original",
    sequence: index, revision: 0, adoption: "adopted", outcome: helped ? "helped" : "unhelpful", source: "self_report", features: { format } };
}

test("scope predicates are bounded, validated and fail closed on unknown facts", () => {
  assert.equal(isScopeHypothesis(hypothesis), true);
  assert.equal(isScopeHypothesis({ ...hypothesis, proposedSequence: -1 }), false);
  assert.equal(isScopeHypothesis({ ...hypothesis, predicate: { all: [], exclude: [] } }), false);
  assert.equal(isScopeHypothesis({ ...hypothesis, predicate: { all: [...hypothesis.predicate.all, ...hypothesis.predicate.all], exclude: [] } }), false);
  assert.equal(matchesScope(hypothesis.predicate, {}), false);
  assert.equal(matchesScope(hypothesis.predicate, { format: "csv" }), false);
  assert.equal(matchesScope(hypothesis.predicate, { format: "json" }), true);
  assert.equal(matchesScope({ all: [], exclude: [{ feature: "format", value: "csv" }] }, {}), false);
});

test("missing scope conditions remain unresolved and expose required versus excluded literals without invented truth", () => {
  const diagnose: unknown = Reflect.get(scopeLearning, "unresolvedScopeConditions");

  assert.equal(typeof diagnose, "function");

  if (typeof diagnose !== "function") return;

  const predicate = { all: [{ feature: "format", value: "json" }], exclude: [{ feature: "encoding", value: "legacy" }] };
  const unknown = Object.freeze({});

  assert.equal(scopeMatch(predicate, unknown), "unknown");
  assert.deepEqual(diagnose(predicate, unknown), [
    { relation: "required", feature: "format", expectedValue: "json" },
    { relation: "excluded", feature: "encoding", expectedValue: "legacy" },
  ]);
  assert.deepEqual(unknown, {}, "diagnostics cannot fill a predicate's expected values into observed facts");
  assert.equal(matchesScope(predicate, { format: "json" }), false, "missing exclusion facts keep the existing fail-closed result");
  assert.deepEqual(diagnose(predicate, { format: "json" }), [{ relation: "excluded", feature: "encoding", expectedValue: "legacy" }]);
  assert.equal(scopeMatch(predicate, { format: "csv", encoding: "utf8" }), "mismatch");
  assert.equal(scopeMatch(predicate, { format: "json", encoding: "legacy" }), "mismatch");
  assert.equal(scopeMatch(predicate, { format: "csv" }), "mismatch", "a known required-condition contradiction is decisive despite other missing inputs");
  assert.equal(scopeMatch(predicate, { encoding: "legacy" }), "mismatch", "a known exclusion is decisive despite a missing required fact");
  assert.equal(scopeMatch(predicate, { format: "json" }), "unknown", "without a contradiction the missing exclusion fact stays unresolved");
  assert.deepEqual(diagnose(predicate, { format: "csv" }), [], "known positive contradiction must not request a missing exclusion fact");
  assert.deepEqual(diagnose(predicate, { encoding: "legacy" }), [], "known exclusion must not suggest filling a missing positive fact");
  assert.equal(scopeMatch(predicate, { format: "json", encoding: "utf8" }), "matched");
  assert.deepEqual(diagnose(predicate, { format: "json", encoding: "utf8" }), []);
});

test("unresolved exclusion facts remain outside the Bayesian common observation set", () => {
  const scope = { ...hypothesis, predicate: { all: [{ feature: "format", value: "json" }], exclude: [{ feature: "encoding", value: "legacy" }] } };
  const observations = [observation(21, "json", true),
    { ...observation(22, "json", true), features: { format: "json", encoding: "utf8" } },
    { ...observation(23, "csv", false), features: { format: "csv", encoding: "utf8" } }];
  assert.equal(scopePosteriorOf([scope], observations).observationCount, 2);
  assert.equal(scopeEvidenceOf(scope, observations).successes, 1);
});

test("retrospective scope selection never converts old successes into prospective evidence", () => {
  const history = Array.from({ length: 20 }, (_, i) => observation(i + 1, "json", true));

  assert.equal(scopeEvidenceOf(hypothesis, history).successes, 0);
  const future = [observation(21, "json", true), observation(22, "csv", false)];
  const scoped = scopeEvidenceOf(hypothesis, [...history, ...future]);

  assert.equal(scoped.successes, 1);
  assert.equal(scoped.failures, 0);
  assert.equal(scopeEvidenceOf(hypothesis, [...history, ...future], { sinceSequence: 21 }).successes, 0);
});

test("Bayesian partition hypotheses update likelihood, prediction and bounded normalized weights", () => {
  const stream = Array.from({ length: 40 }, (_, i) => observation(i + 21, i % 2 === 0 ? "json" : "csv", i % 2 === 0));
  const result = scopePosteriorOf([hypothesis], stream);
  const learned = result.hypotheses[0];

  assert.ok(learned !== undefined);
  assert.ok(learned.posteriorWeight > .999);
  assert.ok(learned.predictiveInside > .95);
  assert.ok(learned.predictiveOutside < .05);
  assert.ok(Math.abs(learned.posteriorWeight + result.baselineWeight - 1) < 1e-14);
  const uniform = scopePosteriorOf([hypothesis], stream.map(item => ({ ...item, outcome: "helped" as const })));

  assert.ok(uniform.baselineWeight > uniform.hypotheses[0]!.posteriorWeight);
});

test("all candidates compare the same postregistration observations and duplicates cannot split prior mass", () => {
  const later = { ...hypothesis, id: "csv", scopeId: "csv", proposedSequence: 40,
    predicate: { all: [{ feature: "format", value: "csv" }], exclude: [] } };
  const stream = Array.from({ length: 50 }, (_, i) => observation(i + 1, i % 2 === 0 ? "json" : "csv", i % 2 === 0));
  const result = scopePosteriorOf([hypothesis, later], stream);

  assert.equal(result.commonAfterSequence, 40);
  assert.equal(result.observationCount, 10);
  assert.throws(() => scopePosteriorOf([hypothesis, { ...hypothesis, id: "copy" }], stream));
  assert.throws(() => scopePosteriorOf(Array.from({ length: 5 }, () => hypothesis), stream));
  assert.equal(scopePosteriorOf([], stream).baselineWeight, 1);
});

test("integrated sequence likelihood equals independent product of prequential predictions", () => {
  let successes = 0;
  let failures = 0;
  let product = 1;

  for (const success of [true, true, false, true, false, false, true]) {
    product *= (success ? successes + 1 : failures + 1) / (successes + failures + 2);
    if (success) successes += 1;
    else failures += 1;
  }

  assert.ok(Math.abs(Math.exp(logMarginalOf({ successes, failures })) - product) < 1e-15);
});
