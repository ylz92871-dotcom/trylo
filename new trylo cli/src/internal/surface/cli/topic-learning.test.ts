import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, access, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { executeTurn, isTurnFailure, type TurnHostInput } from "./host.js";
import { topicRuntimeFor } from "./topic-wiring.js";
import { methodBoardRoot } from "./learning-sink.js";
import { createFakePermission } from "../../loop/fakes.js";
import { createBoardReader } from "../../adapters/learning-store/file-event-store.js";
import type { ProviderPort, ProviderRequest, ProviderEvent } from "../../ports/provider.js";
import type { WarmRegistry } from "../../adapters/provider/warm.js";
import { workspaceIdentity } from "./wiring-catalog.js";
import { createTopicBudgetPool } from "../../integration/learning-topics/pool.js";
import { decodePoolLedger, poolKey, readPoolClaim } from "../../integration/learning-topics/pool-ledger.js";
import { contentHashOf } from "../../learning/control/hash.js";
import { topicMeasurements } from "../../integration/learning-topics/measurement-source.js";
import { readTopicCalibrationReceipt } from "../../integration/learning-topics/execution-contract.js";

const KNOWN_TOPIC_TEST_SECRET = "host-known-credential-AAAA-77";

function draft(ref: string, quote: string) {
  return JSON.stringify({ schemaVersion: 1, question: "当前读取方法在什么条件下仍适用？", whenRelevant: "后续读取时", expectedChange: "据条件调整处理方法",
    citations: [{ evidenceRef: ref, quote }], alternatives: [
      { id: "stable", explanation: "输入条件保持稳定" }, { id: "coincidence", explanation: "只是本次外部条件合适" }],
    discriminator: { observation: "固定方法比较输入条件", hypothesisIds: ["stable", "coincidence"] } });
}

async function fixture(mode?: string, variant = "normal") {
  const root = await mkdtemp(path.join(os.tmpdir(), "trylo-topic-host-"));
  await writeFile(path.join(root, "case.txt"), "PRIVATE-FILE-CONTENTS");
  const home = path.join(root, "profile"), output: string[] = [], warnings: string[] = [], requests: ProviderRequest[] = [];
  const provider: ProviderPort = { async *stream(request): AsyncIterable<ProviderEvent> {
    requests.push(request);
    yield { type: "stream_start", providerId: "fixture", model: request.model, warnings: [] };

    if (requests.length === 1 || (variant === "bounded-read" && requests.length % 2 === 1)) {
      yield { type: "tool_input_start", toolCallId: "read-one", name: "read_file" };
      yield { type: "tool_input_delta", toolCallId: "read-one", argumentsText: variant === "bounded-read" ? '{"path":"case.txt","offset":0,"limit":1}' : '{"path":"case.txt"}' };
      yield { type: "tool_input_end", toolCallId: "read-one" };
      yield { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true };
      return;
    }

    let text = request.responseSchema === undefined ? "done" : '{"ok":true}';
    const prompt = request.messages.find(message => message.content.includes("[topic evidence JSON]"));
    if (prompt !== undefined && variant !== "bounded-read") {
      const evidence = JSON.parse(prompt.content.split("[topic evidence JSON]\n")[1]!.split("\n[/topic evidence JSON]")[0]!) as { ref: string; text: string }[];
      const record = evidence[0]!;
      const proposal = variant === "oversized" ? JSON.stringify({ padding: "x".repeat(1300) })
        : variant === "sensitive-question" ? JSON.stringify({ ...JSON.parse(draft(record.ref, record.text)),
          question: `How does ${KNOWN_TOPIC_TEST_SECRET} affect the next read?` })
        : draft(record.ref, variant === "fake-quote" ? "forged" : record.text);

      text += "\n```trylo-learning\n" + proposal + "\n```";
    }

    yield { type: "text_start", blockId: "answer" };

    for (const part of text.match(/.{1,17}/gs) ?? []) yield { type: "text_delta", blockId: "answer", text: part };

    yield { type: "text_end", blockId: "answer" };
    yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
  } };
  const warm: WarmRegistry = { acquire: () => ({ provider, reused: true, key: "isolated-script" }), invalidate() {}, invalidateAll() {},
    stats: () => ({ builds: 0, hits: requests.length, rebuilds: 0, evictions: 0 }), size: () => 1 };
  const input: TurnHostInput = { text: "read the local file", sessionId: "session", turnId: "turn", correlationId: "correlation",
    workspaceRoot: root, workspaceId: "workspace", checkpointRoot: path.join(root, "undo"),
    providerId: "fixture", model: "fixture", endpoint: "", apiKey: undefined, warm,
    permission: createFakePermission("approved"), format: "stream-json", now: () => 0, maxIterations: 4,
    sink: { stdout: value => output.push(value), stderr: value => warnings.push(value) },
    ...(mode === undefined ? {} : { learning: { switch: mode, homeDir: home, env: { TRYLO_HOME: home } } }),
  };

  return { input, root, home, output, warnings, requests, boardRoot: methodBoardRoot(home, { TRYLO_HOME: home }) };
}

test("topic runtime follows method/tool opt-ins independently and skips strict schemas", async () => {
  const on = await fixture("method");
  assert.ok(topicRuntimeFor(on.input));
  assert.equal(topicRuntimeFor(on.input)!.ownsReadRouting, false);

  for (const mode of ["tool", "all"]) {
    const fx = await fixture(mode), topics = topicRuntimeFor(fx.input);
    assert.ok(topics);
    assert.equal(topics.ownsReadRouting, true);
    await assert.rejects(access(fx.boardRoot));
    assert.equal(topicRuntimeFor({ ...fx.input, responseSchema: { type: "object" } }), undefined);
  }

  for (const mode of [undefined, "user", "skill", "check", "invalid"]) {
    const fx = await fixture(mode);
    assert.equal(topicRuntimeFor(fx.input), undefined);
    await assert.rejects(access(fx.boardRoot));
  }

  assert.equal(topicRuntimeFor({ ...on.input, responseSchema: { type: "object" } }), undefined);
});

test("ordinary host run derives a topic from an actual tool event in the same two provider streams", async () => {
  const fx = await fixture("method"), result = await executeTurn(fx.input);

  assert.equal(isTurnFailure(result), false);
  if (isTurnFailure(result)) return;
  assert.equal(result.exitCode, 0);
  assert.equal(fx.requests.length, 2);
  assert.ok(fx.requests[1]!.messages.some(message => message.content.includes("[topic evidence JSON]")));
  assert.equal(fx.output.join("").includes("trylo-learning"), false);
  const loaded = await createBoardReader(fx.boardRoot).load();
  assert.ok(loaded.ok);
  if (!loaded.ok) return;

  assert.equal(loaded.state.rewardV2Facts?.length, 1);
  assert.equal(loaded.state.assets.length, 0);
  assert.equal(loaded.state.activations.length, 0);
  const saved = JSON.parse(loaded.state.rewardV2Facts![0]!.payloadJson);

  assert.equal(saved.type, "ws1_topic_candidate");
  assert.equal(saved.evidenceWindow.records[0].origin, "execution_result");
  assert.equal(JSON.stringify(saved.evidenceWindow).includes("PRIVATE-FILE-CONTENTS"), false);
  assert.equal(saved.evidenceWindow.scope, workspaceIdentity(fx.root));
});

test("tool-only host retains the shared topic channel without creating method assets", async () => {
  const fx = await fixture("tool"), result = await executeTurn(fx.input);

  assert.equal(isTurnFailure(result), false);
  if (isTurnFailure(result)) return;

  assert.equal(result.exitCode, 0);
  assert.equal(fx.requests.length, 2);
  assert.ok(fx.requests[1]!.messages.some(message => message.content.includes("[topic evidence JSON]")));
  const loaded = await createBoardReader(fx.boardRoot).load();
  assert.ok(loaded.ok);
  if (!loaded.ok) return;

  const candidates = (loaded.state.rewardV2Facts ?? []).map(row => JSON.parse(row.payloadJson))
    .filter(row => row.type === "ws1_topic_candidate");

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].evidenceWindow.records[0].origin, "execution_result");
  assert.equal(loaded.state.assets.length, 0);
  assert.equal(JSON.stringify(candidates).includes("PRIVATE-FILE-CONTENTS"), false);
});

test("a long workspace path uses the existing bounded workspace identity instead of aborting a user task", async () => {
  const fx = await fixture("method"), longPath = path.join("D:\\", ...Array.from({ length: 4 }, () => "segment".repeat(10)));
  assert.ok(longPath.length > 256);
  assert.doesNotThrow(() => topicRuntimeFor({ ...fx.input, workspaceRoot: longPath }));
  assert.ok(topicRuntimeFor({ ...fx.input, workspaceRoot: longPath }));
});

test("off and strict-schema runs keep the original streams without a topic prompt or candidate", async () => {
  for (const strict of [false, true]) {
    const fx = await fixture(strict ? "method" : undefined);
    const result = await executeTurn({ ...fx.input, ...(strict ? { responseSchema: { type: "object" } } : {}) });
    assert.equal(isTurnFailure(result), false);
    assert.equal(fx.requests.length, 2);
    assert.equal(fx.requests.some(request => request.messages.some(message => message.content.includes("[topic evidence JSON]"))), false);
    const read = await createBoardReader(fx.boardRoot).load();
    assert.ok(read.ok);
    if (read.ok) assert.equal(read.state.rewardV2Facts?.length ?? 0, 0);
    if (!strict) await assert.rejects(access(fx.boardRoot));
  }
});

test("a fake semantic quote cannot turn a genuine execution into a learning fact", async () => {
  const fx = await fixture("method", "fake-quote");
  await executeTurn(fx.input);
  const loaded = await createBoardReader(fx.boardRoot).load();
  assert.ok(loaded.ok);
  if (loaded.ok) assert.equal(loaded.state.rewardV2Facts?.length ?? 0, 0);
  const events = await readFile(path.join(fx.home, "learning", "method-events.ndjson"), "utf8");
  assert.ok(events.includes("topic_quote_missing"));
});

test("host-known credentials in a model question never become a topic fact or a learning diagnostic", async () => {
  const fx = await fixture("method", "sensitive-question");
  const result = await executeTurn({ ...fx.input, apiKey: KNOWN_TOPIC_TEST_SECRET });

  assert.equal(isTurnFailure(result), false);
  assert.equal(fx.requests.length, 2);
  const loaded = await createBoardReader(fx.boardRoot).load();
  assert.ok(loaded.ok);
  if (!loaded.ok) return;

  assert.equal(loaded.state.rewardV2Facts?.length ?? 0, 0);
  assert.equal(loaded.state.assets.length, 0);
  const events = await readFile(path.join(fx.home, "learning", "method-events.ndjson"), "utf8");

  assert.ok(events.includes("topic_sensitive_content"));
  assert.equal(events.includes(KNOWN_TOPIC_TEST_SECRET), false);
});

test("an oversized common-stream fence remains visible and cannot become a candidate", async () => {
  const fx = await fixture("method", "oversized");
  await executeTurn(fx.input);
  assert.ok(fx.output.join("").includes("trylo-learning"));
  const loaded = await createBoardReader(fx.boardRoot).load();
  assert.ok(loaded.ok);
  if (loaded.ok) assert.equal(loaded.state.rewardV2Facts?.length ?? 0, 0);
});

test("cancellation after a tool event starts no extra learning request", async () => {
  const fx = await fixture("method"), cancel = new AbortController();
  await executeTurn({ ...fx.input, cancelSignal: cancel.signal, onRunEnvelope: event => { if (event.kind === "tool_result") cancel.abort(); } });
  assert.equal(fx.requests.length, 1);
  const read = await createBoardReader(fx.boardRoot).load();
  assert.ok(read.ok);
  if (read.ok) assert.equal(read.state.rewardV2Facts?.length ?? 0, 0);
});


async function explicitPoolFixture(t: { after: (cleanup: () => Promise<void>) => void }, mode?: string) {
  const fx = await fixture(mode, "bounded-read");
  t.after(() => rm(fx.root, { recursive: true, force: true }));
  let timestamp = 1800000000000;
  // An ordered event clock supports distinct turns; it is not a physical performance measurement.
  return { ...fx, input: { ...fx.input, now: () => timestamp++ } };
}

async function topicBoardState(boardRoot: string) {
  const loaded = await createBoardReader(boardRoot).load();
  if (!loaded.ok) assert.fail(JSON.stringify(loaded));
  return loaded.state;
}

function explicitPoolPolicy(scope: string, poolId: string, totalQuota: number) {
  return { scope, poolId, totalQuota, algorithmVersion: "ws1-read-pair-v1",
    utilityUnit: "read_quality_io_cost_v2", quotaUnit: "checked_read_pair_v1" };
}

test("an explicit read pool preserves old byte reservations and reaches actual host read, claim, started and checker feedback", async t => {
  const fx = await explicitPoolFixture(t, "tool"), scope = workspaceIdentity(fx.root);
  const old = createTopicBudgetPool({ ...explicitPoolPolicy(scope, "ws1-read-pair-v1", 256),
    utilityUnit: "read_quality_byte_cost_v1", boardRoot: fx.boardRoot, enabled: () => true });

  assert.equal((await old.open()).status, "open");
  const reserved = await old.issueCalibration({ requestId: "old-unsettled", domain: "tool", quota: 1,
    protocolHash: contentHashOf("old-byte-protocol") });

  assert.equal(reserved.status, "issued");
  if (reserved.status !== "issued") return;

  const allocation = reserved.grant.allocations[0]!;
  const oldClaim = await old.claim(reserved.grant, "tool", allocation.valuationId, 1, "old-unsettled-spend");

  assert.equal(oldClaim.status, "claimed");
  // This is an old reservation/unsettled claim, not evidence that an experiment executed.
  const oldKey = poolKey(old.policy), before = await topicBoardState(fx.boardRoot);
  const oldFacts = (before.rewardV2Facts ?? []).filter(fact => fact.id.startsWith(oldKey + ":"));
  const policy = explicitPoolPolicy(scope, "explicit-read-small", 2), key = poolKey(policy);
  const result = await executeTurn({ ...fx.input, ...{ readTopicPool: { poolId: policy.poolId, totalQuota: policy.totalQuota } } });

  assert.equal(isTurnFailure(result), false, JSON.stringify(result));
  if (isTurnFailure(result)) return;

  assert.equal(result.exitCode, 0);
  assert.equal(fx.requests.length, 2);
  const state = await topicBoardState(fx.boardRoot), facts = state.rewardV2Facts ?? [];

  assert.deepEqual(facts.filter(fact => fact.id.startsWith(oldKey + ":")), oldFacts, "the old pool and its unsettled claim are immutable");
  const oldLedger = decodePoolLedger(old.policy, facts);
  assert.equal(oldLedger.reserved, 1);
  assert.equal(oldLedger.spends.size, 1);
  const ledger = decodePoolLedger(policy, facts);

  assert.equal(ledger.opened, true, "the real default host must use the explicitly named new pool");
  assert.equal(ledger.reserved, 1);
  assert.equal(ledger.plans.size, 1);
  const open = facts.find(fact => fact.id === key + ":open");
  assert.ok(open);
  assert.equal(JSON.parse(open.payloadJson).totalQuota, 2);
  const claimFacts = facts.filter(fact => fact.id.startsWith(key + ":claim:"));
  assert.equal(claimFacts.length, 1);
  const claim = readPoolClaim(JSON.parse(claimFacts[0]!.payloadJson));
  assert.ok(claim);
  assert.equal(claim.units, 1);
  const rows = facts.map(fact => ({ fact, body: JSON.parse(fact.payloadJson) }));
  const started = rows.filter(row => row.body.type === "ws1_topic_calibration_started" && row.body.expected.claimId === claimFacts[0]!.id);
  const finished = rows.filter(row => row.body.type === "ws1_topic_calibration_result" && row.body.expected.claimId === claimFacts[0]!.id);

  assert.equal(started.length, 1);
  assert.equal(finished.length, 1);
  assert.ok(claimFacts[0]!.sequence < started[0]!.fact.sequence && started[0]!.fact.sequence < finished[0]!.fact.sequence);
  const receipt = finished[0]!.body.receipt;

  assert.ok(readTopicCalibrationReceipt(JSON.stringify(receipt), receipt.receiptRef, started[0]!.body.expected));
  assert.equal(receipt.checkerVersion, "ws1-read-pair-check-v2");
  assert.equal(receipt.executionVersion, "ws1-read-pair-2s-v2");
  const measurements = topicMeasurements(facts, scope);
  assert.equal(measurements.length, 1);
  const measured = measurements[0]!;
  assert.equal(measured.kind, "measured");
  if (measured.kind !== "measured") return;

  const provenance = JSON.parse(measured.provenanceJson!);

  assert.deepEqual(provenance.arms.map((arm: { path: string }) => arm.path), ["whole", "stream"]);
  assert.ok(provenance.arms.every((arm: { result: { executed: boolean; quality: string; latencyMs: number; totalLatencyMs: number } }) =>
    arm.result.executed && arm.result.quality === "pass" && arm.result.totalLatencyMs >= arm.result.latencyMs));
  const physical = (state.rewardExposures ?? []).filter(row => row.source.eventId.startsWith("read-topic-trial:"));

  assert.equal(physical.length, 2, "the host's offer and bound read runtime must run the actual pair");
  assert.equal((state.rewardFeedbacks ?? []).filter(row => physical.some(exposure => exposure.id === row.exposureId)
    && row.id.endsWith(":checked") && row.origin !== "model").length, 2);
});

test("explicit read cap survives restart and later turns, while off, strict and conflicting configurations cannot fall back to 256", async t => {
  const fx = await explicitPoolFixture(t, "tool"), scope = workspaceIdentity(fx.root);
  const policy = explicitPoolPolicy(scope, "explicit-read-one", 1), readTopicPool = { poolId: policy.poolId, totalQuota: 1 };
  const first = await executeTurn({ ...fx.input, ...{ readTopicPool } });
  assert.equal(isTurnFailure(first), false, JSON.stringify(first));
  const initial = await topicBoardState(fx.boardRoot), key = poolKey(policy);
  const originalPoolFacts = (initial.rewardV2Facts ?? []).filter(fact => fact.id.startsWith(key + ":"));
  const ledger = decodePoolLedger(policy, initial.rewardV2Facts ?? []);

  assert.equal(ledger.opened, true);
  assert.equal(ledger.reserved, 1);
  assert.equal(ledger.requests.size, 1);
  const requestId = "turn:" + fx.input.sessionId + ":" + fx.input.turnId;

  assert.ok(ledger.requests.has(requestId));
  const reservation = (initial.rewardV2Facts ?? []).map(fact => JSON.parse(fact.payloadJson))
    .find(row => row.type === "ws1_topic_calibration" && row.requestId === requestId);
  assert.ok(reservation);
  // A fresh owner can report the durable request but cannot mint a second execution capability.
  const restarted = createTopicBudgetPool({ ...policy, boardRoot: fx.boardRoot, enabled: () => true });

  assert.equal((await restarted.lookupRequest(requestId)).status, "previous");
  assert.equal((await restarted.issueCalibration({ requestId, domain: "tool", quota: 1, protocolHash: reservation.protocolHash })).status, "previous");
  const later = await executeTurn({ ...fx.input, turnId: "later-turn", correlationId: "later-correlation", ...{ readTopicPool } });

  assert.equal(isTurnFailure(later), false, JSON.stringify(later));
  assert.equal(fx.requests.length, 4);
  const after = await topicBoardState(fx.boardRoot), facts = after.rewardV2Facts ?? [];

  assert.deepEqual(facts.filter(fact => fact.id.startsWith(key + ":")), originalPoolFacts);
  assert.equal(facts.filter(fact => JSON.parse(fact.payloadJson).type === "ws1_topic_pool").length, 1);
  assert.equal(facts.filter(fact => JSON.parse(fact.payloadJson).type === "ws1_topic_calibration_started").length, 1);
  assert.equal(topicMeasurements(facts, scope).length, 1, "an exhausted cap must not silently allocate another default pool");

  for (const mode of [undefined, "tool"]) {
    const closed = await explicitPoolFixture(t, mode);
    const input = { ...closed.input, ...{ readTopicPool }, ...(mode === "tool" ? { responseSchema: { type: "object" } } : {}) };
    assert.equal(topicRuntimeFor(input), undefined);
    await assert.rejects(access(closed.boardRoot));
    const outcome = await executeTurn(input);
    assert.equal(isTurnFailure(outcome), false, JSON.stringify(outcome));
    if (mode === undefined) await assert.rejects(access(closed.boardRoot));
    else assert.equal((await topicBoardState(closed.boardRoot)).rewardV2Facts?.length ?? 0, 0, "strict schema retains ordinary tool feedback, but creates no topic facts");
  }

  const conflict = await explicitPoolFixture(t, "tool");
  const conflicting = { ...conflict.input, ...{ readTopicPool }, topicLearning: {
    policy: explicitPoolPolicy(workspaceIdentity(conflict.root), "full-config", 3), perTurnQuota: 1, experiments: [], domainRelation: "separable" as const } };

  assert.equal(topicRuntimeFor(conflicting), undefined, "complete custom configuration and default read-pool override conflict");
  const outcome = await executeTurn(conflicting);
  assert.equal(isTurnFailure(outcome), false, JSON.stringify(outcome));
  assert.ok(conflict.warnings.some(message => message.includes("configuration_unavailable")));
  assert.equal((await topicBoardState(conflict.boardRoot)).rewardV2Facts?.length ?? 0, 0, "a rejected configuration must not fall back to the default 256 pool");
});
