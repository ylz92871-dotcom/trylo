import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { createToolGapRuntimeFor, toolGapHostFor } from "./tool-learning-config.js";
import { createBoardReader } from "../../adapters/learning-store/file-event-store.js";
import { enqueueToolLearningPlan } from "../../integration/tool-learning/pipeline-queue.js";
import { afterTurnToolCycle } from "./tool-cycle-wiring.js";

test("off and non-tool switches construct no tool host or post-turn worker", () => {
  let calls = 0;
  const facts = { homeDir: "unused", env: {}, now: () => 0, stderr: () => {}, afterEnqueue: async () => { calls++; } };
  for (const mode of [undefined, "user", "method"] as const) assert.deepEqual(toolGapHostFor(mode, facts), {});
  assert.equal(calls, 0);
});

test("post-turn hook queues only corroborated admitted gaps, flushes once, and isolates worker failure", async t => {
  const base = path.resolve("Temp/tool-cycle-hook-tests"); await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "case-")); assert.equal(path.dirname(root), base);
  t.after(() => rm(root, { recursive: true, force: true }));
  let calls = 0; const warnings: string[] = [];
  const runtime = createToolGapRuntimeFor({ homeDir: root, env: { TRYLO_HOME: root }, workspaceId: "test-workspace", now: () => 0,
    warn: text => warnings.push(text), afterEnqueue: async ids => { calls++; assert.equal(ids.length, 1); throw new Error("test worker failed"); } });
  await runtime.port.observe({ turnId: "uncorroborated", beat: 1, toolNames: [], failures: [], selfReport: JSON.stringify({ need: "新工具:double" }) });
  assert.equal(runtime.proposals().length, 0);
  await runtime.port.observe({ turnId: "corroborated", beat: 1, toolNames: ["run_shell"], failures: Array.from({ length: 3 }, () => ({ tool: "run_shell", code: "tool_error", fingerprint: "fp" })),
    selfReport: JSON.stringify({ need: "改进:double", tool: "run_shell" }) });
  const board = path.join(root, "learning", "board"), before = await createBoardReader(board).load(); assert.ok(before.ok); assert.equal(before.state.jobs.length, 0);
  await runtime.close(); await runtime.close();
  const after = await createBoardReader(board).load(); assert.ok(after.ok); assert.equal(after.state.jobs.length, 1); assert.equal(calls, 1);
  assert.ok(warnings.some(text => text.includes("post-turn work unavailable")));
});

test("post-turn backlog failure also cannot replace a turn with no new gaps", async () => {
  const warnings: string[] = [];
  const runtime = createToolGapRuntimeFor({ homeDir: "unused", env: {}, workspaceId: "test", now: () => 0, warn: text => warnings.push(text),
    afterEnqueue: async () => { throw new Error("test worker failure"); } });
  await runtime.close();
  assert.ok(warnings.some(text => text.includes("post-turn work unavailable")));
});

test("worker dispatch binds the resolved profile and cannot invent execution authorization", async t => {
  const base = path.resolve("Temp/tool-cycle-hook-tests"); await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "case-")); assert.equal(path.dirname(root), base);
  t.after(() => rm(root, { recursive: true, force: true }));
  const scope = "dispatch-test", profile = path.join(root, ".trylo");
  const queued = await enqueueToolLearningPlan(path.join(profile, "learning/board"), { type: "tool_learning_plan", schemaVersion: 1,
    scope, capability: "double", createdAt: new Date(0).toISOString(), trigger: { runId: "test", proposalKey: "test-gap", action: "replace_or_add", evidenceRefs: [] } }); assert.ok(queued.ok);
  let called = 0;
  await afterTurnToolCycle({ homeDir: root, env: { TEST_PARENT_ENV: "retained" }, cwd: root, stderr: () => {} }, {
    workspaceId: scope, run: { message: [], readStdin: false }, dispatch: async input => {
      called++; assert.equal(path.resolve(input.env.TRYLO_HOME ?? ""), profile); assert.equal(input.env.TEST_PARENT_ENV, "retained");
      assert.equal(input.args.includes("--after-turn"), true); assert.equal(input.args.includes(queued.jobId), true);
      assert.equal(input.args.includes("--allow-tools"), false); return { ok: true, pid: 1 };
    },
  })([]);
  assert.equal(called, 1);
});
