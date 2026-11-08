import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, access, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Envelope } from "../../protocol/envelope.js";
import type { LearningPortShape } from "../user-learning/port.js";
import { createTopicLearningRuntime } from "./runtime.js";
import { createTopicEvidenceBuffer } from "./evidence.js";
import { createBoardReader } from "../../adapters/learning-store/file-event-store.js";
import { createPersistentTopicIntake } from "./intake.js";
import { teachingFor } from "../../loop/method-signal.js";
import { createFakeTools } from "../../loop/fakes.js";
import { composeLearningPorts } from "../user-learning/port.js";
import { createUserLearningRuntimeFor } from "../../surface/cli/user-learning-config.js";

function event(kind: string, sequence: number, payload: Envelope["payload"], attemptId = "attempt"): Envelope {
  return { protocolVersion: "0.0", eventId: `event-${sequence}`, sequence, timestamp: "2026-11-03T00:00:00.000Z",
    sessionId: "session", turnId: "turn", attemptId, kind, payload, producerId: "loop", producerSequence: sequence };
}

const use = (sequence = 1) => event("tool_use", sequence, { toolCallId: "call", name: "read_file", arguments: { secret: "PRIVATE-ARGUMENT" } });
const result = (sequence = 2) => event("tool_result", sequence, { toolCallId: "call", status: "failed", output: "PRIVATE-OUTPUT" });
const report = (beat: number, proposal?: string) => ({ turnId: "turn", beat, failures: [], succeededTools: [], toolNames: ["read_file"],
  ...(proposal === undefined ? {} : { proposal }) });
const request = (beat = 2) => ({ turnId: "turn", beat, toolNames: ["read_file"] });

function proposal(ref = "event-2") {
  return JSON.stringify({ schemaVersion: 1, question: "什么条件导致读取失败？", whenRelevant: "再次读取时", expectedChange: "据条件调整方法",
    citations: [{ evidenceRef: ref, quote: '"reportedStatus":"failed"' }], alternatives: [
      { id: "input", explanation: "输入条件不满足" }, { id: "environment", explanation: "外部条件变化" }],
    discriminator: { observation: "固定输入复核外部条件", hypothesisIds: ["input", "environment"] } });
}

async function setup(base?: LearningPortShape, enabled: () => boolean = () => true) {
  const parent = await mkdtemp(path.join(os.tmpdir(), "trylo-ws1-runtime-")), boardRoot = path.join(parent, "board"), events: unknown[] = [];
  const runtime = createTopicLearningRuntime({ boardRoot, scope: "project:one", sessionId: "session", turnId: "turn", enabled,
    emit: (kind, payload) => events.push({ kind, payload }) });
  return { runtime, port: runtime.attach(base), boardRoot, events };
}

async function ready(fx: Awaited<ReturnType<typeof setup>>) {
  fx.runtime.capture(use());
  fx.runtime.capture(result());
  await fx.port.observe(report(1));
}

function basePort(on: () => boolean, content = "existing policy") {
  const observations: unknown[] = [], delivery = { message: { role: "system" as const, content }, receipts: [] };
  const port: LearningPortShape = { intentOn: on, requestSlot: async () => delivery, observe: async value => { observations.push(value); },
    recordFielding: async () => {}, recordFeedback: async () => {}, endTurn: async () => {} };
  return { port, observations, delivery };
}

test("metadata projection uses actual identities and never copies private input/output or claims verification", () => {
  const buffer = createTopicEvidenceBuffer({ sessionId: "session", turnId: "turn", scope: "project:one" });

  buffer.capture({ ...use(), sessionId: "other" });
  buffer.capture(result());
  assert.equal(buffer.snapshot(0), undefined);
  buffer.capture(use());
  buffer.capture(result());
  const snapshot = buffer.snapshot(3)!;

  assert.equal(snapshot.includes("PRIVATE"), false);
  const parsed = JSON.parse(snapshot);

  assert.equal(parsed.boardSequence, 3);
  assert.equal(parsed.records[0].ref, "event-2");
  assert.equal(parsed.records[0].sequence, 2);
  assert.equal(parsed.watermarks[0].throughSequence, 2);
  assert.deepEqual(JSON.parse(parsed.records[0].text), { tool: "read_file", reportedStatus: "failed" });
  assert.equal(parsed.records[0].origin, "execution_result");
});

test("duplicate in-flight call identities cannot silently change the attributed tool", () => {
  const buffer = createTopicEvidenceBuffer({ sessionId: "session", turnId: "turn", scope: "project:one" });
  buffer.capture(use());
  buffer.capture(use());
  assert.throws(() => buffer.capture(event("tool_use", 3, { toolCallId: "call", name: "write_file" })), /topic_evidence_identity_conflict/);
});

test("off runtime performs no Board IO and adds no slot or intent", async () => {
  const fx = await setup(undefined, () => false);
  await ready(fx);
  assert.equal(fx.port.intentOn("turn", 2), false);
  assert.equal(await fx.port.requestSlot(request()), undefined);
  await assert.rejects(access(fx.boardRoot));
});

test("a real evidence window prompts the existing stream and a candidate uses only the Board writer", async () => {
  const base = basePort(() => false), fx = await setup(base.port);
  await ready(fx);
  const slot = await fx.port.requestSlot(request());
  assert.ok(slot);
  assert.ok(slot.message.content.includes("[topic evidence JSON]"));
  assert.ok(slot.message.content.length <= 1200);
  assert.equal(slot.message.content.includes("PRIVATE"), false);
  await fx.port.observe(report(2, proposal()));
  assert.equal(fx.runtime.inspect().phase, "closed");
  assert.equal("proposal" in (base.observations[1] as object), false);
  const loaded = await createBoardReader(fx.boardRoot).load();
  assert.ok(loaded.ok);
  if (!loaded.ok) return;

  assert.equal(loaded.state.rewardV2Facts?.length, 1);
  assert.equal(loaded.state.assets.length, 0);
  assert.equal(loaded.state.jobs.length, 0);
});

test("existing method teaching retains its slot and proposal ownership", async () => {
  let teaching = true;
  const base = basePort(() => teaching), fx = await setup(base.port);
  await ready(fx);
  assert.equal(await fx.port.requestSlot(request()), base.delivery);
  assert.equal(fx.runtime.inspect().phase, "ready");
  await fx.port.observe(report(2, "old-card"));
  assert.equal((base.observations[1] as { proposal: string }).proposal, "old-card");
  teaching = false;
  assert.ok((await fx.port.requestSlot(request(3)))?.message.content.includes("[learning topic]"));
});

test("recompiling the same granted request keeps its topic prompt and stripping intent", async () => {
  const fx = await setup();
  await ready(fx);
  const first = await fx.port.requestSlot(request());
  assert.ok(first);
  assert.equal(fx.port.intentOn("turn", 2), true);
  assert.deepEqual(await fx.port.requestSlot(request()), first);
});

test("recompiling after the base slot grows revokes this request's topic stripping confirmation", async () => {
  let expanded = false;
  const base = basePort(() => false).port;
  const original = base.requestSlot;
  const changing: LearningPortShape = { ...base, requestSlot: value => expanded
    ? Promise.resolve({ message: { role: "system", content: "x".repeat(1200) }, receipts: [] }) : original(value) };
  const fx = await setup(changing);
  await ready(fx);
  const first = await teachingFor(fx.port, undefined, "turn", 2, createFakeTools([]));
  assert.ok(first.channel);
  expanded = true;
  const second = await teachingFor(fx.port, undefined, "turn", 2, createFakeTools([]));

  assert.equal(second.slot?.message.content, "x".repeat(1200));
  assert.equal(second.channel, undefined);
});

test("an observation sink failure suspends topic learning without rejecting the user's beat", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "trylo-topic-emit-"));
  const runtime = createTopicLearningRuntime({ boardRoot: path.join(parent, "board"), scope: "project:one", sessionId: "session", turnId: "turn",
    enabled: () => true, emit: () => { throw new Error("emit_failed"); } });
  const port = runtime.attach(undefined);
  runtime.capture(use());
  runtime.capture(result());
  await port.observe(report(1));
  await port.requestSlot(request());
  await assert.doesNotReject(port.observe(report(2)));
  assert.equal(runtime.inspect().phase, "suspended");
  // The failure-report path must be safe too, without recursively calling the failed sink.
  const broken = createTopicLearningRuntime({ boardRoot: path.join(parent, "other"), scope: "project:one", sessionId: "session", turnId: "turn",
    enabled: () => true, emit: () => { throw new Error("emit_failed"); } });

  broken.capture(use());
  assert.doesNotThrow(() => broken.capture(event("tool_use", 3, { toolCallId: "call", name: "write_file" })));
  assert.equal(broken.inspect().phase, "suspended");
});

test("a topic that cannot fit the existing shared ceiling cannot install a proposal stripper", async () => {
  const base = basePort(() => false, "x".repeat(1200)), fx = await setup(base.port);
  await ready(fx);
  const teaching = await teachingFor(fx.port, undefined, "turn", 2, createFakeTools([]));

  assert.equal(teaching.slot, base.delivery);
  assert.equal(teaching.channel, undefined);
  const user = createUserLearningRuntimeFor({ homeDir: path.dirname(fx.boardRoot), env: { TRYLO_HOME: path.dirname(fx.boardRoot) },
    workspaceId: "project:one", now: () => 0, warn: () => {} });
  const composed = composeLearningPorts({ method: fx.port, user });
  const withUser = await teachingFor(composed, undefined, "turn", 2, createFakeTools([]));

  assert.equal(withUser.slot, base.delivery);
  assert.equal(withUser.channel, undefined);
});

test("missing model output and explicit abstention consume at most one proposal opportunity", async () => {
  for (const candidate of [undefined, '{"schemaVersion":1,"decision":"no_topic","reason":"证据不足"}']) {
    const fx = await setup();
    await ready(fx);
    await fx.port.requestSlot(request());
    await fx.port.observe(report(2, candidate));
    assert.equal(fx.runtime.inspect().phase, "closed");
    assert.equal(fx.port.intentOn("turn", 3), false);
    const read = await createBoardReader(fx.boardRoot).load();
    assert.ok(read.ok);
    if (read.ok) assert.equal(read.state.rewardV2Facts?.length ?? 0, 0);
  }
});

test("collection revoked after prompt compilation prevents candidate persistence", async () => {
  let enabled = true;
  const fx = await setup(undefined, () => enabled);
  await ready(fx);
  await fx.port.requestSlot(request());
  enabled = false;
  await fx.port.observe(report(2, proposal()));
  await assert.rejects(access(fx.boardRoot));
});

test("oversized proposals are rejected and an unreadable Board suspends only learning", async () => {
  const fx = await setup();
  await ready(fx);
  await fx.port.requestSlot(request());
  await fx.port.observe(report(2, "x".repeat(1101)));
  await assert.rejects(access(fx.boardRoot));
  const broken = await setup();
  await mkdir(broken.boardRoot);
  await writeFile(path.join(broken.boardRoot, "board-events.ndjson"), "{bad}\n");
  await ready(broken);
  assert.equal(broken.runtime.inspect().phase, "suspended");
  assert.equal(await broken.port.requestSlot(request()), undefined);
});

test("turn end removes pending windows and another turn cannot borrow them", async () => {
  const fx = await setup();
  await ready(fx);
  assert.equal(fx.port.intentOn("other", 2), false);
  await fx.port.endTurn("turn");
  assert.equal(fx.port.intentOn("turn", 2), false);
});

test("ordinary Board activity after the prompt does not change its evidence prefix or lose the candidate", async () => {
  const fx = await setup();
  await ready(fx);
  await fx.port.requestSlot(request());
  const other = createPersistentTopicIntake({ boardRoot: fx.boardRoot, scope: "project:one", domain: "prompt", enabled: () => true, algorithmVersion: "other" });
  const buffer = createTopicEvidenceBuffer({ sessionId: "session", turnId: "turn", scope: "project:one" });
  buffer.capture(use());
  buffer.capture(result());
  assert.equal((await other.ingest(proposal(), buffer.snapshot(0)!)).status, "persisted");
  await fx.port.observe(report(2, proposal()));
  const loaded = await createBoardReader(fx.boardRoot).load();
  assert.ok(loaded.ok);
  if (!loaded.ok) return;

  assert.equal(loaded.state.rewardV2Facts?.length, 2);
  assert.equal(JSON.parse(loaded.state.rewardV2Facts![1]!.payloadJson).evidenceWindow.boardSequence, 0);
});
