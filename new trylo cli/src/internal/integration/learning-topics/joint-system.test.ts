import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { canonicalJson, contentHashOf, sha256Hex } from "../../learning/control/hash.js";
import type { InformationModelV2 } from "../../learning/domains/shared/topics/information-model.js";
import { planTopicInformation } from "../../learning/domains/shared/topics/information-plan.js";
import { readTopicSubmission } from "../../learning/domains/shared/topics/submission.js";
import type { TopicEvidenceWindow } from "../../learning/domains/shared/topics/contracts.js";
import { createRewardV2BoardPort } from "../reward/v2-board-port.js";
import { createPersistentTopicIntake } from "./intake.js";
import { createTopicLearningRuntime } from "./runtime.js";
import { createTopicLearningSystem } from "./system.js";
import { replayTopicExecution, type TopicExecutionFrame } from "./execution-state.js";
import type { TopicDomainModelCandidate, TopicDomainModelProvenance, TopicDomainModelSource } from "./domain-model.js";
import type { TopicProbePort, TopicProbeReceipt } from "./execution-contract.js";

const SCOPE = "joint-system-contract", UNIT = "declared-xor-utility", QUOTA_UNIT = "approved-probe-unit";
const CHECKER = "exact-file-byte-v1", EXECUTOR = "bounded-file-premise-v1";
const signal = () => new AbortController().signal;

function near(actual: number, expected: number): void { assert.ok(Math.abs(actual - expected) < 2e-12, `${actual} != ${expected}`); }

function xorModel(left: string, right: string): InformationModelV2 {
  const transition = (questionId: string, next: readonly string[]) => ({ questionId, next });
  return { schemaVersion: 2, prior: [0.25, 0.25, 0.25, 0.25], utilities: [[1, 0, 0, 1], [0, 1, 1, 0]], questions: [
    { id: left, units: 2, cost: 0.05, likelihood: [[1, 0], [1, 0], [0, 1], [0, 1]] },
    { id: right, units: 1, cost: 0.05, likelihood: [[1, 0], [0, 1], [1, 0], [0, 1]] }],
    decision: { initialState: "current", states: [
      { id: "current", action: 0, transitions: [transition(left, ["l0", "l1"]), transition(right, ["r0", "r1"])] },
      { id: "l0", action: 0, transitions: [transition(right, ["b00", "b01"])] },
      { id: "l1", action: 0, transitions: [transition(right, ["b10", "b11"])] },
      { id: "r0", action: 0, transitions: [transition(left, ["b00", "b10"])] },
      { id: "r1", action: 0, transitions: [transition(left, ["b01", "b11"])] },
      { id: "b00", action: 0, transitions: [] }, { id: "b01", action: 1, transitions: [] },
      { id: "b10", action: 1, transitions: [] }, { id: "b11", action: 0, transitions: [] }] } };
}

async function fixture(t: TestContext, mode: "recorded" | "changed-source") {
  const root = await mkdtemp(path.join(os.tmpdir(), "trylo-joint-system-"));

  t.after(() => rm(root, { recursive: true, force: true }));
  const boardRoot = path.join(root, "board"), receipts = path.join(root, "receipts");

  await mkdir(receipts);
  await writeFile(path.join(root, "left.txt"), "0");
  await writeFile(path.join(root, "right.txt"), "1");
  const board = createRewardV2BoardPort(boardRoot, () => true);
  const intake = createPersistentTopicIntake({ boardRoot, scope: SCOPE, domain: "tool", algorithmVersion: "joint-intake-v1", enabled: () => true });
  const originals: TopicDomainModelCandidate[] = [];

  for (const [index, side] of (["left", "right"] as const).entries()) {
    const prefix = await board.read(), text = `The ${side} premise is still unknown.`;
    const window: TopicEvidenceWindow = { schemaVersion: 1, domain: "tool", scope: SCOPE, boardSequence: prefix.revision,
      watermarks: [{ runId: "recorded-task", throughSequence: index + 1 }], records: [{ ref: `${side}-request`, runId: "recorded-task",
        sequence: index + 1, scope: SCOPE, origin: "execution_result", text }] };
    const proposalJson = canonicalJson({ schemaVersion: 2, question: `What is the ${side} premise?`, whenRelevant: "Before the combined decision.",
      expectedChange: "Use both observed premises to choose the declared action.", citations: [{ evidenceRef: `${side}-request`, quote: text }] });
    const windowJson = canonicalJson(window), stored = await intake.ingest(proposalJson, windowJson);

    assert.equal(stored.status, "persisted");
    if (stored.status !== "persisted") throw new Error("joint_intake_failed");

    originals.push({ proposalJson, windowJson, topic: stored.topic });
  }

  assert.notEqual(originals[0]!.topic.basis.boardSequence, originals[1]!.topic.basis.boardSequence);
  const before = await board.read(), originalFacts = before.facts.map(fact => ({ id: fact.id, payloadJson: fact.payloadJson }));
  let runs = 0, reads = 0;
  const executed: string[] = [], files = new Map<string, string>();
  const probe: TopicProbePort = {
    async run(input) {
      const charged = await board.read(), claim = charged.facts.find(fact => fact.id === input.claimId);

      assert.ok(claim, "the actual pool claim must already be durable");
      const started = charged.facts.find(fact => fact.kind === "opportunity" && fact.id.includes(":started:")
        && JSON.parse(fact.payloadJson).expected?.spendId === input.spendId);

      assert.ok(started, "the actual controller must persist started before reading the file");
      assert.ok(claim.sequence < started.sequence);
      assert.equal(JSON.parse(claim.payloadJson).allocationId, input.allocationId);
      assert.ok(charged.facts.some(fact => fact.kind === "learning_decision"
        && JSON.parse(fact.payloadJson).plan?.allocationId === input.allocationId));
      const file = files.get(input.questionId);
      assert.ok(file);
      runs += 1;
      executed.push(input.questionId);
      const observed = await readFile(file);
      assert.equal(observed.length, 1);
      assert.ok(observed[0] === 48 || observed[0] === 49);
      const outcome = observed[0] - 48, receiptRef = `joint-byte:${sha256Hex(input.spendId)}`;
      const { topic: _topic, signal: _signal, ...expected } = input;
      const measurement = { questionId: input.questionId, byte: observed[0], spendId: input.spendId };
      const receipt: TopicProbeReceipt = { ...expected, schemaVersion: 1, receiptRef, outcome,
        sourceRef: `checker:${contentHashOf(measurement)}`, measurementHash: contentHashOf(measurement) };

      await writeFile(path.join(receipts, sha256Hex(receiptRef) + ".json"), canonicalJson(receipt), { flag: "wx" });
      return receiptRef;
    },

    async readObservation(ref) {
      reads += 1;
      return readFile(path.join(receipts, sha256Hex(ref) + ".json"), "utf8");
    },
  };
  const source: TopicDomainModelSource = { domain: "tool", available: () => true,

    prepare(request) {
      // Preparation receives recorded candidates only. Neither file byte is read until probe.run above.
      const left = request.candidates.find(candidate => candidate.topic.question === "What is the left premise?");
      const right = request.candidates.find(candidate => candidate.topic.question === "What is the right premise?");
      if (left === undefined || right === undefined) return undefined;

      let selected: readonly TopicDomainModelCandidate[] = [left, right];

      if (mode === "changed-source") {
        const changed = JSON.parse(left.windowJson);
        changed.records[0].text += " Additional invented source.";
        const windowJson = canonicalJson(changed), grounded = readTopicSubmission(left.proposalJson, windowJson);
        assert.ok(grounded.ok && grounded.value.kind === "topic");
        if (!grounded.ok || grounded.value.kind !== "topic") throw new Error("changed_source_not_grounded");
        selected = [{ ...left, windowJson, topic: grounded.value.topic }, right];
      }

      const model = xorModel(selected[0]!.topic.topicId, selected[1]!.topic.topicId), modelJson = canonicalJson(model);

      files.set(selected[0]!.topic.topicId, path.join(root, "left.txt"));
      files.set(selected[1]!.topic.topicId, path.join(root, "right.txt"));
      const domainDecisionHash = contentHashOf({ protocol: "declared-xor-actions-v1", scope: request.scope, model }),
        probeBindingHash = contentHashOf({ checkerVersion: CHECKER, executionVersion: EXECUTOR });
      const provenance: TopicDomainModelProvenance = { schemaVersion: 1, type: "ws1_topic_domain_model", scope: request.scope, domain: "tool",
        boardSequence: request.boardSequence, utilityUnit: UNIT, quotaUnit: QUOTA_UNIT, modelHash: contentHashOf(model), domainDecisionHash, probeBindingHash,
        checkerVersion: CHECKER, executionVersion: EXECUTOR, timeoutMs: 5000,
        candidates: selected.map(candidate => ({ topicId: candidate.topic.topicId,
          proposalSha256: sha256Hex(candidate.proposalJson), windowSha256: sha256Hex(candidate.windowJson) })),
        source: { algorithmVersion: "declared-xor-hypothesis-v1", recordRefs: selected.map(candidate => candidate.topic.topicId), recordDigest: contentHashOf(selected),
          assumptions: ["The uniform four-world prior, likelihoods and XOR utility are an explicit finite hypothesis, not an empirically calibrated distribution",
            "Record refs are grounded topic identities reproduced from the actual persisted candidates at this Board prefix",
            "The domain deploys action zero before both bits and deploys their XOR after both actual observations"] } };

      return { input: { candidates: selected.map(candidate => ({ proposalJson: candidate.proposalJson, windowJson: candidate.windowJson })),
        modelJson, utilityUnit: UNIT, quotaUnit: QUOTA_UNIT, maxQuota: request.maxQuota, valuationBoardSequence: request.boardSequence,
        domainDecisionHash, probeBindingHash, modelProvenanceJson: canonicalJson(provenance), modelProvenanceHash: contentHashOf(provenance) },
        probe, checkerVersion: CHECKER, executionVersion: EXECUTOR, timeoutMs: 5000 };
    } };
  const requestId = "turn:joint-session:1";
  const runtime = () => {
    const system = createTopicLearningSystem({ boardRoot, scope: SCOPE, enabled: () => true, configuration: {
      policy: { poolId: "joint-pool", algorithmVersion: "joint-pool-v1", utilityUnit: UNIT, quotaUnit: QUOTA_UNIT, totalQuota: 3 },
      perTurnQuota: 3, experiments: [], domainModels: [source], domainRelation: "separable" } });
    return createTopicLearningRuntime({ boardRoot, scope: SCOPE, sessionId: "joint-session", turnId: "1", enabled: () => true,
      emit: () => {}, control: { system, requestId, totalQuota: 3 } });
  };

  return { board, receipts, originals, originalFacts, runtime, counts: () => ({ runs, reads }), executed };
}

test("ordinary finish jointly values separate persisted windows, executes real file premises and recovers without another grant", async t => {
  const fx = await fixture(t, "recorded"), result = await fx.runtime().finish(signal());

  assert.ok(result, "domainModels-only system must be reached by the ordinary finish boundary");
  assert.equal(result.status, "completed");
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0]!.processed, 2);
  assert.equal(result.results[0]!.remaining, 0);
  assert.deepEqual(fx.counts(), { runs: 2, reads: 2 });
  assert.deepEqual(fx.executed, fx.originals.map(candidate => candidate.topic.topicId));
  const loaded = await fx.board.read(), reservation = loaded.facts.find(fact => JSON.parse(fact.payloadJson).type === "ws1_topic_reservation");

  assert.ok(reservation);
  const reserved = JSON.parse(reservation.payloadJson), quoted = JSON.parse(reserved.requestJson);

  assert.equal(reserved.plan.allocated, 3);
  assert.equal(quoted.bids[0].curve.length, 4);

  for (const quota of [0, 1, 2]) near(quoted.bids[0].curve[quota].netValue, 0);

  near(quoted.bids[0].curve[3].netValue, 0.4);

  for (const candidate of fx.originals) {
    assert.equal(canonicalJson(result).includes(candidate.topic.question), false);
    assert.equal(reserved.requestJson.includes(candidate.topic.question), false, "the central request contains curves, not question text");
  }

  const init = loaded.facts.find(fact => JSON.parse(fact.payloadJson).type === "ws1_topic_execution_init");
  assert.ok(init);
  const frame: TopicExecutionFrame = JSON.parse(init.payloadJson);

  assert.ok(frame.input.candidates);
  assert.deepEqual(frame.input.candidates.map(candidate => candidate.windowJson), fx.originals.map(candidate => candidate.windowJson));
  const choice = planTopicInformation(frame.input.modelJson!, 3);
  assert.equal(choice.status, "planned");

  if (choice.status !== "planned") throw new Error("joint_plan_missing");
  near(choice.value, 0.9);
  near(choice.netGain, 0.4);
  const recovered = replayTopicExecution(frame, loaded.facts), rebuilt = replayTopicExecution(JSON.parse(canonicalJson(frame)) as TopicExecutionFrame, loaded.facts);

  assert.equal(recovered.applied, 2);
  assert.equal(recovered.remaining, 0);
  assert.equal(recovered.unknown, false);
  assert.equal(recovered.pending, null);
  const posterior = JSON.parse(recovered.modelJson);
  assert.deepEqual(posterior.prior, [0, 1, 0, 0]);
  assert.equal(posterior.decision.initialState, "b01");
  assert.deepEqual(rebuilt, recovered);
  assert.equal((await readdir(fx.receipts)).length, 2);

  for (const original of fx.originalFacts) assert.equal(loaded.facts.find(fact => fact.id === original.id)?.payloadJson, original.payloadJson);

  const previous = await fx.runtime().finish(signal());
  assert.ok(previous);
  assert.equal(previous.status, "previous");
  assert.deepEqual(fx.counts(), { runs: 2, reads: 2 });
  assert.equal((await fx.board.read()).revision, loaded.revision);
});

test("a self-consistent model with a changed candidate window cannot obtain a central grant or run a probe", async t => {
  const fx = await fixture(t, "changed-source"), result = await fx.runtime().finish(signal());
  assert.ok(result);
  assert.notEqual(result.status, "completed");
  assert.equal(result.allocationId, undefined);
  assert.equal(result.results.length, 0);
  assert.deepEqual(fx.counts(), { runs: 0, reads: 0 });
  assert.equal((await readdir(fx.receipts)).length, 0);
  const loaded = await fx.board.read();
  assert.equal(loaded.facts.some(fact => ["ws1_topic_reservation", "ws1_topic_claim", "ws1_topic_probe_started"].includes(JSON.parse(fact.payloadJson).type)), false);
  for (const original of fx.originalFacts) assert.equal(loaded.facts.find(fact => fact.id === original.id)?.payloadJson, original.payloadJson);
});
