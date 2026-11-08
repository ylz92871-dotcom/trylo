import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Envelope } from "../../protocol/envelope.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import type { InformationDecision } from "../../learning/domains/shared/topics/information-model.js";
import { buildJointEmpiricalModel, type JointEmpiricalPolicy, type JointOutcome } from "../../learning/domains/shared/topics/joint-empirical-model.js";
import { readTopicSubmission } from "../../learning/domains/shared/topics/submission.js";
import { createBoardReader } from "../../adapters/learning-store/file-event-store.js";
import { createTopicJointMeasurementSource, topicJointMeasurements } from "./joint-measurement-source.js";
import { createJointEmpiricalDomainModelSource } from "./joint-domain-model.js";
import type { TopicDomainModelSource } from "./domain-model.js";
import type { PreparedTopicDomain } from "./domain-runtime.js";
import { topicDomainCandidates } from "./domain-candidates.js";
import { createTopicLearningSystem } from "./system.js";
import { createTopicLearningRuntime } from "./runtime.js";
import { replayTopicExecution, type TopicExecutionFrame } from "./execution-state.js";
import type { TopicProbeExpectation, TopicProbePort } from "./execution-contract.js";
import { readPoolClaim } from "./pool-ledger.js";

const SCOPE = "public-joint-diagnostic", UNIT = "checked_byte_credit_v1", QUOTA = "checked_bit_query_v1";
const A = "public.bit.a", B = "public.bit.b", CHECKER = "public-bit-check-v1", EXECUTOR = "public-byte-read-v1";
const signal = () => new AbortController().signal;
const namespace = { scope: SCOPE, protocolId: "public-xor-episode-v1", protocolVersion: "1",
  conditionHash: contentHashOf({ protocol: "two-ascii-bits-with-newline", objective: "100 byte credits for correct action minus actual checker bytes" }), utilityUnit: UNIT };
const policy: JointEmpiricalPolicy = { ...namespace, futureUses: 1, utilityScale: 100,
  utilityBounds: { minimum: -3, maximum: 97 }, priorStrength: 2, actions: ["choose-zero", "choose-one"],
  questions: [{ experimentRef: A, experimentVersion: "1", units: 1, outcomes: ["0", "1"] },
    { experimentRef: B, experimentVersion: "1", units: 1, outcomes: ["0", "1"] }] };

type Episode = { readonly file: string; readonly episodeId: string; readonly measurementId: string; readonly supersedes?: string };

/** The declared host behavior is shared by the graph and actual action selection. It contains no probability model. */
function xorAction(a?: number, b?: number): 0 | 1 { return a === undefined || b === undefined ? 0 : (a ^ b) as 0 | 1; }

function xorGraph(a: string, b: string): InformationDecision {
  const rows: { a?: number; b?: number }[] = [{}, { a: 0 }, { a: 1 }, { b: 0 }, { b: 1 },
    { a: 0, b: 0 }, { a: 0, b: 1 }, { a: 1, b: 0 }, { a: 1, b: 1 }];
  const id = (row: { a?: number; b?: number }) => `bits-${row.a ?? "u"}-${row.b ?? "u"}`;

  return { initialState: id({}), states: rows.map(row => ({ id: id(row), action: xorAction(row.a, row.b), transitions: [
    ...(row.a === undefined ? [{ questionId: a, next: [id({ ...row, a: 0 }), id({ ...row, a: 1 })] }] : []),
    ...(row.b === undefined ? [{ questionId: b, next: [id({ ...row, b: 0 }), id({ ...row, b: 1 })] }] : []),
  ] })) };
}

async function files(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "trylo-joint-data-")), boardRoot = path.join(root, "board");

  t.after(() => rm(root, { recursive: true, force: true }));
  const registry = new Map<string, Episode>(), reads = new Map<string, { calls: number; bytes: number }>();
  let callbacks = 0;

  function count(file: string, bytes: number) {
    const old = reads.get(file) ?? { calls: 0, bytes: 0 };
    reads.set(file, { calls: old.calls + 1, bytes: old.bytes + bytes });
  }

  async function byte(file: string, position: number, abort: AbortSignal) {
    abort.throwIfAborted();
    const handle = await open(file, "r");
    try { const buffer = Buffer.alloc(1), actual = await handle.read(buffer, 0, 1, position);
    count(file, actual.bytesRead);
      abort.throwIfAborted();
    return buffer.subarray(0, actual.bytesRead); }
    finally { await handle.close(); }
  }

  async function whole(file: string, abort: AbortSignal) {
    const buffer = await readFile(file, { signal: abort });
    count(file, buffer.length);
    return buffer;
  }

  async function put(ref: string, bits: string, options: { episodeId?: string; measurementId?: string; supersedes?: string; file?: string } = {}) {
    const file = options.file ?? path.join(root, `${ref}.txt`);
    await writeFile(file, bits);
    registry.set(ref, { file, episodeId: options.episodeId ?? ref, measurementId: options.measurementId ?? `host:${ref}`,
      ...(options.supersedes === undefined ? {} : { supersedes: options.supersedes }) });
    return file;
  }

  async function read(ref: string, abort: AbortSignal): Promise<JointOutcome | undefined> {
    callbacks += 1;
    const entry = registry.get(ref);
    if (entry === undefined) return undefined;

    const a = await byte(entry.file, 0, abort), b = await byte(entry.file, 1, abort);
    const actionChecks = [await whole(entry.file, abort), await whole(entry.file, abort)];
    const provenance = { schemaVersion: 1, episodeId: entry.episodeId, queryReads: [{ offset: 0, bytes: [...a] }, { offset: 1, bytes: [...b] }],
      actionChecks: actionChecks.map(buffer => ({ bytes: [...buffer], bytesRead: buffer.length })),
      costDefinition: "one credit per actual byte read; correct action earns 100 credits; action utility subtracts its independent checker read" };
    const base = { ...namespace, measurementId: entry.measurementId, episodeId: entry.episodeId,
      sourceRef: `execution:${contentHashOf(provenance)}`, provenanceJson: canonicalJson(provenance),
      ...(entry.supersedes === undefined ? {} : { supersedes: entry.supersedes }) };

    if (a.length !== 1 || b.length !== 1 || !/^[01]{2}\n$/.test(actionChecks[0]!.toString("utf8"))
      || !actionChecks[0]!.equals(actionChecks[1]!) || a[0] !== actionChecks[0]![0] || b[0] !== actionChecks[0]![1]) {
      return { ...base, kind: "unknown", reason: "public_episode_not_established" };
    }

    const values = [a.toString(), b.toString()];

    return { ...base, kind: "measured", observations: [A, B].map((experimentRef, index) => ({ experimentRef,
      experimentVersion: "1", outcome: values[index]!, fullStudyCost: index === 0 ? a.length : b.length,
      checkRef: `checker:${contentHashOf({ episodeId: entry.episodeId, experimentRef, bytes: index === 0 ? [...a] : [...b] })}` })),
      actionUtilities: policy.actions.map((actionId, index) => { const buffer = actionChecks[index]!, correct = xorAction(buffer[0]! - 48, buffer[1]! - 48) === index;
        return { actionId, value: (correct ? 100 : 0) - buffer.length,
          checkRef: `checker:${contentHashOf({ episodeId: entry.episodeId, actionId, rawBytes: [...buffer], correct, checkerBytes: buffer.length })}` }; }) };
  }

  return { root, boardRoot, registry, put, read, byte, whole, reads: (file: string) => reads.get(file) ?? { calls: 0, bytes: 0 },
    callbacks: () => callbacks, state: async () => { const loaded = await createBoardReader(boardRoot).load();
      assert.ok(loaded.ok, JSON.stringify(loaded));
    return loaded.state; } };
}

test("real complete episodes fit the joint model and two separately grounded questions execute through ordinary finish", async t => {
  const h = await files(t), capture = createTopicJointMeasurementSource({ boardRoot: h.boardRoot, namespace, enabled: () => true, read: h.read });
  const history = ["00\n", "00\n", "00\n", "01\n", "10\n", "11\n"];

  for (const [index, bits] of history.entries()) {
    const ref = `history-${index}`;
    await h.put(ref, bits);
    assert.equal((await capture.capture(ref, signal())).status, "recorded");
  }

  // The new target's oracle stays local to actual byte probes; it is not captured into the Board before valuation.
  const targetFile = await h.put("target", "01\n"), initialTarget = { id: "target", sourceHash: contentHashOf({ immutablePublicBytes: "01\n" }) };
  let target = initialTarget, lastPrepared: PreparedTopicDomain | undefined, decisionCalls = 0, runs = 0;
  const observed: { a?: number; b?: number } = {}, receipts = new Map<string, { expected: string; json: string }>();
  const claimProofs: { claim: number; started: number; questionId: string }[] = [];
  const probe: TopicProbePort = {
    async run(input) {
      const state = await h.state(), facts = state.rewardV2Facts ?? [], claim = facts.find(row => row.id === input.claimId);
      const starts = facts.flatMap(fact => { const raw = JSON.parse(fact.payloadJson);
      return raw.type === "ws1_topic_probe_started"
        && raw.expected.spendId === input.spendId ? [{ fact, expected: raw.expected }] : []; });

      assert.ok(claim);
      assert.equal(starts.length, 1);
      assert.ok(claim.sequence < starts[0]!.fact.sequence);
      const parsedClaim = readPoolClaim(JSON.parse(claim.payloadJson));
      assert.ok(parsedClaim);
      assert.equal(parsedClaim.units, 1);
      assert.equal(parsedClaim.spendId, input.spendId);
      assert.equal(input.topic.schemaVersion, 3);
      if (input.topic.schemaVersion !== 3) throw new Error("fixture_topic");

      const ref = input.topic.experiment.ref, index = ref === A ? 0 : ref === B ? 1 : -1;
      assert.ok(index >= 0);
      const bytes = await h.byte(h.registry.get(target.id)!.file, index, input.signal);
      runs += 1;
      assert.equal(bytes.length, 1);
      const outcome = bytes[0]! - 48;
      assert.ok(outcome === 0 || outcome === 1);

      if (index === 0) observed.a = outcome;else observed.b = outcome;

      const { topic: _topic, signal: _signal, ...expected } = input;
      const physical = { target, offset: index, rawBytes: [...bytes], fullStudyCost: bytes.length, actualAction: xorAction(observed.a, observed.b) };
      const receiptRef = `checker:${contentHashOf([input.spendId, physical])}`;
      const receipt = { ...expected, schemaVersion: 1, receiptRef, sourceRef: `checker:${contentHashOf(physical)}`,
        measurementHash: contentHashOf(physical), outcome };

      receipts.set(receiptRef, { expected: canonicalJson(expected), json: canonicalJson(receipt) });
      claimProofs.push({ claim: claim.sequence, started: starts[0]!.fact.sequence, questionId: input.questionId });
      return receiptRef;
    },

    async readObservation(ref, expected) {
      const stored = receipts.get(ref);
      assert.ok(stored);
      assert.equal(stored.expected, canonicalJson(expected));
      return stored.json;
    },
  };
  const source = createJointEmpiricalDomainModelSource({ boardRoot: h.boardRoot, domain: "tool", policy, quotaUnit: QUOTA,
    descriptors: [{ ref: A, version: "1", domain: "tool", purpose: "Read the first public target bit" },
      { ref: B, version: "1", domain: "tool", purpose: "Read the second public target bit" }],
    checkerVersion: CHECKER, executionVersion: EXECUTOR, decisionVersion: "host-xor-known-bits-v1", enabled: () => true,
    available: () => true, currentTarget: () => target, probe,

    decision(input) {
      decisionCalls += 1;
      assert.equal(h.reads(targetFile).calls, 0, "preparation must not open target bytes");
      assert.equal(input.measurements.length, 6);
      assert.ok(input.measurements.every(row => row.episodeId !== target.id));
      const ids = input.questions.map(row => row.questionId), a = input.questions.find(row => row.experimentRef === A)!.questionId,
        b = input.questions.find(row => row.experimentRef === B)!.questionId;
      return { status: "ready", decision: xorGraph(a, b), basisHash: contentHashOf({ target: input.target, version: "host-xor-known-bits-v1", initialKnownBits: {} }),
        provenanceJson: canonicalJson({ rule: "XOR after both bits; otherwise choose zero", questionIds: ids, numericParameters: "fitted only from complete historical episodes" }) };
    } });
  const instrumented: TopicDomainModelSource = { ...source, async prepare(request) {
    const before = h.reads(targetFile).calls, prepared = await source.prepare(request);
    assert.equal(h.reads(targetFile).calls, before);
    if (prepared !== undefined) lastPrepared = prepared;
    return prepared;
  } };
  const system = createTopicLearningSystem({ boardRoot: h.boardRoot, scope: SCOPE, enabled: () => true, configuration: {
    policy: { poolId: "joint-data-mainline", algorithmVersion: "joint-data-mainline-v1", totalQuota: 2, utilityUnit: UNIT, quotaUnit: QUOTA },
    perTurnQuota: 2, domainRelation: "separable", experiments: [], domainModels: [instrumented] } });
  const rebuilt = topicJointMeasurements((await h.state()).rewardV2Facts ?? [], SCOPE);
  assert.equal(rebuilt.length, 6);
  assert.ok(rebuilt.every(row => row.kind === "measured"));
  const initialCatalog = system.descriptors((await h.state()).rewardV2Facts);
  assert.deepEqual(initialCatalog.map(row => row.ref), [A, B]);

  async function admit(ref: string, turnId: string) {
    const runtime = createTopicLearningRuntime({ boardRoot: h.boardRoot, scope: SCOPE, sessionId: "joint-session", turnId,
      enabled: () => true, emit: () => {}, control: { system, requestId: `finish:${turnId}`, totalQuota: 2 } });
    const port = runtime.attach(undefined), event = (kind: string, sequence: number, payload: Envelope["payload"]): Envelope => ({
      protocolVersion: "0.0", kind, sequence, eventId: `${turnId}:${sequence}`, timestamp: "2026-11-03T00:00:00.000Z",
      sessionId: "joint-session", turnId, attemptId: "real-file-read", producerId: "public-file-host", producerSequence: sequence, payload });

    runtime.capture(event("tool_use", 1, { toolCallId: turnId, name: "read_file", arguments: {} }));
    await h.whole(h.registry.get("history-0")!.file, signal());
    runtime.capture(event("tool_result", 2, { toolCallId: turnId, status: "succeeded", output: "public file read completed" }));
    const report = { turnId, failures: [], succeededTools: ["read_file"], toolNames: ["read_file"] };

    await port.observe({ ...report, beat: 1 });
    const slot = await port.requestSlot({ turnId, beat: 2, toolNames: ["read_file"] });
    assert.ok(slot);
    const proposal = { schemaVersion: 3, experimentRef: ref, question: ref === A ? "当前目标的第一位是什么？" : "当前目标的第二位是什么？",
      whenRelevant: "需要为当前公开目标选择动作时", expectedChange: "按已声明的两位规则选择动作", citations: [{ evidenceRef: `${turnId}:2`, quote: '"reportedStatus":"succeeded"' }] };

    await port.observe({ ...report, beat: 2, proposal: JSON.stringify(proposal) });
    assert.equal(runtime.inspect().phase, "closed");
    return runtime;
  }

  await admit(A, "first-question");
  assert.deepEqual(system.descriptors((await h.state()).rewardV2Facts).map(row => row.ref), [B], "the next common slot must advertise only the missing observation");
  const runtime = await admit(B, "second-question");
  const before = await h.state(), candidates = topicDomainCandidates(before.rewardV2Facts ?? [], SCOPE, "tool", before.sequence);

  assert.equal(candidates.length, 2);
  assert.notEqual(candidates[0]!.windowJson, candidates[1]!.windowJson);
  const badDuplicate = JSON.stringify({ ...JSON.parse(candidates[1]!.proposalJson), experimentRef: A });

  assert.equal(readTopicSubmission(badDuplicate, candidates[1]!.windowJson).ok, false);
  assert.equal(h.reads(targetFile).calls, 0);
  const result = await runtime.finish(signal());
  assert.ok(result);
  assert.equal(result.status, "completed");
  assert.equal(result.purpose, "valuation");
  assert.equal(result.results[0]?.processed, 2);
  assert.equal(runs, 2);
  assert.equal(h.reads(targetFile).bytes, 2);
  assert.equal(xorAction(observed.a, observed.b), 1);
  assert.ok(lastPrepared);
  assert.ok(lastPrepared.input.modelJson);
  assert.ok(decisionCalls >= 1);
  const fitted = JSON.parse(lastPrepared.input.modelJson), provenance = JSON.parse(lastPrepared.input.modelProvenanceJson!);

  assert.deepEqual(fitted.prior, [3.5 / 8, 1.5 / 8, 1.5 / 8, 1.5 / 8]);
  assert.deepEqual(provenance.source.support.stateCounts, [3, 1, 1, 1]);
  assert.deepEqual(fitted.questions.map((row: { cost: number }) => row.cost), [0.01, 0.01]);
  assert.deepEqual(fitted.utilities, [[0.97, -0.03, -0.03, 0.97], [-0.03, 0.97, 0.97, -0.03]]);
  assert.deepEqual(fitted.questions[0].likelihood, [[1, 0], [1, 0], [0, 1], [0, 1]]);
  const frozenCandidates = "candidates" in lastPrepared.input ? lastPrepared.input.candidates! : [];

  assert.deepEqual(frozenCandidates.map(row => row.windowJson), candidates.map(row => row.windowJson));
  const after = await h.state(), facts = after.rewardV2Facts ?? [];
  const frameFact = facts.find(fact => JSON.parse(fact.payloadJson).type === "ws1_topic_execution_init");
  assert.ok(frameFact);
  const frame = JSON.parse(frameFact.payloadJson) as TopicExecutionFrame, replayed = replayTopicExecution(frame, facts);

  assert.equal(replayed.applied, 2);
  assert.equal(replayed.remaining, 0);
  assert.equal(replayed.unknown, false);
  const posterior = JSON.parse(replayed.modelJson);
  assert.deepEqual(posterior.prior, [0, 1, 0, 0]);
  assert.equal(posterior.questions.length, 0);
  assert.equal(claimProofs.length, 2);
  assert.notEqual(claimProofs[0]!.questionId, claimProofs[1]!.questionId);
  const claimCount = () => (h.state()).then(state => (state.rewardV2Facts ?? []).filter(fact => readPoolClaim(JSON.parse(fact.payloadJson)) !== undefined).length);

  assert.equal(await claimCount(), 2);
  const known = await capture.capture("target", signal());
  assert.equal(known.status, "recorded");
  const knownState = await h.state(), knownCandidates = topicDomainCandidates(knownState.rewardV2Facts ?? [], SCOPE, "tool", knownState.sequence);

  assert.equal(await source.prepare({ scope: SCOPE, boardSequence: knownState.sequence, maxQuota: 2, candidates: knownCandidates, signal: signal() }), undefined,
    "a trustworthy complete target episode is already known, never hidden as training-only data");
  const callsBeforeKnownRequest = runs;

  await system.invoke({ requestId: "already-known-target", totalQuota: 2 }, signal());
  assert.equal(runs, callsBeforeKnownRequest);
  assert.equal(await claimCount(), 2);
  const nextTargetFile = await h.put("next-target", "10\n");

  target = { id: "next-target", sourceHash: contentHashOf({ immutablePublicBytes: "10\n" }) };
  assert.deepEqual(system.descriptors((await h.state()).rewardV2Facts).map(row => row.ref), [A, B]);
  assert.notEqual(system.descriptors((await h.state()).rewardV2Facts)[0]!.conditionHash, initialCatalog[0]!.conditionHash);
  const changedState = await h.state();
  assert.equal(await source.prepare({ scope: SCOPE, boardSequence: changedState.sequence, maxQuota: 2, candidates, signal: signal() }), undefined);
  const oldStart = facts.map(fact => JSON.parse(fact.payloadJson)).find(raw => raw.type === "ws1_topic_probe_started");
  assert.ok(oldStart);
  const oldTopic = candidates.find(candidate => candidate.topic.topicId === oldStart.expected.questionId)!.topic;

  await assert.rejects(lastPrepared.probe.run({ ...(oldStart.expected as TopicProbeExpectation), topic: oldTopic, signal: signal() }), /topic_joint_target_changed/);
  assert.equal(runs, callsBeforeKnownRequest);
  assert.equal(h.reads(nextTargetFile).calls, 0);
});

test("joint source gates IO, preserves immutable identity and resolves genuine file-backed corrections without double-counting", async t => {
  const h = await files(t), disabledRoot = path.join(h.root, "disabled"), cancelledRoot = path.join(h.root, "cancelled");
  const disabled = createTopicJointMeasurementSource({ boardRoot: disabledRoot, namespace, enabled: () => false, read: h.read });

  assert.equal((await disabled.capture("unused", signal())).status, "disabled");
  const cancelled = new AbortController();
  cancelled.abort();
  const stopped = createTopicJointMeasurementSource({ boardRoot: cancelledRoot, namespace, enabled: () => true, read: h.read });

  assert.equal((await stopped.capture("unused", cancelled.signal)).status, "cancelled");
  assert.equal(h.callbacks(), 0);
  await assert.rejects(access(disabledRoot));
  await assert.rejects(access(cancelledRoot));
  const source = createTopicJointMeasurementSource({ boardRoot: h.boardRoot, namespace, enabled: () => true, read: h.read });
  const file = await h.put("original", "00\n", { episodeId: "same-episode", measurementId: "host:original" });
  const original = await source.capture("original", signal());
  assert.equal(original.status, "recorded");
  if (original.status !== "recorded") return;

  const first = await h.state(), idempotent = await source.capture("original", signal());
  assert.equal(idempotent.status, "recorded");

  if (idempotent.status === "recorded") assert.equal(idempotent.idempotent, true);
  assert.equal((await h.state()).sequence, first.sequence);
  await h.put("duplicate-root", "00\n", { file, episodeId: "same-episode", measurementId: "host:duplicate" });
  assert.deepEqual(await source.capture("duplicate-root", signal()), { status: "rejected", reason: "topic_joint_episode_conflict" });
  await h.put("correction", "01\n", { file, episodeId: "same-episode", measurementId: "host:correction", supersedes: "host:original" });
  const corrected = await source.capture("correction", signal());
  assert.equal(corrected.status, "recorded");
  if (corrected.status !== "recorded") return;

  assert.equal(corrected.measurement.supersedes, original.measurement.id);
  const durable = topicJointMeasurements((await h.state()).rewardV2Facts ?? [], SCOPE);
  assert.equal(durable.length, 2);
  const fitted = buildJointEmpiricalModel({ policy, boardSequence: (await h.state()).sequence, measurements: durable,
    questions: [{ experimentRef: A, questionId: "question-a" }, { experimentRef: B, questionId: "question-b" }], decision: xorGraph("question-a", "question-b") });

  assert.equal(fitted.status, "ready");
  if (fitted.status === "ready") {
    assert.deepEqual(fitted.provenance.supportIds, [corrected.measurement.id]);
    assert.deepEqual(fitted.provenance.stateCounts, [1]);
    assert.deepEqual(fitted.provenance.observationVectors, [["0", "1"]]);
    assert.deepEqual(JSON.parse(fitted.modelJson).prior, [1]);
  }

  await h.put("unknown", "??\n");
  const unknown = await source.capture("unknown", signal());
  assert.equal(unknown.status, "recorded");
  if (unknown.status !== "recorded") return;

  assert.equal(unknown.measurement.kind, "unknown");
  assert.equal("observations" in unknown.measurement, false);
  assert.equal("actionUtilities" in unknown.measurement, false);
  const state = await h.state(), unvalued = buildJointEmpiricalModel({ policy, boardSequence: state.sequence,
    measurements: topicJointMeasurements(state.rewardV2Facts ?? [], SCOPE), questions: [{ experimentRef: A, questionId: "question-a" }, { experimentRef: B, questionId: "question-b" }],
    decision: xorGraph("question-a", "question-b") });

  assert.deepEqual(unvalued, { status: "unvalued", reason: "topic_joint_unknown" });
});
