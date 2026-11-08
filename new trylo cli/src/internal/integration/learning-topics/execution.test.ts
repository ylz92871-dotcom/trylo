import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, readdir, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createTopicBudgetPool } from "./pool.js";
import { createTopicDomainExecution } from "./execution.js";
import type { TopicProbePort, TopicProbeReceipt } from "./execution-contract.js";
import { prepareTopicOpportunity } from "../../learning/domains/shared/topics/opportunity.js";
import { readTopicSubmission } from "../../learning/domains/shared/topics/submission.js";
import { contentHashOf, canonicalJson, sha256Hex } from "../../learning/control/hash.js";
import { createBoardReader } from "../../adapters/learning-store/file-event-store.js";
import { boundedOperation } from "../shared/bounded-operation.js";
import { interpretBounded } from "../reward/bounded-reasoner.js";
import { replayTopicExecution, startProbe, type TopicExecutionFrame } from "./execution-state.js";

async function fixture(topicStage: "hypothesis" | "question" = "hypothesis") {
  const root = await mkdtemp(path.join(os.tmpdir(), "trylo-topic-execution-")), boardRoot = path.join(root, "board"), receipts = path.join(root, "receipts");

  await mkdir(receipts);
  await writeFile(path.join(root, "left.txt"), "0");
  await writeFile(path.join(root, "right.txt"), "1");
  const pool = createTopicBudgetPool({ boardRoot, scope: "project:one", poolId: "declared-study-budget", totalQuota: 3,
    algorithmVersion: "pool-v1", utilityUnit: "goal-v1", quotaUnit: "file-probe-v1", enabled: () => true });
  const opened = await pool.open();
  if (opened.status !== "open") throw new Error("fixture_pool_failed");

  const windowJson = JSON.stringify({ schemaVersion: 1, domain: "prompt", scope: "project:one", boardSequence: opened.revision,
    watermarks: [{ runId: "source", throughSequence: 1 }], records: [{ ref: "source-one", runId: "source", sequence: 1,
      scope: "project:one", origin: "execution_result", text: "结果可能依赖两个输入条件的组合。" }] });
  const proposals = ["左侧条件何时影响选择？", "右侧条件何时影响选择？"].map(question => {
    const full = { schemaVersion: 1, question,
    whenRelevant: "再次选择处理分支时", expectedChange: "据组合条件选处理步骤", citations: [{ evidenceRef: "source-one", quote: "两个输入条件的组合" }],
    alternatives: [{ id: "interaction", explanation: "条件相互作用" }, { id: "independent", explanation: "各自独立影响" }],
    discriminator: { observation: "固定其他条件观察输入", hypothesisIds: ["interaction", "independent"] } };

    if (topicStage === "hypothesis") return JSON.stringify(full);

    const { alternatives: _alternatives, discriminator: _discriminator, ...fields } = full;

    return JSON.stringify({ ...fields, schemaVersion: 2 });
  });
  const ids = proposals.map(proposal => { const value = readTopicSubmission(proposal, windowJson);
    if (!value.ok || value.value.kind !== "topic") throw new Error("fixture_grounding_failed");
  return value.value.topic.topicId; });
  const modelJson = JSON.stringify({ schemaVersion: 1, prior: [0.25, 0.25, 0.25, 0.25], utilities: [[1, 0, 0, 1], [0, 1, 1, 0]], questions: [
    { id: ids[0], units: 2, cost: 0.05, likelihood: [[1, 0, 0], [1, 0, 0], [0, 1, 0], [0, 1, 0]] },
    { id: ids[1], units: 1, cost: 0.05, likelihood: [[1, 0], [0, 1], [1, 0], [0, 1]] }] });
  const versions = { checkerVersion: "strict-file-byte-v1", executionVersion: "fixed-file-probe-v1" };
  const input = { proposals, windowJson, modelJson, utilityUnit: "goal-v1", quotaUnit: "file-probe-v1", maxQuota: 3,
    probeBindingHash: contentHashOf(versions) };
  const offer = prepareTopicOpportunity(input);
  if (offer.status !== "offered") throw new Error("fixture_offer_failed");

  const issued = await pool.issue(JSON.stringify({ schemaVersion: 1, scope: "project:one", boardSequence: opened.revision, utilityUnit: input.utilityUnit,
    quotaUnit: input.quotaUnit, domainRelation: "separable", totalQuota: 3, bids: [offer.bid] }));
  if (issued.status !== "issued") throw new Error("fixture_issue_failed");

  const options = { boardRoot, input, grant: issued.grant, pool, ...versions, enabled: () => true };
  const created = createTopicDomainExecution(options);
  if (created.status !== "ready") throw new Error("fixture_controller_failed");

  const openedDomain = await created.controller.open();
  assert.equal(openedDomain.status, "open");
  let runs = 0, reads = 0;
  const port: TopicProbePort = {
    async run(expected) {
      runs += 1;
      const board = await createBoardReader(boardRoot).load();
      assert.ok(board.ok);
      if (!board.ok) throw new Error("fixture_board_failed");

      assert.ok(board.state.rewardV2Facts?.some(row => row.id === expected.claimId));
      const started = board.state.rewardV2Facts?.find(row => row.id.includes(":started:") && JSON.parse(row.payloadJson).expected.spendId === expected.spendId);

      assert.ok(started, "durable started must precede the real file read");
      const file = expected.questionId === ids[0] ? "left.txt" : "right.txt";
      const measured = await readFile(path.join(root, file), "utf8");
      assert.match(measured, /^[01]$/);
      const receiptRef = `execution:${sha256Hex(expected.spendId)}`;
      const { topic: _topic, signal: _signal, ...binding } = expected;
      const receipt: TopicProbeReceipt = { schemaVersion: 1, ...binding, receiptRef, outcome: Number(measured),
        sourceRef: "checker:" + sha256Hex(file + measured), measurementHash: sha256Hex(measured) };

      await writeFile(path.join(receipts, sha256Hex(receiptRef) + ".json"), canonicalJson(receipt), { flag: "wx" });
      return receiptRef;
    },

    async readObservation(ref) {
      reads += 1;
      return readFile(path.join(receipts, sha256Hex(ref) + ".json"), "utf8");
    },
  };

  return { root, boardRoot, receipts, pool, options, controller: created.controller, ids, port, counts: () => ({ runs, reads }) };
}

const freshSignal = () => new AbortController().signal;

test("real bounded file observations consume true units, update knowledge, choose the next premise and stop", async () => {
  const fx = await fixture();
  assert.equal((await fx.controller.step(fx.port, freshSignal())).status, "observed");
  const first = await fx.controller.view();
  assert.equal(first.status, "state");
  if (first.status !== "state") return;

  assert.equal(first.remaining, 1);
  assert.equal(first.applied, 1);
  assert.deepEqual(JSON.parse(first.modelJson).prior, [0.5, 0.5, 0, 0]);
  assert.deepEqual(JSON.parse(first.modelJson).questions.map((q: { id: string }) => q.id), [fx.ids[1]]);
  assert.equal((await fx.controller.step(fx.port, freshSignal())).status, "observed");
  assert.equal((await fx.controller.step(fx.port, freshSignal())).status, "stopped");
  assert.deepEqual(fx.counts(), { runs: 2, reads: 2 });
  const final = await fx.controller.view();
  if (final.status !== "state") throw new Error("fixture_state_failed");

  assert.equal(final.remaining, 0);
  assert.equal(final.applied, 2);
  assert.deepEqual(JSON.parse(final.modelJson).prior, [0, 1, 0, 0]);
  assert.equal((await readdir(fx.receipts)).length, 2);
  const reopened = createTopicDomainExecution(fx.options);
  if (reopened.status !== "ready") throw new Error("fixture_reopen_failed");

  const replay = await reopened.controller.open();
  assert.equal(replay.status, "open");
  if (replay.status !== "open") return;

  assert.equal(replay.applied, 2);
  assert.deepEqual(JSON.parse(replay.modelJson).prior, [0, 1, 0, 0]);
  assert.equal((await reopened.controller.step(fx.port, freshSignal())).status, "stopped");
  assert.equal(fx.counts().runs, 2);
});

test("a question can use a separately trusted model and approved probe without invented textual hypotheses", async () => {
  const fx = await fixture("question"), port: TopicProbePort = { ...fx.port, async run(input) {
    assert.equal(input.topic.schemaVersion, 2);
    assert.equal(input.topic.status, "grounded_question");
    assert.equal("alternatives" in input.topic, false);
    return fx.port.run(input);
  } };

  assert.equal((await fx.controller.step(port, freshSignal())).status, "observed");
  const state = await fx.controller.view();
  if (state.status !== "state") throw new Error("fixture_state_failed");

  assert.equal(state.applied, 1);
  assert.equal(state.remaining, 1);
  assert.deepEqual(JSON.parse(state.modelJson).prior, [0.5, 0.5, 0, 0]);
  assert.deepEqual(fx.counts(), { runs: 1, reads: 1 });
});

test("a self-consistent receipt from the wrong checker or operation cannot update a model", async () => {
  const fx = await fixture(), port: TopicProbePort = { ...fx.port, async readObservation(ref, expected, signal) {
    const value = JSON.parse(await fx.port.readObservation(ref, expected, signal));
    value.checkerVersion = "wrong-checker";
    return JSON.stringify(value);
  } };

  assert.deepEqual(await fx.controller.step(port, freshSignal()), { status: "unknown", reason: "topic_probe_binding" });
  const state = await fx.controller.view();
  if (state.status !== "state") throw new Error("fixture_state_failed");

  assert.equal(state.applied, 0);
  assert.equal(state.remaining, 1);
  assert.deepEqual(JSON.parse(state.modelJson).prior, [0.25, 0.25, 0.25, 0.25]);
  assert.equal((await fx.controller.step(port, freshSignal())).status, "unknown");
  assert.equal(fx.counts().runs, 1);
});

test("a reader cannot rewrite the immutable expectation and poison the persisted result", async () => {
  const fx = await fixture(), port: TopicProbePort = { ...fx.port, async readObservation(ref, expected, signal) {
    const receipt = JSON.parse(await fx.port.readObservation(ref, expected, signal));
    if (Reflect.set(expected, "questionId", fx.ids[1])) receipt.questionId = expected.questionId;
    return JSON.stringify(receipt);
  } };

  assert.equal((await fx.controller.step(port, freshSignal())).status, "observed");
  const reopened = createTopicDomainExecution(fx.options);
  if (reopened.status !== "ready") throw new Error("fixture_failed");

  const state = await reopened.controller.open();
  assert.equal(state.status, "open");
  if (state.status !== "open") return;

  assert.equal(state.remaining, 1);
  assert.equal(state.applied, 1);
  assert.deepEqual(JSON.parse(state.modelJson).prior, [0.5, 0.5, 0, 0]);
});

test("an objectively observed zero-probability outcome is model mismatch, never invented failure feedback", async () => {
  const fx = await fixture(), port: TopicProbePort = { ...fx.port, async readObservation(ref, expected, signal) {
    const value = JSON.parse(await fx.port.readObservation(ref, expected, signal));
    value.outcome = 2;
    return JSON.stringify(value);
  } };

  assert.deepEqual(await fx.controller.step(port, freshSignal()), { status: "unknown", reason: "topic_probe_out_of_model" });
  const state = await fx.controller.view();
  if (state.status !== "state") throw new Error("fixture_state_failed");
  assert.equal(state.applied, 0);
  const read = await createBoardReader(fx.boardRoot).load();
  assert.ok(read.ok);
  if (!read.ok) return;

  const unknown = read.state.rewardV2Facts?.map(row => JSON.parse(row.payloadJson)).find(row => row.type === "ws1_topic_probe_unknown");

  assert.equal(unknown.receipt.outcome, 2);
  assert.deepEqual(JSON.parse(state.modelJson).prior, [0.25, 0.25, 0.25, 0.25]);
});

test("pre-cancelled work claims nothing and invokes no experiment", async () => {
  const fx = await fixture(), signal = new AbortController();
  signal.abort();
  assert.deepEqual(await fx.controller.step(fx.port, signal.signal), { status: "cancelled" });
  assert.equal(fx.counts().runs, 0);
  const state = await fx.controller.view();
  if (state.status !== "state") throw new Error("fixture_state_failed");
  assert.equal(state.remaining, 3);
});

test("unknown work and recovered pending state never re-execute or treat the missing observation as zero", async () => {
  const fx = await fixture(), port: TopicProbePort = { ...fx.port, run: async () => { throw new Error("transport_unknown"); } };
  assert.deepEqual(await fx.controller.step(port, freshSignal()), { status: "unknown", reason: "topic_probe_unknown" });
  const recovered = createTopicDomainExecution(fx.options);
  if (recovered.status !== "ready") throw new Error("fixture_reopen_failed");
  const state = await recovered.controller.open();
  if (state.status !== "open") throw new Error("fixture_state_failed");
  assert.equal(state.applied, 0);
  assert.equal(state.remaining, 1);
  assert.equal(state.unknown, true);
  assert.equal((await recovered.controller.step(fx.port, freshSignal())).status, "unknown");
  assert.equal(fx.counts().runs, 0);
});

test("a committed claim without started remains charged and unknown after controller recovery", async () => {
  const fx = await fixture();
  const interruptedPool = { ...fx.pool, async claim(...args: Parameters<typeof fx.pool.claim>) {
    const claim = await fx.pool.claim(...args);
    if (claim.status === "claimed") throw new Error("interrupted_after_durable_claim");
    return claim;
  } };
  const interrupted = createTopicDomainExecution({ ...fx.options, pool: interruptedPool });
  if (interrupted.status !== "ready") throw new Error("fixture_failed");

  assert.equal((await interrupted.controller.step(fx.port, freshSignal())).status, "unknown");
  const recovered = createTopicDomainExecution(fx.options);
  if (recovered.status !== "ready") throw new Error("fixture_failed");

  const state = await recovered.controller.open();
  if (state.status !== "open") throw new Error("fixture_failed");

  assert.equal(state.unknown, true);
  assert.equal(state.remaining, 1);
  assert.equal(state.pending, null);
  assert.equal(state.applied, 0);
  assert.deepEqual(JSON.parse(state.modelJson).prior, [0.25, 0.25, 0.25, 0.25]);
  assert.equal((await recovered.controller.step(fx.port, freshSignal())).status, "unknown");
  assert.deepEqual(fx.counts(), { runs: 0, reads: 0 });
});

test("orphan reconciliation ignores another pool and rejects a noncanonical claim in its own pool", async () => {
  const fx = await fixture(), loaded = await createBoardReader(fx.boardRoot).load();
  assert.ok(loaded.ok);
  if (!loaded.ok) return;

  const facts = loaded.state.rewardV2Facts ?? [], init = facts.find(fact => JSON.parse(fact.payloadJson).type === "ws1_topic_execution_init");
  assert.ok(init);
  const frame: TopicExecutionFrame = JSON.parse(init.payloadJson), state = replayTopicExecution(frame, facts);
  const spendId = startProbe(frame, state, fx.ids[0]!, 2, "not-claimed").expected.spendId;
  const payload = { schemaVersion: 1, type: "ws1_topic_claim", allocationId: frame.allocationId,
    domain: frame.domain, valuationId: frame.valuationId, offset: 0, units: 2, spendId };
  const foreign = { id: `ws1-pool:${"0".repeat(64)}:claim:${contentHashOf([frame.allocationId, frame.domain, spendId])}`,
    scope: frame.scope, algorithmVersion: "another-pool-version", kind: "learning_decision" as const,
    sequence: loaded.state.sequence + 1, payloadJson: canonicalJson(payload) };
  const untouched = replayTopicExecution(frame, [...facts, foreign]);

  assert.equal(untouched.unknown, false);
  assert.equal(untouched.remaining, 3);
  const reservation = facts.find(fact => JSON.parse(fact.payloadJson).type === "ws1_topic_reservation");
  assert.ok(reservation);
  const prefix = reservation.id.slice(0, reservation.id.lastIndexOf(":reserve:"));

  assert.throws(() => replayTopicExecution(frame, [...facts, { ...foreign, id: `${prefix}:claim:${"0".repeat(64)}`,
    algorithmVersion: reservation.algorithmVersion }]), /topic_execution_corrupt/);
  const actualId = `${prefix}:claim:${contentHashOf([frame.allocationId, frame.domain, spendId])}`;

  assert.throws(() => replayTopicExecution(frame, [...facts, { ...foreign, id: actualId }]), /topic_execution_corrupt/);
});

test("a late timeout completion cannot start a reader, write feedback or change the posterior", async () => {
  const fx = await fixture();
  let complete!: (value: string) => void, calls = 0, reads = 0;
  const port: TopicProbePort = { run: async () => {
    calls += 1;
    return new Promise(resolve => { complete = resolve; });
  },

    readObservation: async () => {
      reads += 1;
      throw new Error("must_not_read");
    } };
  const short = createTopicDomainExecution({ ...fx.options, timeoutMs: 15 });
  if (short.status !== "ready") throw new Error("fixture_failed");

  assert.deepEqual(await short.controller.step(port, freshSignal()), { status: "unknown", reason: "topic_probe_unknown" });
  complete("execution:late");
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(reads, 0);
  assert.equal(calls, 1);
  const state = await short.controller.view();
  if (state.status !== "state") throw new Error("fixture_state_failed");

  assert.equal(state.applied, 0);
  assert.equal((await short.controller.step(port, freshSignal())).status, "unknown");
  assert.equal(calls, 1);
});

test("checker/executor bindings cannot change after the central quote was granted", async () => {
  const fx = await fixture();
  assert.deepEqual(createTopicDomainExecution({ ...fx.options, checkerVersion: "changed" }),
    { status: "rejected", reason: "topic_probe_versions_unbound" });
  assert.deepEqual(createTopicDomainExecution({ ...fx.options, input: { ...fx.options.input, probeBindingHash: "0".repeat(64) } }),
    { status: "rejected", reason: "topic_probe_versions_unbound" });
});

test("a disabled domain neither parses a malformed model nor creates a Board directory", async () => {
  const fx = await fixture(), target = path.join(fx.root, "never-created");
  assert.deepEqual(createTopicDomainExecution({ ...fx.options, boardRoot: target, enabled: () => false,
    input: { ...fx.options.input, modelJson: "bad" } }), { status: "disabled" });
  await assert.rejects(access(target));
});

test("a forged capability cannot run an experiment even if it copies a genuine allocation", async () => {
  const fx = await fixture(), clone = createTopicDomainExecution({ ...fx.options, grant: { ...fx.options.grant } });
  if (clone.status !== "ready") throw new Error("fixture_failed");
  assert.equal((await clone.controller.step(fx.port, freshSignal())).status, "unknown");
  assert.equal(fx.counts().runs, 0);
});

test("preconsumption outside the frozen domain policy cannot append an unreplayable started record", async () => {
  const fx = await fixture(), domain = fx.options.grant.allocations[0]!;

  assert.equal((await fx.pool.claim(fx.options.grant, "prompt", domain.valuationId, 1, "other-host-operation")).status, "claimed");
  assert.equal((await fx.controller.step(fx.port, freshSignal())).status, "unknown");
  assert.equal(fx.counts().runs, 0);
  const reopened = createTopicDomainExecution(fx.options);
  if (reopened.status !== "ready") throw new Error("fixture_failed");

  const state = await reopened.controller.open();
  assert.equal(state.status, "open");
  if (state.status !== "open") return;

  assert.equal(state.applied, 0);
  assert.equal(state.unknown, true);
  const read = await createBoardReader(fx.boardRoot).load();
  assert.ok(read.ok);
  if (!read.ok) return;

  assert.equal(read.state.rewardV2Facts?.filter(row => JSON.parse(row.payloadJson).type === "ws1_topic_probe_started").length, 0);
});

test("halted recovery rejects malformed charged claims instead of accepting corrupted accounting", async () => {
  const fx = await fixture(), domain = fx.options.grant.allocations[0]!;

  assert.equal((await fx.pool.claim(fx.options.grant, "prompt", domain.valuationId, 1, "other-host-operation")).status, "claimed");
  assert.equal((await fx.controller.step(fx.port, freshSignal())).status, "unknown");
  const read = await createBoardReader(fx.boardRoot).load();
  assert.ok(read.ok);
  if (!read.ok) return;

  const facts = read.state.rewardV2Facts ?? [];
  const init = facts.find(row => JSON.parse(row.payloadJson).type === "ws1_topic_execution_init");
  const halted = facts.find(row => JSON.parse(row.payloadJson).type === "ws1_topic_execution_halted");

  assert.ok(init);
  assert.ok(halted);
  const frame: TopicExecutionFrame = JSON.parse(init.payloadJson), halt = JSON.parse(halted.payloadJson);

  assert.equal(replayTopicExecution(frame, facts).unknown, true);
  const claim = facts.find(row => row.id === halt.claimId);
  assert.ok(claim);
  const charged = JSON.parse(claim.payloadJson);

  for (const patch of [{ schemaVersion: 99 }, { offset: -1 }, { offset: 0.5 }, { units: "2" }, { units: 0 }, { units: 4 }]) {
    const changed = facts.map(row => row.id === claim.id ? { ...row, payloadJson: canonicalJson({ ...charged, ...patch }) } : row);
    assert.throws(() => replayTopicExecution(frame, changed), /topic_execution_corrupt/, JSON.stringify(patch));
  }

  assert.equal(fx.counts().runs, 0);
});

test("shared bounded operation keeps legacy reasoner stop semantics without invoking pre-aborted work", async () => {
  const cancel = new AbortController();
  cancel.abort();
  let calls = 0;
  await assert.rejects(boundedOperation(cancel.signal, 5, async () => {
    calls += 1;
    return "unexpected";
  }, "stopped"), /stopped/);
  assert.equal(calls, 0);
  await assert.rejects(interpretBounded({ interpret: async () => new Promise<string>(() => {}) },
    { prompt: "local bounded test", maxOutputTokens: 1, requestId: "bounded-test", signal: freshSignal() }, 5), /reward_reasoner_stopped/);
});
