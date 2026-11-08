import assert from "node:assert/strict";
import test from "node:test";
import { contentHashOf } from "../../../../../control/hash.js";
import { evaluateChecker, validateCheckEvaluation } from "../../domain/v2/evaluate.js";
import { requirementDigest } from "../../domain/v2/parse.js";
import type { CheckExperience, CheckInput, CheckRequirements, CheckSample, LearnedChecker } from "../../domain/v2/contracts.js";
import type { CheckerCatalog, CheckerCorrectionScope, CheckerFeedback, CheckerRun, CheckerVersion } from "./contracts.js";
import { deriveCheckerVersionQualification } from "./version-qualification.js";

const BASIS = { text: "Quantity must be nonnegative; zero is legal." };
const REQUIREMENTS: CheckRequirements = { ref: "qualification:quantity", digest: requirementDigest(BASIS), ...BASIS };
const SCOPE = "project:qualification";
const SOURCE = "owner:legacy-zero-is-legal", RUN = "run:legacy-false-positive";

function facts(qty: number): CheckInput {
  return { task: { instruction: "Check quantity.", requirementRef: REQUIREMENTS.ref, requirementDigest: REQUIREMENTS.digest },
    phase: "before_completion", output: { qty } };
}

function experience(id: string, qty: number): CheckExperience {
  return { schemaVersion: 2, type: "check_experience", id, scope: SCOPE, sessionId: "session:legacy", turnId: "turn:legacy",
    requirements: REQUIREMENTS, facts: facts(qty), priorRuns: [],
    assessment: { kind: "task_oracle", sourceRef: "oracle:" + id, verdict: qty >= 0 ? "valid" : "invalid" } };
}

async function fixture(appliesTo?: CheckerCorrectionScope) {
  const derived: CheckExperience = { ...experience("checker-judgment:" + contentHashOf([SOURCE, RUN]), 0), priorRuns: [RUN],
    assessment: { kind: "user_correction", sourceRef: SOURCE, verdict: "valid" } };
  const experiences = [experience("source-positive", 1), experience("source-negative", -1), derived, experience("holdout-negative", -2)];
  const samples: CheckSample[] = experiences.map((item, index) => ({ id: item.id, role: index < 2 ? "source" : "holdout",
    input: item.facts, expected: item.assessment!.verdict === "valid" ? "pass" : "fail", oracle: {
      kind: item.assessment!.kind, sourceRef: item.assessment!.sourceRef, requirementDigest: REQUIREMENTS.digest } }));
  const checker: LearnedChecker = { schemaVersion: 2, type: "learned_checker", question: "Is quantity nonnegative?",
    claim: "A fixed first-party fixture; not model generation.", source: "module.exports = input => input;",
    sourceRefs: [experiences[0]!.id], timing: ["before_completion"],
    applicability: { scope: SCOPE, requirementRef: REQUIREMENTS.ref, requirementDigest: REQUIREMENTS.digest,
      requiredKeys: ["qty"], excludedKeys: [], instructionIncludes: [] } };
  const evaluated = await evaluateChecker({ candidate: checker, samples, signal: new AbortController().signal,
    executor: { execute: async (_candidate, input) => {
      const sample = samples.find(row => contentHashOf(row.input) === contentHashOf(input));
      assert.ok(sample);
      return { kind: "value", value: { status: sample.expected, findings: sample.expected === "fail"
        ? [{ requirementRef: REQUIREMENTS.ref, message: "negative quantity" }] : [] } };
    } } });

  assert.ok(evaluated.ok && evaluated.value.status === "supported");
  const version: CheckerVersion = { schemaVersion: 2, type: "checker_version", checker, requirements: REQUIREMENTS,
    experienceRefs: ["asset:source-positive"], generation: { requestId: "fixed:qualification", model: "unit-fixture", usage: { inputTokens: 0, outputTokens: 0 } },
    evaluation: evaluated.value, validationSamples: samples };
  const run: CheckerRun = { schemaVersion: 2, type: "checker_run", runId: RUN, versionId: "asset:old-checker", scope: SCOPE,
    sessionId: "session:legacy", turnId: "turn:legacy", requirements: REQUIREMENTS, input: derived.facts, inputDigest: contentHashOf(derived.facts),
    outcome: { kind: "checked", verdict: { status: "fail", findings: [{ requirementRef: REQUIREMENTS.ref, message: "old false positive" }] } } };
  const feedback: CheckerFeedback = { schemaVersion: 2, type: "checker_feedback", sourceRef: SOURCE, scope: SCOPE,
    sessionId: run.sessionId, turnId: "turn:correction", text: "Zero is legal.", runIds: [RUN],
    judgment: { runId: RUN, expected: "pass" }, ...(appliesTo === undefined ? {} : { appliesTo }) };
  const catalog: CheckerCatalog = { experiences: experiences.map(value => ({ versionId: "asset:" + value.id, value })),
    versions: [{ versionId: "asset:supported-successor", value: version }], runs: [run], feedbacks: [feedback], runClaims: [],
    results: [], leases: [], generationStarts: [], generations: [], generationEvaluations: [] };

  return { catalog, version, samples, derived };
}

test("legacy default and explicit task labels withdraw supported qualification without changing historical bytes", async () => {
  for (const scope of [undefined, { kind: "task", sessionId: "session:legacy", turnId: "turn:legacy" }] as const) {
    const fx = await fixture(scope);
    const before = JSON.stringify(fx);
    assert.equal(deriveCheckerVersionQualification(fx.catalog, fx.version), "evidence_withdrawn");
    assert.equal(fx.version.evaluation!.status, "supported", "reported support still determines historical replacement lineage");
    assert.equal(JSON.stringify(fx), before);
  }
});

test("class and long-term owner labels remain shared evidence for their exact frozen standard", async () => {
  for (const kind of ["class", "long_term"] as const) {
    const fx = await fixture({ kind, requirementRef: REQUIREMENTS.ref, requirementDigest: REQUIREMENTS.digest });
    assert.equal(deriveCheckerVersionQualification(fx.catalog, fx.version), "supported");
  }
});

test("manual independent oracle labels for the same output are not withdrawn by an unrelated task correction", async () => {
  const fx = await fixture();
  for (const kind of ["task_oracle", "user_correction"] as const) {
    const independent: CheckExperience = { ...fx.derived, id: "manual:independent-zero", priorRuns: [],
      assessment: { kind, sourceRef: "oracle:independent-zero", verdict: "valid" } };
    const samples = fx.samples.map(sample => sample.id !== fx.derived.id ? sample : {
      ...sample, id: independent.id, oracle: { ...sample.oracle, kind, sourceRef: independent.assessment!.sourceRef } });
    const catalog = { ...fx.catalog, experiences: [...fx.catalog.experiences, { versionId: "asset:manual-zero", value: independent }] };
    const evaluation = { ...fx.version.evaluation!, samplesHash: contentHashOf(samples), cases: fx.version.evaluation!.cases.map(row =>
      row.sampleId === fx.derived.id ? { ...row, sampleId: independent.id } : row) };

    assert.ok(validateCheckEvaluation(evaluation, samples, fx.version.checker));
    assert.equal(deriveCheckerVersionQualification(catalog, { ...fx.version, evaluation, validationSamples: samples }), "supported");
  }
});

test("working, rejected, incomplete and cancelled reports remain distinct from supported qualification", async () => {
  const fx = await fixture({ kind: "class", requirementRef: REQUIREMENTS.ref, requirementDigest: REQUIREMENTS.digest });
  const { evaluation, validationSamples: _samples, ...working } = fx.version;

  assert.ok(evaluation);
  assert.equal(deriveCheckerVersionQualification(fx.catalog, working), "working");

  for (const status of ["rejected", "incomplete", "cancelled"] as const) {
    assert.equal(deriveCheckerVersionQualification(fx.catalog, { ...fx.version, evaluation: { ...evaluation, status } }), "rejected");
  }
});

test("withdrawal is bound to exact sample identity, oracle, facts and project rather than a matching answer alone", async () => {
  const fx = await fixture();
  for (const changed of [{ ...fx.derived, id: "manual:distinct-identity" },
    { ...fx.derived, scope: "project:other" }, { ...fx.derived, facts: facts(7) },
    { ...fx.derived, assessment: { kind: "task_oracle" as const, sourceRef: SOURCE, verdict: "valid" as const } }]) {
    const catalog = { ...fx.catalog, experiences: fx.catalog.experiences.map(row => row.value.id === fx.derived.id ? { ...row, value: changed } : row) };
    assert.equal(deriveCheckerVersionQualification(catalog, fx.version), "supported");
  }
});
