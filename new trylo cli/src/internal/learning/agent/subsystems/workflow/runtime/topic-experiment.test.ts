import assert from "node:assert/strict";
import test from "node:test";
import { createWorkflowTopicExperiment } from "./topic-experiment.js";
import { workflowTopicConditionHash } from "./topic-experiment.js";
import { workflowStudyFixture } from "./topic-experiment-fixture.test.js";
import { contentHashOf } from "../../../../control/hash.js";
import type { TopicExperimentRegistration } from "../../../../../integration/learning-topics/system.js";
import type { TopicPairedProbe } from "../../../../../integration/learning-topics/measurement-source.js";
import { workflowFeedback } from "./archive.js";

export function calibration(registration: TopicExperimentRegistration, scope: string, unit: string, spendId = "fixture-spend"): Parameters<TopicPairedProbe["run"]>[0] & { readonly purpose: "calibration" } {
  const policy = { ...registration.policy, scope, experimentRef: registration.descriptor.ref, experimentVersion: registration.descriptor.version, utilityUnit: unit };
  const protocolHash = contentHashOf({ policy, checkerVersion: registration.checkerVersion, executionVersion: registration.executionVersion });
  return { purpose: "calibration", signal: new AbortController().signal, expected: { purpose: "calibration", protocolHash,
    scope, domain: "workflow", allocationId: "allocation", valuationId: `calibration:${protocolHash}`, units: registration.policy.experimentUnits,
    spendId, claimId: `claim:${spendId}`, checkerVersion: registration.checkerVersion, executionVersion: registration.executionVersion } };
}

test("workflow extra experiment has an independently callable registration", () => {
  assert.equal(typeof createWorkflowTopicExperiment, "function");
});

test("frozen pair reads real SessionPort checks, seals, journal-recorded usage and Board feedback", async () => {
  const fx = await workflowStudyFixture();
  try {
    const created = await createWorkflowTopicExperiment(fx.options);
    assert.ok(created.ok);
    const input = calibration(created.value, fx.options.task.scope, fx.options.objective.utilityUnit);
    const ref = await created.value.probe.run(input), outcome = await created.value.probe.read(ref, input.expected, input.signal);

    assert.equal(outcome?.kind, "measured");
    if (outcome?.kind !== "measured") throw new Error(JSON.stringify(outcome));

    assert.equal(outcome.fullStudyCost, 0.21, "fixture total input+output bill is distinct from the 40-output-token cap");
    assert.ok(outcome.candidateUtility > outcome.baselineUtility);
    assert.equal(fx.calls(), 2);
    const provenance = JSON.parse(outcome.provenanceJson!);

    assert.equal(provenance.outputAllowance.unit, "provider_output_tokens");
    assert.equal(provenance.arms[0].cost.tokens, 105);
    assert.ok(!outcome.provenanceJson!.includes(fx.options.sourceCase.inputText));

    for (const id of [fx.baselineVersionId, fx.candidateVersionId]) {
      const feedback = await workflowFeedback(fx.boardRoot, id);
      assert.ok(feedback.ok);
      assert.equal(feedback.value.length, 1);
    }

    assert.equal(await created.value.probe.run(input), ref);
    assert.equal(fx.calls(), 2);
  } finally { await fx.cleanup(); }
});

test("mismatched input/task/version/seal, refusal and unknown/overrun usage remain unknown", async () => {
  for (const fault of ["wrong_input", "wrong_task", "wrong_version", "extra_turn", "bad_seal", "refused", "uncertain", "overrun", "throws"] as const) {
    const fx = await workflowStudyFixture(fault);
    try {
      const created = await createWorkflowTopicExperiment(fx.options);
      assert.ok(created.ok);
      const input = calibration(created.value, fx.options.task.scope, fx.options.objective.utilityUnit);
      const ref = await created.value.probe.run(input), result = await created.value.probe.read(ref, input.expected, input.signal);

      assert.equal(result?.kind, "unknown", fault);
      assert.equal(fx.calls(), 1, fault);
      const provenance = JSON.parse(result!.provenanceJson!);

      assert.equal(provenance.attempts.length, 2);
      assert.equal(provenance.attempts[1].status, "not_started");
      assert.equal(typeof provenance.attempts[0].sessionId, "string");
      assert.equal(provenance.arms.length, 0);
    } finally { await fx.cleanup(); }
  }
});

test("a real failed check may be measured as failure without manufacturing successful experience", async () => {
  const fx = await workflowStudyFixture("check_failed");
  try {
    const created = await createWorkflowTopicExperiment(fx.options);
    assert.ok(created.ok);
    const input = calibration(created.value, fx.options.task.scope, fx.options.objective.utilityUnit);
    const ref = await created.value.probe.run(input), result = await created.value.probe.read(ref, input.expected, input.signal);
    assert.equal(result?.kind, "measured");
    const feedback = await workflowFeedback(fx.boardRoot, fx.candidateVersionId);
    assert.ok(feedback.ok);
    assert.equal(feedback.value[0]?.outcome, "failure");
  } finally { await fx.cleanup(); }
});

test("collection and abort gates precede evidence reads; malformed policy is a typed failure", async () => {
  const fx = await workflowStudyFixture();
  try {
    fx.setCollect(false);
    const disabled = await createWorkflowTopicExperiment(fx.options);
    assert.equal(disabled.ok, false);

    if (!disabled.ok) assert.equal(disabled.code, "collection_disabled");
    assert.equal(fx.reads(), 0);
    fx.setCollect(true);
    const abort = new AbortController();
    abort.abort();
    const cancelled = await createWorkflowTopicExperiment({ ...fx.options, signal: abort.signal });

    assert.equal(cancelled.ok, false);
    if (!cancelled.ok) assert.equal(cancelled.code, "cancelled");
    assert.equal(fx.reads(), 0);
    const bad = await createWorkflowTopicExperiment({ ...fx.options, policy: { ...fx.options.policy, priorWeights: undefined } } as never);

    assert.equal(bad.ok, false);
    if (!bad.ok) assert.equal(bad.code, "workflow_topic_configuration");

    const created = await createWorkflowTopicExperiment(fx.options);
    assert.ok(created.ok);
    fx.setCollect(false);
    await assert.rejects(created.value.probe.run(calibration(created.value, fx.options.task.scope, fx.options.objective.utilityUnit)));
    assert.equal(fx.reads(), 0);
    assert.equal(fx.calls(), 0);
  } finally { await fx.cleanup(); }
});

test("protocol identity freezes objective, output limits and checker/executor versions, excluding grant/case identity", async () => {
  const fx = await workflowStudyFixture();
  try {
    const hash = workflowTopicConditionHash(fx.options);

    assert.equal(workflowTopicConditionHash({ ...fx.options, outputAllowance: { ...fx.options.outputAllowance, grantId: "another" } }), hash);

    for (const changed of [{ ...fx.options, checkerVersion: "other" }, { ...fx.options, executionVersion: "other" },
      { ...fx.options, objective: { ...fx.options.objective, version: "other" } },
      { ...fx.options, outputAllowance: { ...fx.options.outputAllowance, pairMaxOutputTokens: 41 } }]) {
      assert.notEqual(workflowTopicConditionHash(changed), hash);
      assert.equal((await createWorkflowTopicExperiment(changed)).ok, false);
    }

    const created = await createWorkflowTopicExperiment(fx.options);
    assert.ok(created.ok);
    const input = calibration(created.value, fx.options.task.scope, fx.options.objective.utilityUnit);

    await assert.rejects(created.value.probe.run({ ...input, expected: { ...input.expected, protocolHash: "0".repeat(64) } }));
    await assert.rejects(created.value.probe.run({ ...input, expected: { ...input.expected, unexpected: true } } as never));
    const { purpose: _purpose, protocolHash: _protocolHash, ...common } = input.expected;
    const question = { purpose: "question" as const, signal: input.signal,
      expected: { ...common, questionId: "workflow-question", modelHash: "a".repeat(64), decisionBasisHash: "b".repeat(64) },
      topic: { schemaVersion: 3 as const, kind: "learning_topic" as const, status: "grounded_question" as const,
        topicId: "workflow-question", scope: fx.options.task.scope, domain: "workflow" as const,
        basis: { boardSequence: 0, evidenceWindowHash: "c".repeat(64) }, question: "Compare frozen paths", whenRelevant: "same task",
        expectedChange: "checked use", citations: [], experiment: created.value.descriptor } };

    await assert.rejects(created.value.probe.run(question), /workflow_topic_deployment_projection_unbound/);
    assert.equal(fx.calls(), 0);
    assert.equal(fx.reads(), 0);
  } finally { await fx.cleanup(); }
});
