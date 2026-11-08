import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRewardV2BoardPort } from "../reward/v2-board-port.js";
import { withBoardWriter } from "../../adapters/learning-store/file-event-store.js";
import { canonicalJson, contentHashOf, sha256Hex } from "../../learning/control/hash.js";
import type { TopicExperimentDescriptor } from "../../learning/domains/shared/topics/contracts.js";
import { topicExperimentBindingHash, readTopicExperimentBindingRecord, topicBindingMatchesSource } from "../../learning/domains/shared/topics/experiment-binding.js";
import { prepareTopicOpportunity } from "../../learning/domains/shared/topics/opportunity.js";
import { createPersistentTopicIntake } from "./intake.js";
import { createTopicExperimentBindingStore, topicExperimentBindings, type TopicExperimentBindingReadback } from "./experiment-binding.js";
import { topicDomainCandidates } from "./domain-candidates.js";
import type { TopicDomainModelCandidate, TopicDomainModelProvenance, TopicDomainModelSource } from "./domain-model.js";
import { createTopicDomainRuntime, type PreparedTopicDomain } from "./domain-runtime.js";
import { createTopicBudgetPool } from "./pool.js";
import { readPoolClaim } from "./pool-ledger.js";
import { createTopicLearningSystem } from "./system.js";
import { createTopicLearningRuntime } from "./runtime.js";
import { replayTopicExecution, type TopicExecutionFrame } from "./execution-state.js";
import type { TopicProbePort } from "./execution-contract.js";

const signal = () => new AbortController().signal;

async function base(t: { after: (fn: () => Promise<void>) => void }, scope: string) {
  const root = await mkdtemp(path.join(tmpdir(), "trylo-late-binding-")), boardRoot = path.join(root, "board");

  t.after(() => rm(root, { recursive: true, force: true }));
  const board = createRewardV2BoardPort(boardRoot, () => true);
  const intake = createPersistentTopicIntake({ boardRoot, scope, domain: "prompt", algorithmVersion: "late-binding-intake-v1", enabled: () => true });

  async function admit() {
    const view = await board.read(), window = { schemaVersion: 1, domain: "prompt", scope, boardSequence: view.revision,
      watermarks: [{ runId: "public-user-turn", throughSequence: 0 }], records: [{ ref: "public-unresolved-question", runId: "public-user-turn",
        sequence: 0, scope, origin: "user_statement", text: "此公开任务还有一个需要客观读取的问题。" }] };
    const proposal = { schemaVersion: 2, question: "当前公开任务尚缺的客观信息是什么？", whenRelevant: "再次选择处理动作时",
      expectedChange: "取得已批准的观察后选择动作", citations: [{ evidenceRef: "public-unresolved-question", quote: "还有一个需要客观读取的问题" }] };
    const result = await intake.ingest(JSON.stringify(proposal), JSON.stringify(window));
    assert.equal(result.status, "persisted");

    if (result.status !== "persisted") throw new Error("fixture_intake");

    const saved = await board.read(), fact = saved.facts.find(row => JSON.parse(row.payloadJson).type === "ws1_topic_candidate")!;

    return { topic: result.topic, proposalJson: canonicalJson(proposal), windowJson: canonicalJson(window), fact };
  }

  return { root, boardRoot, board, scope, admit };
}

async function pad(boardRoot: string, scope: string, count: number) {
  const result = await withBoardWriter(boardRoot, async store => {
    const loaded = await store.load();
    assert.ok(loaded.ok);
    if (!loaded.ok) throw new Error("fixture_board");
    let sequence = loaded.state.sequence;

    for (let index = 0; index < count; index++) {
      const id = `late-binding-padding:${index}`, written = await store.apply({ type: "record_reward_v2_fact", commandId: `rw2:${id}`,
        issuedAt: "2026-11-03T00:00:00.000Z", expectedSequence: sequence,
        fact: { id, scope, algorithmVersion: "late-binding-padding-v1", kind: "projection", payloadJson: canonicalJson({ type: "unrelated_public_padding", index }) } });
      assert.ok(written.ok);
      if (!written.ok) throw new Error("fixture_padding");
      sequence = written.state.sequence;
    }

    return sequence;
  });
  assert.equal(typeof result, "number");
}

function finitePrepared(candidate: TopicDomainModelCandidate, prefix: number, quota: number, probe: TopicProbePort): PreparedTopicDomain {
  const binding = candidate.experimentBinding!;
  const model = { schemaVersion: 2, prior: [0.5, 0.5], utilities: [[1, 0], [0, 1]],
    questions: [{ id: candidate.topic.topicId, units: 1, cost: 0.01, likelihood: [[1, 0], [0, 1]] }],
    decision: { initialState: "unread", states: [{ id: "unread", action: 0, transitions: [{ questionId: candidate.topic.topicId, next: ["zero", "one"] }] },
      { id: "zero", action: 0, transitions: [] }, { id: "one", action: 1, transitions: [] }] } };
  const checkerVersion = "public-file-check-v1", executionVersion = "public-file-execution-v1", utilityUnit = "declared_finite_utility", quotaUnit = "checked_file_query";
  const domainDecisionHash = contentHashOf({ rule: "use the checked public bit", sourceTopicId: candidate.topic.topicId });
  const probeBindingHash = contentHashOf({ checkerVersion, executionVersion });
  const provenance: TopicDomainModelProvenance = { schemaVersion: 1, type: "ws1_topic_domain_model", scope: candidate.topic.scope,
    domain: "tool", boardSequence: prefix, utilityUnit, quotaUnit, modelHash: contentHashOf(model), domainDecisionHash, probeBindingHash,
    checkerVersion, executionVersion, timeoutMs: 5000,
    candidates: [{ topicId: candidate.topic.topicId, proposalSha256: sha256Hex(candidate.proposalJson), windowSha256: sha256Hex(candidate.windowJson),
      experimentBindingHash: topicExperimentBindingHash(binding) }],
    source: { algorithmVersion: "declared-finite-file-fixture-v1", recordRefs: [binding.id], recordDigest: contentHashOf(binding),
      assumptions: ["Explicit finite diagnostic hypothesis for this protocol; probabilities and net value are not empirically calibrated",
        "Declared objective: a correct action earns 100 byte credits; the one-byte check costs 0.01 normalized units"] } };

  return { input: { candidates: [{ proposalJson: candidate.proposalJson, windowJson: candidate.windowJson, experimentBinding: binding }],
    modelJson: canonicalJson(model), utilityUnit, quotaUnit, maxQuota: quota, valuationBoardSequence: prefix, domainDecisionHash, probeBindingHash,
    modelProvenanceJson: canonicalJson(provenance), modelProvenanceHash: contentHashOf(provenance) }, probe, checkerVersion, executionVersion, timeoutMs: 5000 };
}

async function finiteFixture(t: { after: (fn: () => Promise<void>) => void }, padding = 0, bind = true) {
  const h = await base(t, "late-binding-finite"), original = await h.admit();
  if (padding > 0) await pad(h.boardRoot, h.scope, padding);

  const file = path.join(h.root, "public-bit.txt");
  await writeFile(file, "1");
  const descriptor: TopicExperimentDescriptor = { ref: "public.file.bit", version: "1", domain: "tool", purpose: "Read the public file bit",
    conditionHash: contentHashOf({ protocol: "one-public-bit" }) };
  let mapping: TopicExperimentBindingReadback = { topicId: original.topic.topicId, scope: h.scope, experimentRef: descriptor.ref,
    experimentVersion: descriptor.version, conditionHash: descriptor.conditionHash!, resolverVersion: "explicit-host-map-v1", sourceRef: "checker:public-host-mapping" };
  let readerCalls = 0, runs = 0, known = false, tamper = false;
  const source = { pending: () => ["host-map"], read: async () => {
    readerCalls += 1;
    return mapping;
  } };
  const store = createTopicExperimentBindingStore({ boardRoot: h.boardRoot, scope: h.scope, enabled: () => true, source, catalog: () => [descriptor] });

  if (bind) assert.equal((await store.capture("host-map", signal())).status, "recorded");

  const actual = new Map<string, { expected: string; receipt: string }>();
  const probe: TopicProbePort = {
    async run(input) {
      runs += 1;
      const prefix = await h.board.read(), record = topicExperimentBindings(prefix.facts, h.scope)[0];
      assert.ok(record);
      assert.equal(input.topic.schemaVersion, 2);
      assert.equal(input.topic.domain, "prompt");
      assert.equal(input.domain, "tool");
      assert.deepEqual(input.experimentBinding, record);
      assert.equal(input.experimentBindingHash, topicExperimentBindingHash(record));
      const claim = prefix.facts.find(row => row.id === input.claimId);
      assert.ok(claim);
      const start = prefix.facts.find(row => {
        const raw = JSON.parse(row.payloadJson);
        return raw.type === "ws1_topic_probe_started" && raw.expected.spendId === input.spendId;
      });

      assert.ok(start);
      assert.ok(claim.sequence < start.sequence);
      const bytes = await readFile(file, { signal: input.signal });
      assert.equal(bytes.toString(), "1");
      known = true;
      const { topic: _topic, signal: _signal, experimentBinding: _binding, ...expected } = input;
      const ref = `checker:${contentHashOf([input.spendId, [...bytes]])}`, receipt = { ...expected, schemaVersion: 1, receiptRef: ref,
        sourceRef: `checker:${contentHashOf([...bytes])}`, measurementHash: contentHashOf({ actualBytes: [...bytes], actualByteCost: bytes.length }), outcome: 1 };

      actual.set(ref, { expected: canonicalJson(expected), receipt: canonicalJson(receipt) });
      return ref;
    },

    async readObservation(ref, expected) {
      const saved = actual.get(ref);
      assert.ok(saved);
      assert.equal(saved.expected, canonicalJson(expected));
      return tamper ? canonicalJson({ ...JSON.parse(saved.receipt), experimentBindingHash: "0".repeat(64) }) : saved.receipt;
    },
  };
  let prepared: PreparedTopicDomain | undefined;
  const modelSource: TopicDomainModelSource = { domain: "tool", utilityScale: 1, available: () => !known, descriptors: () => [descriptor],

    prepare(request) { const candidate = request.candidates.find(row => row.topic.topicId === original.topic.topicId);
    if (candidate === undefined) return undefined;
      prepared = finitePrepared(candidate, request.boardSequence, request.maxQuota, probe);
    return prepared; } };
  const configuration = { policy: { poolId: "late-binding-finite", algorithmVersion: "late-binding-finite-v1", totalQuota: 2,
    utilityUnit: "declared_finite_utility", quotaUnit: "checked_file_query" }, perTurnQuota: 1,
    experiments: [], domainModels: [modelSource], bindings: source, domainRelation: "separable" as const };
  const system = () => createTopicLearningSystem({ boardRoot: h.boardRoot, scope: h.scope, enabled: () => true, configuration });
  const runtime = (requestId: string) => createTopicLearningRuntime({ boardRoot: h.boardRoot, scope: h.scope, sessionId: "late-session", turnId: requestId,
    enabled: () => true, emit: () => {}, control: { system: system(), requestId, totalQuota: 1 } });

  return { ...h, original, descriptor, store, source, probe, configuration, system, runtime, prepared: () => prepared,
    runs: () => runs, readerCalls: () => readerCalls, setMapping: (value: TopicExperimentBindingReadback) => { mapping = value; }, mapping: () => mapping,
    tamper: () => { tamper = true; } };
}

test("an old v2 prompt candidate binds on its real Board and executes unchanged through ordinary finish", async t => {
  const h = await finiteFixture(t, 260), before = await h.board.read();

  assert.equal(before.facts.slice(-256).some(row => row.id === h.original.fact.id), false);
  const record = topicExperimentBindings(before.facts, h.scope)[0]!;
  assert.ok(record);
  assert.equal(record.binding.sourceFactId, h.original.fact.id);
  const candidates = topicDomainCandidates(before.facts, h.scope, "tool", before.revision);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]!.topic.topicId, h.original.topic.topicId);
  assert.equal(candidates[0]!.topic.domain, "prompt");
  assert.equal(candidates[0]!.windowJson, h.original.windowJson);
  assert.equal(candidates[0]!.topic.basis.boardSequence, 0);
  const result = await h.runtime("old-question-finish").finish(signal());
  assert.ok(result);
  assert.equal(result.status, "completed");
  assert.equal(result.purpose, "valuation");
  assert.equal(result.results[0]?.processed, 1);
  assert.equal(h.runs(), 1);
  const prepared = h.prepared()!;
  assert.equal(JSON.parse(prepared.input.modelJson!).questions[0].id, h.original.topic.topicId);
  assert.equal(JSON.parse(prepared.input.modelProvenanceJson!).candidates[0].experimentBindingHash, topicExperimentBindingHash(record));
  const after = await h.board.read();
  assert.equal(after.facts.find(row => row.id === h.original.fact.id)!.payloadJson, h.original.fact.payloadJson);
  const frameFact = after.facts.find(row => JSON.parse(row.payloadJson).type === "ws1_topic_execution_init")!;
  const frame = JSON.parse(frameFact.payloadJson) as TopicExecutionFrame, replay = replayTopicExecution(frame, after.facts);

  assert.equal(frame.domain, "tool");
  assert.equal(replay.applied, 1);
  assert.equal(replay.unknown, false);
  assert.deepEqual(JSON.parse(replay.modelJson).prior, [0, 1]);
  const started = after.facts.map(row => JSON.parse(row.payloadJson)).find(raw => raw.type === "ws1_topic_probe_started");
  const observed = after.facts.map(row => JSON.parse(row.payloadJson)).find(raw => raw.type === "ws1_topic_probe_result");

  assert.equal(started.expected.experimentBindingHash, topicExperimentBindingHash(record));
  assert.equal(observed.receipt.experimentBindingHash, started.expected.experimentBindingHash);
  const count = after.revision, retried = await h.system().invoke({ requestId: "old-question-finish", totalQuota: 1 }, signal());

  assert.equal(retried.status, "previous");
  assert.equal(h.runs(), 1);
  assert.equal((await h.board.read()).revision, count);
});

test("self-consistent relation data absent from the Board cannot authorize the actual domain runtime", async t => {
  const h = await finiteFixture(t, 0, false), pool = createTopicBudgetPool({ ...h.configuration.policy, boardRoot: h.boardRoot, scope: h.scope, enabled: () => true });

  assert.equal((await pool.open()).status, "open");
  const prefix = await h.board.read();
  const body = { schemaVersion: 1 as const, sourceFactId: h.original.fact.id, sourcePayloadHash: contentHashOf(JSON.parse(h.original.fact.payloadJson)),
    topicId: h.original.topic.topicId, scope: h.scope, domain: "tool" as const, experiment: { ref: h.descriptor.ref, version: h.descriptor.version,
      conditionHash: h.descriptor.conditionHash! }, bindingBoardSequence: prefix.revision - 1, resolverVersion: "fake-but-shaped-v1", sourceRef: "checker:fake-shape" };
  const fake = readTopicExperimentBindingRecord({ id: `topic-binding:${contentHashOf(body)}`, sequence: prefix.revision, binding: body });
  assert.ok(fake);
  const candidate = { proposalJson: h.original.proposalJson, windowJson: h.original.windowJson, topic: h.original.topic, experimentBinding: fake };
  const prepared = finitePrepared(candidate, prefix.revision, 1, h.probe);
  assert.equal(prepareTopicOpportunity(prepared.input).status, "offered");
  const runtime = createTopicDomainRuntime({ boardRoot: h.boardRoot, domain: "tool", scope: h.scope, pool, enabled: () => true, prepareInput: () => prepared });

  assert.equal(runtime.status, "ready");
  if (runtime.status !== "ready") return;

  assert.equal((await runtime.port.prepare({ boardSequence: prefix.revision, maxQuota: 1, signal: signal() })).status, "rejected");
  assert.equal(h.runs(), 0);
  assert.equal((await h.board.read()).facts.filter(row => readPoolClaim(JSON.parse(row.payloadJson)) !== undefined).length, 0);
});

test("binding gates and immutable mapping stay strict, and a tampered receipt cannot update the model", async t => {
  const h = await finiteFixture(t), before = await h.board.read(), originalRecord = topicExperimentBindings(before.facts, h.scope)[0]!;
  const same = await h.store.capture("host-map", signal());
  assert.equal(same.status, "idempotent");

  if (same.status === "idempotent") assert.deepEqual(same.binding, originalRecord);
  assert.equal((await h.board.read()).revision, before.revision);
  h.setMapping({ ...h.mapping(), conditionHash: "f".repeat(64) });
  assert.deepEqual(await h.store.capture("host-map", signal()), { status: "rejected", reason: "topic_binding_conflict" });
  h.setMapping({ ...h.mapping(), scope: "another-scope" });
  assert.deepEqual(await h.store.capture("host-map", signal()), { status: "rejected", reason: "topic_binding_scope_mismatch" });
  const alteredBody = { ...originalRecord.binding, sourcePayloadHash: "0".repeat(64) }, altered = readTopicExperimentBindingRecord({
    id: `topic-binding:${contentHashOf(alteredBody)}`, sequence: originalRecord.sequence, binding: alteredBody });
  assert.ok(altered);
  assert.equal(topicBindingMatchesSource(altered, h.original, before.revision), false);
  const disabledRoot = path.join(h.root, "never-created");
  let reads = 0;
  const disabled = createTopicExperimentBindingStore({ boardRoot: disabledRoot, scope: h.scope, enabled: () => false,
    source: { pending: () => ["disabled"], read: async () => {
      reads += 1;
      return h.mapping();
    } }, catalog: () => [h.descriptor] });

  assert.equal((await disabled.capture("disabled", signal())).status, "disabled");
  assert.equal(reads, 0);
  await assert.rejects(access(disabledRoot));
  h.setMapping({ ...h.mapping(), scope: h.scope, conditionHash: h.descriptor.conditionHash! });
  h.tamper();
  const result = await h.runtime("bad-receipt").finish(signal());
  assert.ok(result);
  assert.equal(result.status, "partial", JSON.stringify(result));
  assert.equal(result.results.find(row => row.domain === "tool")?.status, "unknown", JSON.stringify(result));
  assert.equal(h.runs(), 1);
  const state = await h.board.read(), frame = JSON.parse(state.facts.find(row => JSON.parse(row.payloadJson).type === "ws1_topic_execution_init")!.payloadJson) as TopicExecutionFrame;
  const replay = replayTopicExecution(frame, state.facts);
  assert.equal(replay.unknown, true);
  assert.equal(replay.applied, 0);
  assert.deepEqual(JSON.parse(replay.modelJson).prior, [0.5, 0.5]);
  assert.equal(state.facts.filter(row => readPoolClaim(JSON.parse(row.payloadJson)) !== undefined).length, 1);
});
