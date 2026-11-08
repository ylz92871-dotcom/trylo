import assert from "node:assert/strict";
import test from "node:test";
import { createBoardReader } from "../../../../../adapters/learning-store/file-event-store.js";
import { createTopicLearningSystem, type TopicExperimentRegistration } from "../../../../../integration/learning-topics/system.js";
import { topicMeasurements } from "../../../../../integration/learning-topics/measurement-source.js";
import { createWorkflowTopicExperiment } from "./topic-experiment.js";
import { workflowStudyFixture } from "./topic-experiment-fixture.test.js";
import { runWorkflowLearning } from "./runtime.js";
import { readWorkflowVersion } from "./archive.js";

function system(fx: Awaited<ReturnType<typeof workflowStudyFixture>>, registration: TopicExperimentRegistration) {
  return createTopicLearningSystem({ boardRoot: fx.boardRoot, scope: fx.options.task.scope, enabled: fx.options.collect,
    configuration: { policy: { poolId: "explicit-fixture-study-pool", algorithmVersion: "fixture-pool-v1", totalQuota: 4,
      utilityUnit: fx.options.objective.utilityUnit, quotaUnit: "fixture-checked-pair" }, perTurnQuota: 1, domainRelation: "separable",
    experiments: [registration], calibration: { quota: 1, domains: ["workflow"] } } });
}

test("central Board owns quota and measurement; rebuilding the same request spends neither again", async () => {
  const fx = await workflowStudyFixture();
  try {
    const registration = await createWorkflowTopicExperiment(fx.options);
    assert.ok(registration.ok);
    const result = await system(fx, registration.value).invoke({ requestId: "study-one", totalQuota: 1 }, new AbortController().signal);

    assert.equal(result.status, "completed", JSON.stringify(result));
    assert.equal(result.purpose, "calibration");
    assert.equal(fx.calls(), 2);
    const recreated = await createWorkflowTopicExperiment(fx.options);
    assert.ok(recreated.ok);
    const again = await system(fx, recreated.value).invoke({ requestId: "study-one", totalQuota: 1 }, new AbortController().signal);

    assert.equal(again.status, "previous");
    assert.equal(fx.calls(), 2);
    const board = await createBoardReader(fx.boardRoot).load();
    assert.ok(board.ok);
    const measurements = topicMeasurements(board.state.rewardV2Facts ?? [], fx.options.task.scope);

    assert.equal(measurements.length, 1);
    assert.equal(measurements[0]?.kind, "measured");
    const claims = (board.state.rewardV2Facts ?? []).filter(row => JSON.parse(row.payloadJson).type === "ws1_topic_claim");

    assert.equal(claims.length, 1);
    assert.equal(JSON.parse(claims[0]!.payloadJson).units, 1);
    assert.equal(fx.options.outputAllowance.pairMaxOutputTokens, 40, "one quota unit was never converted to output tokens");
  } finally { await fx.cleanup(); }
});

test("same physical output grant under a new central request is not a second measurement", async () => {
  const fx = await workflowStudyFixture();
  try {
    const one = await createWorkflowTopicExperiment(fx.options);
    assert.ok(one.ok);
    await system(fx, one.value).calibrate({ requestId: "physical-one", domain: "workflow", quota: 1 }, new AbortController().signal);
    const two = await createWorkflowTopicExperiment(fx.options);
    assert.ok(two.ok);
    await system(fx, two.value).calibrate({ requestId: "physical-rebound", domain: "workflow", quota: 1 }, new AbortController().signal);
    assert.equal(fx.calls(), 2);
    const board = await createBoardReader(fx.boardRoot).load();
    assert.ok(board.ok);
    assert.equal(topicMeasurements(board.state.rewardV2Facts ?? [], fx.options.task.scope).length, 1, "physical facts cannot become another sample by changing expected/claim");
  } finally { await fx.cleanup(); }
});

test("an unknown study is not retried after reconstruction and does not block the ordinary workflow library", async () => {
  const fx = await workflowStudyFixture("uncertain");
  try {
    const created = await createWorkflowTopicExperiment(fx.options);
    assert.ok(created.ok);
    const first = await system(fx, created.value).invoke({ requestId: "unknown-one", totalQuota: 1 }, new AbortController().signal);

    assert.equal(first.status, "unknown");
    assert.equal(fx.calls(), 1);
    const recreated = await createWorkflowTopicExperiment(fx.options);
    assert.ok(recreated.ok);
    const next = await system(fx, recreated.value).invoke({ requestId: "unknown-one", totalQuota: 1 }, new AbortController().signal);

    assert.equal(next.status, "previous");
    assert.equal(fx.calls(), 1);
    const baseline = await readWorkflowVersion(fx.boardRoot, fx.baselineVersionId);
    assert.ok(baseline.ok);
    const ordinary = await runWorkflowLearning({ boardRoot: fx.boardRoot, issuedAt: fx.options.issuedAt, request: { ...fx.options.task,
      requestId: "ordinary-after-unknown", subsystem: "workflow", collect: true, budget: { maxEpisodes: 8, maxSteps: 32, maxTokens: 16000 },
      traces: [], parentVersionId: fx.baselineVersionId } });

    assert.ok(ordinary.ok);
    assert.equal(ordinary.value.mode, "path");
    assert.equal(ordinary.value.providerCalls, 0);
  } finally { await fx.cleanup(); }
});
