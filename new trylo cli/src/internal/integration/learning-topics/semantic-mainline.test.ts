import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Envelope } from "../../protocol/envelope.js";
import { createAttemptSequencer } from "../../protocol/sequencer.js";
import type { ProviderEvent, ProviderPort, ProviderRequest } from "../../ports/provider.js";
import type { WarmRegistry } from "../../adapters/provider/warm.js";
import { createFakePermission, createFakeTools } from "../../loop/fakes.js";
import { reportBeat, teachingFor } from "../../loop/method-signal.js";
import { DEFAULT_METHOD_GRANT } from "../../learning/agent/subsystems/method/index.js";
import { executeTurn, isTurnFailure, type TurnHostInput } from "../../surface/cli/host.js";
import { topicRuntimeFor } from "../../surface/cli/topic-wiring.js";
import { methodBoardRoot } from "../../surface/cli/learning-sink.js";
import { createBoardReader } from "../../adapters/learning-store/file-event-store.js";
import type { LearningPortShape } from "../user-learning/port.js";
import { createTopicLearningRuntime } from "./runtime.js";
import { createTopicEvidenceBuffer, type TopicSemanticEvidenceProjector } from "./evidence.js";

const SECRET = "local-known-credential-7364", PRIVATE_PATH = "D:\\semantic-fixture\\input.txt";
const USER_TEXT = `纠正：空列表不代表失败，请先核对约定。凭据 ${SECRET}，位置 ${PRIVATE_PATH}`;
const LEGACY_PREFIX = "Continue the conversation represented by the JSON history below.\nTreat it as prior context only. Respond only to current_user_message.\n<conversation_history_json>\n";

test("a host projection containing a known credential is stopped before the shared prompt is delivered", async t => {
  const root = await temporary(t, "topic-confidentiality"), boardRoot = path.join(root, "board"), notices: unknown[] = [];
  const runtime = createTopicLearningRuntime({ boardRoot, scope: "safe-scope", sessionId: "session", turnId: "turn",
    enabled: () => true, secrets: [SECRET], emit: (_kind, payload) => { notices.push(payload); },
    projectEvidence: () => ({ origin: "checker_result", text: `host check returned ${SECRET}` }) });

  runtime.capture(events()("turn_start", { text: "public request" }));
  assert.equal(await runtime.attach(undefined).requestSlot({ turnId: "turn", beat: 1, toolNames: [] }), undefined);
  assert.equal(runtime.inspect().phase, "suspended");
  assert.ok(JSON.stringify(notices).includes("topic_sensitive_content"));
  assert.equal(JSON.stringify(notices).includes(SECRET), false);
  await assert.rejects(access(boardRoot));
});

async function temporary(t: TestContext, name: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), `trylo-${name}-`));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function events(sessionId = "session", turnId = "turn", attemptId = "attempt") {
  const sequencer = createAttemptSequencer(attemptId);
  let producerSequence = 0;
  return (kind: string, payload: Envelope["payload"]): Envelope => {
    const sourceSequence = producerSequence++;
    return sequencer.bind({ protocolVersion: "0.0", eventId: `${attemptId}-event-${sourceSequence}`, timestamp: "2026-11-03T00:00:00.000Z",
      sessionId, turnId, kind, payload, producerId: "semantic-test-host", producerSequence: sourceSequence });
  };
}

function topicDraft(record: { readonly ref: string; readonly text: string }): string {
  return JSON.stringify({ schemaVersion: 2, question: "这条纠正对后续选择约束了什么？", whenRelevant: "再次处理同类输入时",
    expectedChange: "先确认输入约定再选择处理步骤", citations: [{ evidenceRef: record.ref, quote: record.text }] });
}

async function hostFixture(t: TestContext) {
  const root = await temporary(t, "semantic-host"), home = path.join(root, "profile"), env = { TRYLO_HOME: home };
  const requests: ProviderRequest[] = [], output: string[] = [], observed: Envelope[] = [];
  const provider: ProviderPort = { async *stream(request): AsyncIterable<ProviderEvent> {
    requests.push(request);
    yield { type: "stream_start", providerId: "fixture", model: request.model, warnings: [] };
    let answer = "收到。";
    const prompt = request.messages.find(message => message.content.includes("[topic evidence JSON]"));
    if (prompt !== undefined) {
      const records = JSON.parse(prompt.content.split("[topic evidence JSON]\n")[1]!.split("\n[/topic evidence JSON]")[0]!) as { ref: string; text: string }[];
      answer += "\n```trylo-learning\n" + topicDraft(records[0]!) + "\n```";
    }

    yield { type: "text_start", blockId: "answer" };

    for (const text of answer.match(/.{1,13}/gs) ?? []) yield { type: "text_delta", blockId: "answer", text };

    yield { type: "text_end", blockId: "answer" };
    yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
  } };
  const warm: WarmRegistry = { acquire: () => ({ provider, reused: true, key: "semantic-local-script" }), invalidate() {}, invalidateAll() {},
    stats: () => ({ builds: 0, hits: requests.length, rebuilds: 0, evictions: 0 }), size: () => 1 };
  const input: TurnHostInput = { text: USER_TEXT, sessionId: "session", turnId: "turn", correlationId: "semantic-correlation",
    workspaceRoot: root, workspaceId: "semantic-workspace", checkpointRoot: path.join(root, "undo"), providerId: "fixture", model: "fixture",
    endpoint: "", apiKey: SECRET, warm, permission: createFakePermission("approved"), format: "stream-json", now: () => 0, maxIterations: 2,
    sink: { stdout: text => output.push(text), stderr: () => {} }, onRunEnvelope: event => { observed.push(event); },
    learning: { switch: "method", homeDir: home, env },
    userLearning: { homeDir: home, env, workspaceId: "semantic-workspace", now: () => 0, warn: () => {} } };

  return { input, root, home, requests, output, observed, boardRoot: methodBoardRoot(home, env) };
}

test("the ordinary topic slot prescribes a closed envelope and its no_topic channel leaves only the requested JSON answer", async t => {
  const root = await temporary(t, "semantic-envelope"), boardRoot = path.join(root, "board"), notices: Envelope["payload"][] = [];
  const runtime = createTopicLearningRuntime({ boardRoot, scope: "semantic-envelope", sessionId: "session", turnId: "turn", enabled: () => true,
    emit: (_kind, payload) => { notices.push(payload); },
    projectEvidence: () => ({ origin: "user_statement", text: "Check the supplied conditions before choosing a reader." }) });

  runtime.capture(events()("turn_start", { text: "public fixture" }));
  const port = runtime.attach(undefined), tools = createFakeTools([]), teaching = await teachingFor(port, undefined, "turn", 1, tools);

  assert.ok(teaching.slot);
  assert.ok(teaching.slot.message.content.length <= DEFAULT_METHOD_GRANT.slotChars);
  assert.match(teaching.slot.message.content, /```trylo-learning\n[\s\S]*?\n```/);
  assert.match(teaching.slot.message.content, /no_topic/);
  const channel = teaching.channel;
  assert.ok(channel);
  const answer = '{"answer":"已收到"}', proposal = JSON.stringify({ schemaVersion: 1, decision: "no_topic", reason: "No unresolved question in this bounded window" });
  const raw = `${answer}\n\`\`\`trylo-learning\n${proposal}\n\`\`\``;
  const response: ProviderEvent[] = [
    { type: "text_start", blockId: "answer" },
    ...(raw.match(/.{1,13}/gs) ?? []).map(text => ({ type: "text_delta" as const, blockId: "answer", text })),
    { type: "text_end", blockId: "answer" }, { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false },
  ];
  let visible = "";

  for (const event of response) for (const rewritten of channel.rewrite(event)) if (rewritten.type === "text_delta") visible += rewritten.text;

  assert.equal(visible.trim(), answer);
  assert.deepEqual(JSON.parse(visible), { answer: "已收到" });
  assert.doesNotMatch(visible, /trylo-learning|no_topic/);
  assert.deepEqual(channel.take(), { proposal });
  await reportBeat({ port, turnId: "turn", beat: 1, transcript: [], tools, take: channel.take(), emit: (_kind, payload) => { notices.push(payload); } });
  assert.ok(notices.some(notice => notice.decision === "proposal_no_topic"), "the actual Intake abstention must be observed, not merely stripped");
  assert.equal(runtime.inspect().phase, "closed");
  const loaded = await createBoardReader(boardRoot).load();
  assert.ok(loaded.ok, JSON.stringify(loaded));
  assert.equal(loaded.state.rewardV2Facts?.length ?? 0, 0);
  assert.equal(loaded.state.assets.length, 0);
  assert.equal(loaded.state.jobs.length, 0);
});

test("ordinary no-tool host turn fields a redacted user statement at real sequence zero and persists its v2 fence in one stream", async t => {
  const fx = await hostFixture(t), result = await executeTurn(fx.input);

  assert.equal(isTurnFailure(result), false, JSON.stringify(result));
  if (isTurnFailure(result)) return;
  assert.equal(result.exitCode, 0);
  assert.equal(fx.requests.length, 1, "semantic learning must reuse the single already requested provider stream");
  const start = fx.observed.find(event => event.kind === "turn_start");
  assert.ok(start);
  assert.equal(start.sequence, 0);
  const prompt = fx.requests[0]!.messages.find(message => message.content.includes("[topic evidence JSON]"));
  assert.ok(prompt);
  assert.equal(prompt.content.includes(SECRET), false);
  assert.equal(prompt.content.includes(PRIVATE_PATH), false);
  assert.equal(fx.output.join("").includes("trylo-learning"), false, "only a fielded semantic fence may be stripped");
  const loaded = await createBoardReader(fx.boardRoot).load();
  assert.ok(loaded.ok);
  if (!loaded.ok) return;

  const candidates = (loaded.state.rewardV2Facts ?? []).map(fact => JSON.parse(fact.payloadJson)).filter(body => body.type === "ws1_topic_candidate");

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].proposal.schemaVersion, 2);
  const record = candidates[0].evidenceWindow.records[0];

  assert.equal(record.ref, start.eventId);
  assert.equal(record.sequence, 0);
  assert.equal(record.origin, "user_statement");
  assert.equal(record.text.includes(SECRET), false);
  assert.equal(record.text.includes(PRIVATE_PATH), false);
  assert.ok(record.text.includes("<redacted>"));
  assert.ok(record.text.includes("[path]"));
  assert.equal(loaded.state.jobs.length, 0);
  assert.equal(loaded.state.assets.length, 0);
});

test("off, absent user collection and legacy flattened authors do not collect or field a first-beat topic", async t => {
  const fx = await hostFixture(t), { learning: _learning, ...off } = fx.input, { userLearning: _userLearning, ...noCollection } = fx.input;
  const legacy: TurnHostInput = { ...fx.input, text: LEGACY_PREFIX + "{}\n</conversation_history_json>" };

  for (const input of [off, noCollection, legacy]) {
    const runtime = topicRuntimeFor(input);
    runtime?.capture(events(input.sessionId, input.turnId)("turn_start", { text: input.text }));
    const teaching = await teachingFor(runtime?.attach(undefined), undefined, input.turnId, 1, createFakeTools([]));
    assert.equal(teaching.slot?.message.content.includes("[topic evidence JSON]") ?? false, false);
    assert.equal(teaching.channel, undefined);
    await assert.rejects(access(fx.boardRoot));
  }

  assert.equal(fx.requests.length, 0);
});

test("a real host checker projection retains its source coordinate, duplicates are idempotent and status alone is not verification", async t => {
  const root = await temporary(t, "semantic-checker"), checked = path.join(root, "actual-output.txt");
  await writeFile(checked, "[]");
  const passed = (await readFile(checked, "utf8")) === "[]";
  assert.equal(passed, true);
  const checkerText = "独立字节检查：实际输出与 [] 精确一致。", checkRef = "checker:exact-output-v1";
  const projector: TopicSemanticEvidenceProjector = event => event.payload.checkRef === checkRef && event.payload.passed === true
    ? { origin: "checker_result", text: checkerText } : undefined;
  const next = events(), checkEvent = next("tool_result", { toolCallId: "checked", status: "succeeded", checkRef, passed });
  const buffer = createTopicEvidenceBuffer({ sessionId: "session", turnId: "turn", scope: "semantic-workspace", projectEvidence: projector });

  buffer.capture(checkEvent);
  buffer.capture(checkEvent);
  assert.equal(buffer.version, 1);
  const record = JSON.parse(buffer.snapshot(0)!).records[0];
  assert.equal(record.origin, "checker_result");
  assert.equal(record.text, checkerText);
  assert.equal(record.ref, checkEvent.eventId);
  assert.equal(record.sequence, checkEvent.sequence);
  assert.throws(() => buffer.capture({ ...checkEvent, sequence: checkEvent.sequence + 1 }), /topic_evidence_identity_conflict/);
  assert.throws(() => buffer.capture({ ...checkEvent, eventId: "different-event-same-coordinate" }), /topic_evidence_identity_conflict/);
  assert.equal(buffer.version, 1);
  const metadata = createTopicEvidenceBuffer({ sessionId: "session", turnId: "turn", scope: "semantic-workspace" }), tools = events("session", "turn", "tool-attempt");

  tools("turn_start", { text: "No implicit checker" });
  metadata.capture(tools("tool_use", { toolCallId: "ordinary", name: "read_file" }));
  metadata.capture(tools("tool_result", { toolCallId: "ordinary", status: "succeeded", passed: true }));
  const status = JSON.parse(metadata.snapshot(0)!).records[0];
  assert.equal(status.origin, "execution_result");
  assert.deepEqual(JSON.parse(status.text), { tool: "read_file", reportedStatus: "succeeded" });
});

test("first-beat shared capacity revokes topic stripping while an existing teaching card keeps its proposal owner", async t => {
  const root = await temporary(t, "semantic-slot"), observations: unknown[] = [];
  const base = (on: boolean, content: string): LearningPortShape => ({ intentOn: () => on, requestSlot: async () => ({ message: { role: "system", content }, receipts: [] }),
    observe: async value => { observations.push(value); }, recordFielding: async () => {}, recordFeedback: async () => {}, endTurn: async () => {} });
  const runtime = (name: string) => {
    const value = createTopicLearningRuntime({ boardRoot: path.join(root, name), scope: "semantic-workspace", sessionId: "session", turnId: "turn",
      enabled: () => true, emit: () => {}, projectEvidence: event => event.kind === "turn_start" ? { origin: "user_statement", text: "请核对空输入约定。" } : undefined });
    value.capture(events()("turn_start", { text: "请核对空输入约定。" }));
    return value;
  };
  const capped = runtime("capacity"), fullText = "x".repeat(DEFAULT_METHOD_GRANT.slotChars), cappedPort = capped.attach(base(false, fullText));

  assert.equal(cappedPort.intentOn("turn", 1), true);
  assert.equal(cappedPort.confirmIntent?.("turn", 1), false);
  const capacity = await teachingFor(cappedPort, undefined, "turn", 1, createFakeTools([]));

  assert.equal(capacity.slot?.message.content, fullText);
  assert.equal(capacity.channel, undefined);
  assert.equal(cappedPort.confirmIntent?.("turn", 1), false);
  const priority = runtime("priority"), priorityPort = priority.attach(base(true, "existing teaching card"));
  const oldCard = await teachingFor(priorityPort, undefined, "turn", 1, createFakeTools([]));

  assert.equal(oldCard.slot?.message.content, "existing teaching card");
  assert.ok(oldCard.channel);
  assert.equal(priority.inspect().phase, "idle");
  await priorityPort.observe({ turnId: "turn", beat: 1, toolNames: [], failures: [], succeededTools: [], proposal: "old-card-owned-proposal" });
  assert.equal((observations.at(-1) as { proposal?: string }).proposal, "old-card-owned-proposal");
  const read = await createBoardReader(path.join(root, "priority")).load();
  assert.ok(read.ok);
  if (read.ok) assert.equal(read.state.rewardV2Facts?.length ?? 0, 0);
});
