import assert from "node:assert/strict";
import test from "node:test";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createReadStrategyRuntime } from "../../learning/agent/subsystems/tool/read-strategy/index.js";
import { createBoardReader } from "../../adapters/learning-store/file-event-store.js";
import type { ReadRoutingRecord } from "../../ports/read-routing.js";
import type { TurnHostInput } from "./host.js";
import { createDenyAllPermission } from "./permission.js";
import { methodBoardRoot } from "./learning-sink.js";
import { toolReadStrategyFor } from "./tool-read-strategy.js";
import { topicRuntimeFor } from "./topic-wiring.js";

function execution(executionId: string): ReadRoutingRecord {
  return { executionId, conditions: { fileBytes: 20, range: "bounded", streaming: true },
    decision: { path: "stream", reason: "no_policy" }, actualPath: "stream", outcome: "completed", bytesRead: 20, latencyMs: 1 };
}

function host(root: string, mode: string) {
  const learning = { switch: mode, homeDir: root, env: { TRYLO_HOME: path.join(root, "profile") } };
  const input: TurnHostInput = { text: "Read the permitted public file", sessionId: "review-session", turnId: "review-turn",
    correlationId: "review", workspaceRoot: root, workspaceId: "review-workspace", checkpointRoot: path.join(root, "checkpoints"),
    providerId: "fixture", model: "default", endpoint: "", apiKey: undefined, permission: createDenyAllPermission(),
    format: "stream-json", sink: { stdout: () => {}, stderr: () => {} }, now: () => 100, learning };
  return { input, learning, boardRoot: methodBoardRoot(root, learning.env) };
}

test("two concurrent completed read executions retain both factual feedback records", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "tool-read-concurrent-")), boardRoot = path.join(root, "board");

  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = createReadStrategyRuntime({ boardRoot, scope: "review", sessionId: "session", turnId: "turn", enabled: true, nowMs: () => 100 });
  const signal = new AbortController().signal;
  const written = await Promise.allSettled([runtime.record(execution("first"), signal), runtime.record(execution("second"), signal)]);
  const loaded = await createBoardReader(boardRoot).load();
  assert.ok(loaded.ok, JSON.stringify(loaded));
  const outcomes = written.map(row => row.status === "rejected" ? String(row.reason) : row.status);

  assert.equal(loaded.state.rewardFeedbacks?.length, 2, JSON.stringify(outcomes));
  assert.deepEqual(loaded.state.rewardExposures?.map(row => row.source.eventId).sort(), ["first", "second"]);
  assert.ok(written.every(row => row.status === "fulfilled"), JSON.stringify(outcomes));
});

for (const [initial, withdrawn] of [["all", "off"], ["tool", "method"]]) {
  test(`an existing tool read port stops persistence after ${initial} changes to ${withdrawn}`, async t => {
    const root = await mkdtemp(path.join(tmpdir(), "tool-read-withdraw-"));

    t.after(() => rm(root, { recursive: true, force: true }));
    const h = host(root, initial!), port = toolReadStrategyFor(h.input, undefined);
    assert.ok(port);
    h.learning.switch = withdrawn!;
    const signal = new AbortController().signal;

    assert.deepEqual(await port.choose({ executionId: "withdrawn-choice", conditions: execution("withdrawn-choice").conditions, signal }),
      { path: "stream", reason: "routing_disabled" });
    await port.record(execution("withdrawn-read"), new AbortController().signal);
    await assert.rejects(access(h.boardRoot), "withdrawn tool collection must not create a Board");
  });
}

test("withdrawing tool learning leaves method learning on without dispatching a captured read study", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "tool-study-withdraw-"));

  t.after(() => rm(root, { recursive: true, force: true }));
  const h = host(root, "tool"), topics = topicRuntimeFor(h.input);
  assert.ok(topics);
  const port = toolReadStrategyFor(h.input, topics);
  assert.ok(port);
  let trials = 0;

  port.offer({ executionId: "captured-public-read", conditions: { fileBytes: 20, range: "bounded", streaming: true }, requiredBytes: 100,

    async trial() {
      trials += 1;
      throw new Error("revoked_read_study_must_not_run");
    } });
  h.learning.switch = "method";
  const result = await topics.finish(new AbortController().signal);

  assert.equal(trials, 0, JSON.stringify(result));
  await assert.rejects(access(h.boardRoot), "method-only collection must not allocate a tool read study");
});

for (const stop of ["disabled", "cancelled"] as const) {
  test(`an in-flight read choice observes ${stop} before returning a strategy`, async t => {
    const root = await mkdtemp(path.join(tmpdir(), "tool-read-choice-stop-"));

    t.after(() => rm(root, { recursive: true, force: true }));
    let enabled = true;
    const controller = new AbortController();
    const runtime = createReadStrategyRuntime({ boardRoot: path.join(root, "absent-board"), scope: "review", sessionId: "s", turnId: "t",
      enabled: () => enabled });
    const pending = runtime.choose({ executionId: "pending-choice", conditions: execution("pending-choice").conditions, signal: controller.signal });

    if (stop === "disabled") enabled = false;else controller.abort();

    if (stop === "disabled") assert.deepEqual(await pending, { path: "stream", reason: "routing_disabled" });
    else await assert.rejects(pending, { name: "AbortError" });
  });
}
