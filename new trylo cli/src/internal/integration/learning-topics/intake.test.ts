import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, access, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createPersistentTopicIntake } from "./intake.js";
import { createBoardReader } from "../../adapters/learning-store/file-event-store.js";
import { groundLearningTopic } from "../../learning/domains/shared/topics/ground.js";

async function root() { return mkdtemp(path.join(os.tmpdir(), "trylo-ws1-intake-")); }

function inputs(boardSequence = 0, question = "什么输入条件让当前方法失效？") {
  const window = { schemaVersion: 1, domain: "prompt", scope: "project:one", boardSequence,
    watermarks: [{ runId: "run-one", throughSequence: 2 }], records: [
      { ref: "execution-one", runId: "run-one", sequence: 2, scope: "project:one", origin: "execution_result", text: "同一步骤在当前输入下失败。" },
    ] };
  const proposal = { schemaVersion: 1, question, whenRelevant: "再次遇到相同输入结构时", expectedChange: "根据输入条件选择合适处理步骤",
    citations: [{ evidenceRef: "execution-one", quote: "同一步骤在当前输入下失败" }],
    alternatives: [{ id: "input", explanation: "输入条件有差异" }, { id: "method", explanation: "处理步骤有缺陷" }],
    discriminator: { observation: "固定其他条件比较两种输入", hypothesisIds: ["input", "method"] } };

  return { proposal, window, text: [JSON.stringify(proposal), JSON.stringify(window)] as const };
}

function intake(boardRoot: string, enabled?: () => boolean) {
  return createPersistentTopicIntake({ boardRoot, scope: "project:one", domain: "prompt", algorithmVersion: "ws1-local-contract-v1",
    ...(enabled === undefined ? {} : { enabled }) });
}

test("disabled intake does not parse or create a Board directory", async () => {
  const parent = await root(), boardRoot = path.join(parent, "never-created"), port = intake(boardRoot);
  assert.deepEqual(await port.ingest("not json", "not json"), { status: "disabled" });
  await assert.rejects(access(boardRoot));
  assert.deepEqual(await readdir(parent), []);
});

test("accepted topic persists only through the canonical Board and replays its evidence", async () => {
  const boardRoot = await root(), port = intake(boardRoot, () => true), input = inputs();
  const first = await port.ingest(...input.text);
  assert.equal(first.status, "persisted");

  if (first.status !== "persisted") return;

  assert.equal(first.revision, 1);
  assert.equal(first.idempotent, false);
  const loaded = await createBoardReader(boardRoot).load();
  assert.equal(loaded.ok, true);
  if (!loaded.ok) return;

  assert.equal(loaded.state.rewardV2Facts?.length, 1);
  assert.equal(loaded.state.assets.length, 0);
  assert.equal(loaded.state.activations.length, 0);
  assert.equal(loaded.state.approvals.length, 0);
  assert.equal(loaded.state.jobs.length, 0);
  const payload = JSON.parse(loaded.state.rewardV2Facts![0]!.payloadJson);

  assert.equal(payload.type, "ws1_topic_candidate");
  assert.deepEqual(payload.evidenceWindow, input.window);
  const replayed = groundLearningTopic(JSON.stringify(payload.proposal), JSON.stringify(payload.evidenceWindow));

  assert.equal(replayed.ok, true);
  if (replayed.ok) assert.equal(replayed.value.topicId, first.topic.topicId);
});

test("retry and JSON formatting changes preserve one canonical fact", async () => {
  const boardRoot = await root(), port = intake(boardRoot, () => true), input = inputs();
  assert.equal((await port.ingest(...input.text)).status, "persisted");
  const retry = await port.ingest(JSON.stringify(input.proposal, null, 2), JSON.stringify(input.window, null, 2));
  assert.equal(retry.status, "persisted");
  if (retry.status !== "persisted") return;
  assert.equal(retry.idempotent, true);
  assert.equal(retry.revision, 1);
  assert.equal((await intake(boardRoot, () => true).ingest(...input.text)).status, "persisted");
});

test("a fresh commit revision does not rewrite the model's original knowledge prefix", async () => {
  const boardRoot = await root(), port = intake(boardRoot, () => true), original = inputs(0, "原窗口提出的问题");

  assert.equal((await port.ingest(...inputs(0, "先提交另一条事实").text)).status, "persisted");
  const result = await port.ingest(...original.text, 1);
  assert.equal(result.status, "persisted");

  if (result.status !== "persisted") return;

  assert.equal(result.topic.basis.boardSequence, 0);
  assert.equal(result.revision, 2);
  const loaded = await createBoardReader(boardRoot).load();
  assert.ok(loaded.ok);
  if (!loaded.ok) return;

  const payload = JSON.parse(loaded.state.rewardV2Facts![1]!.payloadJson);

  assert.equal(payload.evidenceWindow.boardSequence, 0);
  assert.equal((await port.ingest(...original.text, 2)).status, "persisted");
});

test("commit revision must be a safe integer at or after the knowledge prefix", async () => {
  const boardRoot = path.join(await root(), "never-created"), port = intake(boardRoot, () => true);
  for (const revision of [-1, 0.5, NaN, Infinity, 0]) {
    assert.deepEqual(await port.ingest(...inputs(1).text, revision), { status: "rejected", reason: "topic_write_revision_invalid" });
  }
  await assert.rejects(access(boardRoot));
});

test("a stale fresh topic is refused without suspending subsequent writes", async () => {
  const boardRoot = await root(), port = intake(boardRoot, () => true);
  assert.equal((await port.ingest(...inputs().text)).status, "persisted");
  assert.deepEqual(await port.ingest(...inputs(0, "不同问题").text), { status: "stale" });
  assert.equal(port.inspect().suspended, false);
  assert.equal((await port.ingest(...inputs(1, "不同问题").text)).status, "persisted");
});

test("cross-scope or cross-domain intake cannot write to another owner's Board", async () => {
  const boardRoot = path.join(await root(), "not-created"), port = intake(boardRoot, () => true), input = inputs();
  const other = { ...input.window, domain: "tool" };
  assert.deepEqual(await port.ingest(input.text[0], JSON.stringify(other)), { status: "rejected", reason: "topic_owner_mismatch" });
  await assert.rejects(access(boardRoot));
});

test("an unconfirmed Board write suspends the intake instead of repeatedly spending writes", async () => {
  const parent = await root(), boardRoot = path.join(parent, "plain-file");
  await writeFile(boardRoot, "preserve");
  const port = intake(boardRoot, () => true);
  assert.deepEqual(await port.ingest(...inputs().text), { status: "rejected", reason: "topic_board_write_unconfirmed" });
  assert.equal(port.inspect().suspended, true);
  assert.deepEqual(await port.ingest(...inputs().text), { status: "rejected", reason: "topic_writer_suspended" });
});

test("collection revocation after construction stops parsing and writing", async () => {
  const parent = await root(), boardRoot = path.join(parent, "never-created");
  let enabled = true;
  const port = intake(boardRoot, () => enabled);
  enabled = false;
  assert.deepEqual(await port.ingest(...inputs().text), { status: "disabled" });
  await assert.rejects(access(boardRoot));
});

test("model abstention creates no learning fact, asset or directory", async () => {
  const boardRoot = path.join(await root(), "not-created"), port = intake(boardRoot, () => true);
  const result = await port.ingest('{"schemaVersion":1,"decision":"no_topic","reason":"还不能提出有证据的问题"}', inputs().text[1]);
  assert.deepEqual(result, { status: "no_topic", reason: "还不能提出有证据的问题" });
  await assert.rejects(access(boardRoot));
});
