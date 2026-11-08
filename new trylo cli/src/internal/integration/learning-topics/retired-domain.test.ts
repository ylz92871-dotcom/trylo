import assert from "node:assert/strict";
import test from "node:test";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTopicLearningSystem, type TopicExperimentRegistration, type TopicLearningConfiguration } from "./system.js";
import { createPersistentTopicIntake } from "./intake.js";
import { createBoardReader, withBoardWriter } from "../../adapters/learning-store/file-event-store.js";
import { isTopicExperimentDescriptor } from "../../learning/domains/shared/topics/parse.js";

function configuration(): TopicLearningConfiguration {
  return { policy: { poolId: "retirement-contract", algorithmVersion: "retirement-contract-v1", totalQuota: 1,
    utilityUnit: "declared-utility", quotaUnit: "checked-unit" }, perTurnQuota: 1, experiments: [], domainRelation: "separable" };
}

function registration(): TopicExperimentRegistration {
  return { descriptor: { ref: "retired-routing-study", version: "1", domain: "routing", purpose: "Old routing study" },
    policy: { conditionHash: "a".repeat(64), futureUses: 1, utilityScale: 1, experimentUnits: 1,
      deltaBounds: { minimum: -1, maximum: 1 }, priorStrength: 2, priorWeights: [0.25, 0.25, 0.25, 0.25] },
    checkerVersion: "checker-v1", executionVersion: "executor-v1",
    probe: { async run() { throw new Error("retired_probe_must_not_run"); }, async read() { return undefined; } } };
}

const system = (config: TopicLearningConfiguration) => createTopicLearningSystem({
  boardRoot: "unused-retirement-contract", scope: "retirement-contract", enabled: () => true, configuration: config });

test("retired routing cannot register a new fixed topic experiment", () => {
  assert.throws(() => system({ ...configuration(), experiments: [registration()] }), { message: "topic_system_experiment" });
});

test("retired routing cannot register a dynamic topic domain model", () => {
  assert.throws(() => system({ ...configuration(), domainModels: [{ domain: "routing", available: () => false,
    async prepare() { throw new Error("retired_model_must_not_run"); } }] }), { message: "topic_system_domain_models" });
});

test("retired routing cannot receive a new calibration allowance", () => {
  assert.throws(() => system({ ...configuration(), calibration: { quota: 1, domains: ["routing"] } }),
    { message: "topic_system_calibration_policy" });
});

test("retired routing topic intake rejects before creating a Board", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "retired-topic-intake-")), boardRoot = path.join(root, "absent-board");

  t.after(() => rm(root, { recursive: true, force: true }));
  const intake = createPersistentTopicIntake({ boardRoot, scope: "retirement-contract", domain: "routing",
    algorithmVersion: "retired-intake-v1", enabled: () => true });
  const window = { schemaVersion: 1, domain: "routing", scope: "retirement-contract", boardSequence: 0,
    watermarks: [{ runId: "historic-run", throughSequence: 1 }], records: [{ ref: "execution", runId: "historic-run", sequence: 1,
      scope: "retirement-contract", origin: "execution_result", text: "The old reader failed on this public input." }] };
  const proposal = { schemaVersion: 2, question: "Which reader should be used?", whenRelevant: "The same input conditions recur",
    expectedChange: "Choose the checked path", citations: [{ evidenceRef: "execution", quote: "old reader failed" }] };

  assert.deepEqual(await intake.ingest(JSON.stringify(proposal), JSON.stringify(window)),
    { status: "rejected", reason: "topic_domain_retired" });
  await assert.rejects(access(boardRoot));
});

test("historical routing vocabulary and Board commits remain readable without an active learner", async t => {
  assert.equal(isTopicExperimentDescriptor(registration().descriptor), true, "the historical parser retains its canonical vocabulary");
  const root = await mkdtemp(path.join(tmpdir(), "retired-routing-history-")), boardRoot = path.join(root, "board");

  t.after(() => rm(root, { recursive: true, force: true }));
  const content = JSON.stringify({ schemaVersion: 1, decisionPoint: "read_file.strategy.v1", historical: true });
  const written = await withBoardWriter(boardRoot, async store => {
    const issuedAt = "2026-11-03T00:00:00.000Z", proposalId = "historical-routing-proposal";
    const proposed = await store.apply({ type: "submit_proposal", commandId: "history:submit", issuedAt, proposal: {
      proposalId, domain: "routing", assetKind: "routing_policy", scope: "retirement-contract", candidateRef: "historical-v1",
      hypothesis: "Historical routing record", risk: "low", source: "inferred", requestedAuthorities: [], requiredVerifiers: [], observationRefs: [] } });

    assert.equal(proposed.ok, true);
    assert.equal((await store.apply({ type: "quarantine", commandId: "history:quarantine", issuedAt, proposalId })).ok, true);
    assert.equal((await store.apply({ type: "start_evaluation", commandId: "history:evaluate", issuedAt, proposalId })).ok, true);

    return store.apply({ type: "commit_asset", commandId: "history:commit", issuedAt, proposalId, versionId: "historical-v1", schemaVersion: 1, content });
  });

  assert.equal("ok" in written && written.ok, true);
  const loaded = await createBoardReader(boardRoot).load();
  assert.ok(loaded.ok);

  if (!loaded.ok) return;

  assert.equal(loaded.state.assets[0]!.kind, "routing_policy");
  assert.equal(loaded.state.assets[0]!.content, content);
  assert.equal(loaded.state.proposals[0]!.domain, "routing");
  assert.equal(loaded.state.activations.length, 0);
});
