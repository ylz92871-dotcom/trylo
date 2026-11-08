import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { reduce } from "../../../../control/reducer.js";
import { emptyBoardState } from "../../../../control/state.js";
import { createCollaborationLearning } from "../domain/index.js";
import type { CollaborationBoardPort } from "../domain/contracts.js";
import type { CollaborationRound } from "../../../../../subagent/collaboration.js";
import { createFileCollaborationBoard } from "./board-port.js";
import { createCollaborationRuntime } from "./runtime.js";

const now = () => "2026-11-03T00:00:00.000Z";
const round: CollaborationRound = { teamRunId: "team", taskId: "task", memberId: "worker", role: "worker", round: 1,
  dependencies: ["specification-task"], assignment: "PRIVATE TASK BODY" };

function memoryBoard() {
  let state = emptyBoardState();
  const board: CollaborationBoardPort = { load: async () => ({ ok: true, state, generation: 0 }),
    async apply(command) {
      const result = reduce(state, command);
      if (result.ok) state = result.state;
      return result;
    } };
  return { board, read: () => state };
}

test("runtime retains assignment hashes and canonical terminals without promoting a member's completion to verified quality", async () => {
  const store = memoryBoard(), learning = createCollaborationLearning({ board: store.board, now });
  const runtime = createCollaborationRuntime({ learning, scope: "/workspace", now, enabled: () => true, warn: assert.fail });

  assert.equal(await runtime.prepare(round, new AbortController().signal), undefined);
  await runtime.dispatched(round, "actual-request", undefined);
  await runtime.completed(round, "PRIVATE OUTPUT BODY");
  await runtime.ended(round, "cancelled", "parent_closed");
  const facts = store.read().collaborationFacts ?? [];

  assert.equal(facts.length, 1);
  const episode = facts[0];
  assert.equal(episode?.kind, "episode");

  if (episode?.kind !== "episode") return;

  assert.equal(episode.result.check, "unverified");
  assert.equal(episode.result.source, "member_report");
  assert.equal(episode.context.dependency, "artifact");
  assert.ok(!JSON.stringify(facts).includes("PRIVATE"));
  const learned = await learning.invoke({ subsystem: "collaboration", budget: { maxEpisodes: 4, maxPromptChars: 1200 } });

  assert.ok(learned.ok);
  if (learned.ok) assert.deepEqual(learned.createdVersionIds, []);
});

test("failed/cancelled rounds clear bounded pending observations and preserve runtime result distinctions", async () => {
  const store = memoryBoard(), learning = createCollaborationLearning({ board: store.board, now });
  const runtime = createCollaborationRuntime({ learning, scope: "/workspace", now, enabled: () => true, warn: assert.fail });

  for (let index = 0; index < 70; index += 1) {
    const input = { ...round, taskId: `task-${index}` };
    await runtime.prepare(input, new AbortController().signal);
    await runtime.ended(input, index % 2 === 0 ? "cancelled" : "failed", "runtime-test");
  }

  const facts = store.read().collaborationFacts ?? [];

  assert.equal(facts.length, 70);
  assert.equal(facts[0]?.kind === "episode" && facts[0].result.status, "cancelled");
  assert.equal(facts[1]?.kind === "episode" && facts[1].result.status, "failed");
  await runtime.completed({ ...round, taskId: "task-0" }, "late success");
  assert.equal(store.read().collaborationFacts?.length, 70, "late completion cannot replace the observed terminal");
});

test("collection off and already cancelled preparation perform no Board access", async () => {
  const board: CollaborationBoardPort = { load: async () => { throw new Error("unexpected read"); },
    apply: async () => { throw new Error("unexpected write"); } };
  const learning = createCollaborationLearning({ board, now });
  const runtime = createCollaborationRuntime({ learning, scope: "/workspace", now, enabled: () => false, warn: assert.fail });

  await runtime.prepare(round, new AbortController().signal);
  await runtime.dispatched(round, "request", "anything");
  await runtime.completed(round, "output");
  await runtime.ended(round, "failed");
  const enabled = createCollaborationRuntime({ learning, scope: "/workspace", now, enabled: () => true, warn: assert.fail });
  const controller = new AbortController();
  controller.abort();
  assert.equal(await enabled.prepare(round, controller.signal), undefined);
});

test("file Board serializes concurrent member writes and a disabled adapter creates no directory", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "trylo-collaboration-board-"));

  t.after(() => rm(root, { recursive: true, force: true }));
  const disabledRoot = path.join(root, "disabled");

  assert.equal((await createFileCollaborationBoard(disabledRoot, () => false).load()).ok, false);
  assert.equal(existsSync(disabledRoot), false);
  const board = createFileCollaborationBoard(path.join(root, "board"));
  const learning = createCollaborationLearning({ board, now });
  const runtime = createCollaborationRuntime({ learning, scope: "/workspace", now, enabled: () => true, warn: assert.fail });

  await runtime.prepare(round, new AbortController().signal);
  await runtime.prepare({ ...round, taskId: "second" }, new AbortController().signal);
  await Promise.all([runtime.completed(round, "first"), runtime.completed({ ...round, taskId: "second" }, "second")]);
  const loaded = await board.load();
  assert.ok(loaded.ok);

  if (loaded.ok) assert.equal(loaded.state.collaborationFacts?.length, 2);
});
