import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FileSystemReader } from "../../adapters/tools/read-only/limits.js";
import { DEFAULT_READ_ONLY_LIMITS } from "../../adapters/tools/read-only/limits.js";
import { createNodeFileSystemReader } from "../../adapters/tools/read-only/node-fs.js";
import { executeReadFile } from "../../adapters/tools/read-only/read-file.js";
import type { ReadRoutingOpportunity, ReadRoutingPort, ReadRoutingTrial } from "../../ports/read-routing.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { rewardRecordsOf } from "../../learning/control/reward-records.js";
import { readStrategyObservations, latestReadStrategyAsset, readStrategyBoard, readStrategyPolicyOf,
  createReadStrategyRuntime, createDefaultReadTopicConfiguration, readStrategyExecution, readPairUtility,
  READ_STRATEGY_COST_METRIC } from "../../learning/agent/subsystems/tool/read-strategy/index.js";
import { buildEmpiricalTopicModel, type TopicPairedMeasurement } from "../../learning/domains/shared/topics/empirical-model.js";
import { createRewardBoardPort } from "../reward/board-port.js";
import { createTopicLearningSystem } from "./system.js";
import { createPersistentTopicIntake } from "./intake.js";
import { topicMeasurements } from "./measurement-source.js";
import { readPoolClaim } from "./pool-ledger.js";
import { comparisonEvidenceRecord } from "./comparison-evidence.js";

const signal = () => new AbortController().signal;
const SCOPE = "read-mainline-project";
const CONTENT = "alpha\nbeta\ngamma\n";
const ioWork = (bytes: number, milliseconds: number) => bytes + 1024 * milliseconds;

async function harness(t: { after: (fn: () => Promise<void>) => void }, initiallyEnabled = true) {
  const root = await mkdtemp(path.join(os.tmpdir(), "trylo-read-mainline-")), boardRoot = path.join(root, "board");

  t.after(() => rm(root, { recursive: true, force: true }));
  let enabled = initiallyEnabled, epoch = 1800000000000, reads = 0, trials = 0, generation = 0;
  const actualTrials: ReadRoutingTrial[] = [];
  // This clock provides deterministic event ordering, not evidence of physical latency gains.
  const nowMs = () => epoch++;
  const collect = () => enabled, node = createNodeFileSystemReader();
  const reader: FileSystemReader = { ...node,

    readFileUtf8: async (...args) => {
      reads += 1;
      return node.readFileUtf8(...args);
    },

    readFileUtf8Bounded: async (...args) => {
      reads += 1;
      return node.readFileUtf8Bounded!(...args);
    },

    readFileChunks: async function* (...args) {
      reads += 1;
      yield* node.readFileChunks!(...args);
    } };

  function compose() {
    const strategy = createReadStrategyRuntime({ boardRoot, scope: SCOPE, sessionId: `mainline-session-${generation}`,
      turnId: `mainline-turn-${generation++}`, enabled: true, collect, nowMs });
    const topics = createDefaultReadTopicConfiguration({ boardRoot, scope: SCOPE, collect, nowMs });

    topics.bindRuntime(strategy);
    const system = createTopicLearningSystem({ boardRoot, scope: SCOPE, enabled: collect, configuration: topics.configuration });
    const intake = createPersistentTopicIntake({ boardRoot, scope: SCOPE, domain: "tool", enabled: collect,
      algorithmVersion: "read-mainline-test-intake-v1" });
    const offered: ReadRoutingOpportunity[] = [];
    const port: ReadRoutingPort = { choose: strategy.choose.bind(strategy), record: strategy.record.bind(strategy),

      offer(opportunity) {
        const actual = Object.freeze({ ...opportunity, trial: async (...args: Parameters<ReadRoutingOpportunity["trial"]>) => {
          trials += 1;
          const result = await opportunity.trial(...args);
          actualTrials.push(Object.freeze({ ...result }));
          return result;
        } });
        offered.push(actual);
        topics.offer(actual);
      } };

    async function read(id: string, file: string) {
      const result = await executeReadFile({ workspaceRoot: root, reader, readRouting: port, nowMs }, DEFAULT_READ_ONLY_LIMITS,
        { name: "read_file", toolCallId: id, arguments: { path: file, offset: 0, limit: 1 } }, signal());
      assert.equal(result.outcome, "result", "ordinary real file read must succeed");
      return result;
    }

    async function ordinary(id: string, text = CONTENT) {
      const file = `${id}.txt`;
      await writeFile(path.join(root, file), text);
      return read(id, file);
    }

    async function admitQuestion() {
      const state = await readStrategyBoard(boardRoot), experiments = system.descriptors();

      assert.equal(experiments.length, 1);
      assert.equal(experiments[0]!.ref, "tool.read.whole-stream.v2");
      assert.equal(experiments[0]!.domain, "tool");
      assert.equal(experiments[0]!.version, "2");
      const window = { schemaVersion: 1, domain: "tool", scope: SCOPE, boardSequence: state.sequence,
        watermarks: [{ runId: "public-read-fixture", throughSequence: 1 }], experiments,
        records: [{ ref: "ordinary-read", runId: "public-read-fixture", sequence: 1, scope: SCOPE,
          origin: "execution_result", text: "真实普通读取成功，尚未完成两次配对核验。" }] };
      const proposal = { schemaVersion: 3, experimentRef: experiments[0]!.ref,
        question: "当前读取条件下whole和stream的核验结果及工具IO成本怎样？", whenRelevant: "再次遇到同类有界读取时",
        expectedChange: "依据真实配对核验决定是否还需学习读取策略", citations: [{ evidenceRef: "ordinary-read", quote: "真实普通读取成功" }] };
      const admitted = await intake.ingest(JSON.stringify(proposal), JSON.stringify(window), state.sequence);

      assert.equal(admitted.status, "persisted");
      return admitted;
    }

    return { strategy, topics, system, intake, offered, read, ordinary, admitQuestion };
  }

  const state = () => readStrategyBoard(boardRoot);

  return { root, boardRoot, compose, state, setEnabled: (value: boolean) => { enabled = value; },
    reads: () => reads, trials: () => trials, actualTrials: () => actualTrials.slice() };
}

function claims(state: Awaited<ReturnType<typeof readStrategyBoard>>) {
  return (state.rewardV2Facts ?? []).flatMap(fact => {
    const claim = readPoolClaim(JSON.parse(fact.payloadJson));
    return claim === undefined ? [] : [claim];
  });
}

function measurements(state: Awaited<ReturnType<typeof readStrategyBoard>>) {
  return topicMeasurements(state.rewardV2Facts ?? [], SCOPE);
}

test("equal-byte arms with different latency have nonzero utility difference matching the actual tool sensor", () => {
  const bytesRead = 4096, conditions = { fileBytes: bytesRead, range: "bounded" as const, streaming: true };
  const sensorCost = (latencyMs: number, outcome: "completed" | "failed" = "completed") => {
    const facts = readStrategyExecution({ scope: SCOPE, sessionId: "objective", turnId: "turn", nowMs: 0,
      record: { executionId: `sensor-${latencyMs}-${outcome}`, conditions, decision: { path: "whole", reason: "no_policy" },
        actualPath: "whole", outcome, bytesRead, latencyMs } });
    assert.equal(facts.feedback.outcome.kind, "measured");
    return facts.feedback.outcome.kind === "measured" ? facts.feedback.outcome.value : assert.fail("sensor cost must be measured");
  };
  const fast = readPairUtility("pass", bytesRead, 1.1), slow = readPairUtility("pass", bytesRead, 2.3);

  assert.notEqual(fast, slow, "byte equality must not erase the actual sensor latency objective");
  assert.equal(fast, -sensorCost(1.1));
  assert.equal(slow, -sensorCost(2.3));
  assert.equal(fast, -ioWork(bytesRead, 1.1));
  assert.equal(readPairUtility("fail", bytesRead, 1.1), -sensorCost(1.1, "failed"));
  assert.equal(readPairUtility("fail", bytesRead, 1.1), -READ_STRATEGY_COST_METRIC.maximum);
});

test("comparison cost roles preserve the published candidate and study costs without reinterpreting legacy text", () => {
  // Public second-pair costs from volc-ordinary-io-execute-v1; no trial or inference is performed here.
  const row: TopicPairedMeasurement = { id: "topic-measure:public-cost-roles", sequence: 1, scope: SCOPE,
    experimentRef: "tool.read.whole-stream.v2", experimentVersion: "2", conditionHash: "a".repeat(64),
    utilityUnit: "read_quality_io_cost_v2", sourceRef: "checker:public-cost-roles", kind: "measured",
    baselineUtility: -4247, candidateUtility: -9367, fullStudyCost: 60298 };
  const caseRef = "5eb1385c1508f146f630d04d8ce74fc219aac287b303f4031660cf0361f187a5";
  const common = { comparisonRef: row.id, case: { kind: "read_opportunity", ref: caseRef }, costUnit: "io_cost" };
  const arms = [{ id: "whole", checked: "pass", candidateCost: 4247, studyCost: 17861 },
    { id: "stream", checked: "pass", candidateCost: 9367, studyCost: 42437 }];
  const summary = { ...common, schemaVersion: 2, arms }, evidence = comparisonEvidenceRecord(summary, row, SCOPE, 1);

  assert.ok(evidence);
  assert.equal(evidence.origin, "checker_result");
  assert.equal(evidence.ref, row.id);
  const payload = JSON.parse(evidence.text);

  assert.equal(payload.schemaVersion, 2);
  assert.deepEqual(payload.arms, arms);
  assert.equal(payload.arms[0].candidateCost, -row.baselineUtility);
  assert.notEqual(payload.arms[0].candidateCost, payload.arms[0].studyCost);
  assert.equal(payload.arms.reduce((sum: number, arm: { studyCost: number }) => sum + arm.studyCost, 0), row.fullStudyCost);
  const legacy = { ...common, arms: [{ id: "whole", checked: "pass", cost: 17861 }, { id: "stream", checked: "pass", cost: 42437 }] };
  const legacyText = '{"arms":[{"checked":"pass","cost":17861,"id":"whole"},{"checked":"pass","cost":42437,"id":"stream"}],'
    + `"case":{"kind":"read_opportunity","ref":"${caseRef}"},"costUnit":"io_cost"}`;

  assert.equal(comparisonEvidenceRecord(legacy, row, SCOPE, 1)?.text, legacyText,
    "legacy cost text retains its bytes and receives no inferred candidate/study role");
  assert.equal(comparisonEvidenceRecord({ ...summary, schemaVersion: 3 }, row, SCOPE, 1), undefined);
  assert.equal(comparisonEvidenceRecord({ ...legacy, schemaVersion: 2 }, row, SCOPE, 1), undefined);
  assert.equal(comparisonEvidenceRecord({ ...summary, arms: [{ ...arms[0], cost: 17861 }, arms[1]] }, row, SCOPE, 1), undefined);
  assert.equal(comparisonEvidenceRecord({ ...common, arms }, row, SCOPE, 1), undefined);
  assert.equal(comparisonEvidenceRecord(summary, { ...row, fullStudyCost: row.fullStudyCost + 1 }, SCOPE, 1), undefined);
  const { baselineUtility: _baseline, candidateUtility: _candidate, fullStudyCost: _study, ...identity } = row;

  assert.equal(comparisonEvidenceRecord(summary, { ...identity, kind: "unknown", reason: "checker_unknown" }, SCOPE, 1), undefined);
});

test("real paired study preserves checker latency in durable cost, comparison and actual-learner replay", async t => {
  const h = await harness(t), p = h.compose();
  await p.ordinary("objective-source");
  assert.equal((await p.system.invoke({ requestId: "objective-pair", totalQuota: 1 }, signal())).status, "completed");
  const row = measurements(await h.state())[0]!;
  assert.equal(row.kind, "measured");
  if (row.kind !== "measured") return;

  const actual = h.actualTrials();
  assert.equal(actual.length, 2);
  assert.ok(actual.every(arm => arm.quality === "pass" && arm.totalLatencyMs >= arm.latencyMs));
  assert.ok(actual.some(arm => arm.totalLatencyMs > arm.latencyMs), "the deterministic clock includes actual before/after checker work");
  assert.equal(row.fullStudyCost, actual.reduce((sum, arm) => sum + ioWork(arm.totalBytesRead, arm.totalLatencyMs), 0));
  const provenance = JSON.parse(row.provenanceJson!);

  assert.deepEqual(provenance.arms.map((arm: { result: { totalLatencyMs: number } }) => arm.result.totalLatencyMs), actual.map(arm => arm.totalLatencyMs));
  assert.equal(row.baselineUtility, -Math.min(READ_STRATEGY_COST_METRIC.maximum, ioWork(actual[0]!.bytesRead, actual[0]!.latencyMs)));
  assert.equal(row.candidateUtility, -Math.min(READ_STRATEGY_COST_METRIC.maximum, ioWork(actual[1]!.bytesRead, actual[1]!.latencyMs)));
  const entry = p.topics.configuration.experiments[0]!, comparison = entry.probe.describeComparison!(row);
  assert.ok(comparison);
  assert.equal(comparison.costUnit, "io_cost");
  assert.equal(comparison.schemaVersion, 2);

  if (comparison.schemaVersion !== 2) return;

  assert.deepEqual(comparison.arms.map(arm => arm.candidateCost), [-row.baselineUtility, -row.candidateUtility]);
  assert.deepEqual(comparison.arms.map(arm => arm.studyCost), actual.map(arm => ioWork(arm.totalBytesRead, arm.totalLatencyMs)));
  assert.equal(comparison.arms.reduce((sum, arm) => sum + arm.studyCost, 0), row.fullStudyCost);
  const evidence = comparisonEvidenceRecord(comparison, row, SCOPE, row.sequence);
  assert.ok(evidence);
  const payload = JSON.parse(evidence.text);

  assert.equal(payload.schemaVersion, 2);
  assert.equal(payload.costUnit, "io_cost");
  assert.deepEqual(payload.arms, comparison.arms);
  await p.ordinary("objective-replay-opportunity");
  const replay = await entry.decisionPolicy!({ questionId: "objective-replay", boardSequence: (await h.state()).sequence,
    measurements: [row], signal: signal() });

  assert.equal(replay.status, "ready", JSON.stringify(replay));

  if (replay.status === "ready") assert.equal(replay.projections[0]!.measurementId, row.id);

  assert.equal(h.trials(), 2, "replay cannot sample another physical pair");
});

test("missing study latency and the retired byte-only protocol cannot become zero-cost current support", async t => {
  const h = await harness(t), p = h.compose();
  await p.ordinary("invalid-objective-source");
  assert.equal((await p.system.invoke({ requestId: "invalid-objective-pair", totalQuota: 1 }, signal())).status, "completed");
  const row = measurements(await h.state())[0]!;
  assert.equal(row.kind, "measured");
  if (row.kind !== "measured") return;

  const entry = p.topics.configuration.experiments[0]!, raw = JSON.parse(row.provenanceJson!);

  delete raw.arms[0].result.totalLatencyMs;
  const digest = contentHashOf(raw), missing = { ...row, provenanceJson: canonicalJson(raw), provenanceHash: digest, sourceRef: `checker:${digest}` };

  assert.equal(entry.probe.describeComparison!(missing), undefined);
  await p.ordinary("invalid-objective-replay");
  const boardSequence = (await h.state()).sequence;
  const replay = await entry.decisionPolicy!({ questionId: "missing-latency", boardSequence, measurements: [missing], signal: signal() });

  assert.equal(replay.status, "unmodelled", JSON.stringify(replay));
  const legacy = { ...row, experimentVersion: "1", utilityUnit: "read_quality_byte_cost_v1" };

  assert.equal(entry.probe.describeComparison!(legacy), undefined);
  const policy = { ...entry.policy, scope: SCOPE, experimentRef: entry.descriptor.ref, experimentVersion: entry.descriptor.version,
    conditionHash: row.conditionHash, utilityUnit: p.topics.configuration.policy.utilityUnit };

  assert.deepEqual(buildEmpiricalTopicModel({ policy, questionId: "old-byte-protocol", boardSequence, measurements: [legacy],
    decision: { currentAction: 0, projections: [] } }), { status: "unvalued", reason: "topic_empirical_support" });
});

test("real ordinary reads feed two centrally funded checked pairs, publish a tool-owned strategy and later adopt it", async t => {
  const h = await harness(t), p = h.compose();

  await p.ordinary("first");
  assert.equal(h.trials(), 0, "ordinary read only captures a permitted opportunity");
  await p.admitQuestion();
  const first = await p.system.invoke({ requestId: "pair-one", totalQuota: 1 }, signal());

  assert.equal(first.purpose, "calibration");
  assert.equal(first.status, "completed");
  assert.equal(first.calibration?.processed, 1);
  let state = await h.state();
  assert.equal(measurements(state).length, 1);
  assert.equal(claims(state).length, 1);
  assert.equal(h.trials(), 2);
  assert.equal(latestReadStrategyAsset(state, SCOPE), undefined);

  await p.ordinary("second");
  const second = await p.system.invoke({ requestId: "pair-two", totalQuota: 1 }, signal());

  assert.equal(second.purpose, "calibration");
  assert.equal(second.status, "completed");
  assert.equal(second.calibration?.processed, 1);
  state = await h.state();
  const measured = measurements(state), asset = latestReadStrategyAsset(state, SCOPE), policy = readStrategyPolicyOf(asset);

  assert.equal(measured.length, 2);
  assert.ok(measured.every(row => row.kind === "measured"));
  assert.equal(claims(state).length, 2);
  assert.equal(claims(state).reduce((sum, row) => sum + row.units, 0), 2);
  assert.equal(h.trials(), 4);
  assert.equal(h.reads(), 14, "each physical trial uses the existing before/candidate/after read checker");
  assert.ok(asset);
  assert.ok(policy);
  assert.equal(policy.rules.length, 1);
  assert.equal(asset.schemaVersion, 2);
  assert.equal(policy.schemaVersion, 2);
  assert.equal(policy.owner, "tool.read-strategy");
  assert.equal(state.proposals.find(row => row.proposalId === asset.createdFromProposalId)?.domain, "tool");
  const observations = readStrategyObservations(rewardRecordsOf(state), SCOPE).filter(row => row.quality === "verified");

  assert.equal(observations.filter(row => row.path === "whole").length, 2);
  assert.equal(observations.filter(row => row.path === "stream").length, 2);

  // Objective v2 intentionally replaces byte-only equality with the original tool's capped IO metric.
  // The injected clock verifies accounting; it does not establish a physical speedup or net learning gain.
  for (const [index, row] of measured.entries()) if (row.kind === "measured") {
    const actual = h.actualTrials().slice(index * 2, index * 2 + 2);
    assert.equal(row.baselineUtility, -Math.min(READ_STRATEGY_COST_METRIC.maximum, ioWork(actual[0]!.bytesRead, actual[0]!.latencyMs)));
    assert.equal(row.candidateUtility, -Math.min(READ_STRATEGY_COST_METRIC.maximum, ioWork(actual[1]!.bytesRead, actual[1]!.latencyMs)));
  }

  const output = await p.ordinary("adopted");
  assert.equal(output.outcome, "result");
  if (output.outcome !== "result") return;

  const receipt = output.value.routing as { decision?: { path?: string; versionId?: string } };

  assert.equal(receipt.decision?.path, policy.rules[0]!.path);
  assert.equal(receipt.decision?.versionId, asset.versionId);
  assert.equal(h.trials(), 4, "adoption must not itself run learning trials");
});

test("reconstructed pool/system and stable request retain the original claim without another trial", async t => {
  const h = await harness(t), first = h.compose();

  await first.ordinary("before-restart");
  const original = await first.system.invoke({ requestId: "stable-pair", totalQuota: 1 }, signal());

  assert.equal(original.status, "completed");
  assert.equal(h.trials(), 2);
  const restarted = h.compose();
  await restarted.ordinary("new-opportunity");
  const before = await h.state(), beforeReads = h.reads();
  const replayed = await restarted.system.invoke({ requestId: "stable-pair", totalQuota: 1 }, signal());

  assert.equal(replayed.status, "previous");
  const after = await h.state();
  assert.equal(after.sequence, before.sequence);
  assert.deepEqual(claims(after), claims(before));
  assert.deepEqual(measurements(after), measurements(before));
  assert.equal(h.trials(), 2);
  assert.equal(h.reads(), beforeReads);
});

test("disabled topic ownership permits the ordinary read but creates no learning facts or Board directory", async t => {
  const h = await harness(t, false), p = h.compose();
  await p.ordinary("disabled");
  const result = await p.system.invoke({ requestId: "disabled-pair", totalQuota: 1 }, signal());
  assert.equal(result.status, "disabled");
  assert.equal(h.trials(), 0);
  assert.equal(h.reads(), 1);
  assert.deepEqual(await p.intake.ingest("invalid", "invalid"), { status: "disabled" });
  await assert.rejects(access(h.boardRoot));
});

test("retired read metrics do not enter tool demand while malformed current observations remain visible", async t => {
  const h = await harness(t), p = h.compose();
  await p.ordinary("current-owner");
  const demand = p.topics.configuration.experiments[0]!.demandPolicy!;
  const before = await h.state(), initial = await demand({ boardSequence: before.sequence, signal: signal() });

  assert.equal(initial.status, "ready");
  if (initial.status !== "ready") return;

  const ordinary = before.rewardExposures!.find(row => row.context.metric.id === READ_STRATEGY_COST_METRIC.id)!;
  const ledger = createRewardBoardPort(h.boardRoot), source = { ...ordinary.source, eventId: "historical-read" };
  const old = await ledger.expose({ schemaVersion: 1, id: "historical-routing-read", source, occurredAt: ordinary.occurredAt + 1,
    context: { ...ordinary.context, metric: { ...READ_STRATEGY_COST_METRIC, id: "routing.read.cost", version: "1" } },
    targets: [{ kind: "routing_path", id: "stream", version: "1" }, { kind: "routing_choice", id: "stream", version: "no_policy" }] });

  assert.equal(old.ok, true);
  const afterOld = await h.state(), current = await demand({ boardSequence: afterOld.sequence, signal: signal() });

  assert.equal(current.status, "ready");
  if (current.status !== "ready") return;

  assert.equal(current.futureUses, initial.futureUses, "history is retained but does not change this owner's occurrence model");
  assert.equal(afterOld.rewardExposures!.some(row => row.id === "historical-routing-read"), true);
  assert.equal((await ledger.expose({ schemaVersion: 1, id: "malformed-tool-read", source: { ...source, eventId: "malformed-current" },
    occurredAt: ordinary.occurredAt + 2, context: { ...ordinary.context, environment: "malformed-current-condition" }, targets: ordinary.targets })).ok, true);
  const afterBad = await h.state();

  assert.deepEqual(await demand({ boardSequence: afterBad.sequence, signal: signal() }),
    { status: "unmodelled", reason: "read_topic_demand_unclassified" });
});

test("a changed physical file stays unknown and spent; an independent checked correction refreshes by superseding without sampling", async t => {
  const changed = await harness(t), p = changed.compose();

  await p.ordinary("changed", "before\n");
  await writeFile(path.join(changed.root, "changed.txt"), "after!\n");
  const unknown = await p.system.invoke({ requestId: "changed-pair", totalQuota: 1 }, signal());

  assert.equal(unknown.status, "unknown");
  assert.equal(unknown.calibration?.processed, 0);
  assert.equal(changed.trials(), 1);
  let state = await changed.state();
  assert.equal(claims(state).length, 1);
  assert.equal(measurements(state).length, 1);
  assert.equal(measurements(state)[0]!.kind, "unknown");
  await p.ordinary("after-unknown");
  await p.system.invoke({ requestId: "must-not-replace-unknown", totalQuota: 1 }, signal());
  state = await changed.state();
  assert.equal(claims(state).length, 1);
  assert.equal(changed.trials(), 1);

  const revised = await harness(t), r = revised.compose();
  await r.ordinary("revision-source");
  assert.equal((await r.system.invoke({ requestId: "revision-pair", totalQuota: 1 }, signal())).status, "completed");
  const original = measurements(await revised.state())[0]!;
  assert.equal(original.kind, "measured");

  if (original.kind === "measured") assert.equal(original.fullStudyCost,
    revised.actualTrials().reduce((sum, arm) => sum + ioWork(arm.totalBytesRead, arm.totalLatencyMs), 0));

  const provenance = JSON.parse(original.provenanceJson!);
  const executionId: string = provenance.arms[0].routing.executionId;
  // An explicit external/user verdict is fixture input to the existing confirmation authority.
  // It proves correction plumbing; it is not a newly discovered physical reader-quality defect.
  const corrected = await r.strategy.confirm({ executionId, feedbackId: "user-quality-revision", origin: "user", passed: false,
    proofRef: `routing-read-check:${contentHashOf({ executionId, externalVerdict: "fail", authority: "fixture-user" })}` });

  assert.equal(corrected.ok, true);
  await r.ordinary("revision-refresh-opportunity");
  const count = revised.trials(), used = claims(await revised.state()).length;

  await r.system.invoke({ requestId: "refresh-only", totalQuota: 0 }, signal());
  const after = await revised.state(), rows = measurements(after), replacement = rows.find(row => row.supersedes === original.id);

  assert.equal(rows.length, 2);
  assert.ok(replacement);
  assert.equal(replacement.kind, "measured");

  if (replacement.kind === "measured" && original.kind === "measured") {
    assert.ok(replacement.baselineUtility < original.baselineUtility);
    assert.equal(replacement.candidateUtility, original.candidateUtility);
    assert.equal(replacement.baselineUtility, -READ_STRATEGY_COST_METRIC.maximum);
    assert.equal(replacement.fullStudyCost, original.fullStudyCost);
  }

  assert.equal(replacement.deploymentAction, original.deploymentAction);
  assert.equal(replacement.decisionBasisHash, original.decisionBasisHash);
  assert.equal(revised.trials(), count);
  assert.equal(claims(after).length, used);
  const beforeRepeat = after.sequence;

  await r.system.invoke({ requestId: "refresh-again", totalQuota: 0 }, signal());
  assert.equal((await revised.state()).sequence, beforeRepeat, "unchanged external checks must not append another revision");
});
