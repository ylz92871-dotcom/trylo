import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CliContext } from "./context.js";
import type { JsonObject } from "../../protocol/envelope.js";
import type { SessionRecordType } from "../../ports/session.js";
import { createNdjsonSessionStore } from "../../adapters/session-store/ndjson.js";
import { sessionPath } from "./session-paths.js";
import { workflowBoardRoot } from "./workflow-paths.js";
import { workspaceIdentity } from "./wiring-catalog.js";
import { handleWorkflowImprovementCommand } from "./commands-workflow-improvement.js";
import { runtimeFixture, resultRecord } from "../../learning/agent/subsystems/workflow/testing/improvement-runtime-fixtures.js";
import { record } from "../../learning/agent/subsystems/workflow/domain/trace-parse.js";
import { projectWorkflowImprovementEvidence } from "../../learning/agent/subsystems/workflow/adapters/improvement-evidence.js";

async function userFixture(run: (fixture: Awaited<ReturnType<typeof prepare>>) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), "workflow-user-feedback-"));
  const fixture = await prepare(root);
  try { await run(fixture); } finally {
    await fixture.fx.runtime.close();
    await fixture.session.release();
    await rm(root, { recursive: true, force: true });
  }
}

async function prepare(root: string) {
  const at = "2026-11-04T00:00:00.000Z", sessionId = "user-feedback-session", prompts: string[] = [];
  let answer = "helped", serial = 0, sequence = 0;
  const ctx: CliContext = { env: { TRYLO_HOME: path.join(root, "home") }, homeDir: root, cwd: root,
    nodeVersion: "v24.0.0", stdinIsTty: true,
    readFile: file => { try { return readFileSync(file, "utf8"); } catch { return undefined; } },
    isDirectory: () => true, readDir: () => [], writeFile: () => { throw new Error("No task write belongs to user feedback"); },
    readStdin: async () => "", readLine: async prompt => {
      prompts.push(prompt ?? "");
      return answer;
    }, readSecret: async () => undefined,
    stdout: () => {}, stderr: () => {}, now: () => Date.parse(at), newId: prefix => `${prefix}-${++serial}` };
  const scope = workspaceIdentity(root), session = createNdjsonSessionStore({ path: sessionPath(ctx.homeDir, ctx.env, sessionId) });

  assert.ok((await session.start({ sessionId, createdAt: at, fingerprint: { schemaVersion: "1", providerId: "fixture",
    model: "fixture", toolCatalogHash: "fixture-only", workspaceId: scope } })).ok);
  const append = async (type: SessionRecordType, turnId: string, payload: JsonObject) => {
    const result = await session.append({ type, sessionId, turnId, at, payload });
    assert.ok(result.ok);
    sequence = result.sequence;
  };
  const turn = async (turnId: string, tool = "read_file") => {
    await append("turn_start", turnId, {});
    await append("turn_input", turnId, { text: "Continue the real business task." });
    const envelope = (kind: string, payload: JsonObject) => ({ envelope: { protocolVersion: "0.0", eventId: `${turnId}:${kind}`,
      sequence: sequence + 1, timestamp: at, sessionId, turnId, kind, producerId: "loop", producerSequence: sequence + 1, payload } });
    await append("envelope", turnId, envelope("tool_use", { name: tool, toolCallId: "actual-read", arguments: { path: "actual-owner.ts" } }));
    await append("envelope", turnId, envelope("tool_result", { toolCallId: "actual-read", status: "succeeded", output: "Actual test receipt." }));
    await append("terminal", turnId, { reason: "completed" });
  };

  await turn("freeze", "read_file"); // This pre-adoption receipt cannot identify later use.
  const fx = runtimeFixture(workflowBoardRoot(ctx), { scope, sessionId, now: ctx.now });

  fx.state.snapshot = { ...fx.state.snapshot, watermark: sequence, executionId: `${sessionId}/freeze` };
  resultRecord(await fx.runtime.opportunity("learn", fx.fixture.opportunity));
  await fx.runtime.settlePending();
  const frozen = resultRecord(await fx.runtime.context("freeze-guidance", { task: fx.fixture.opportunity.task, boundary: "before the actual transfer" }));

  assert.ok(record(frozen.use));

  return { ctx, fx, session, sessionId, prompts, useId: String(frozen.use.useId), turn,
    answer: (value: string) => { answer = value; }, async sync() {
      const loaded = await session.readRecords();
      assert.ok(loaded.ok);
      const projected = projectWorkflowImprovementEvidence(loaded.view.records, sessionId);
      assert.ok(projected.ok);
      fx.state.snapshot = projected.value;
    } };
}

for (const previousReport of [false, true]) test(`user assessment binds a real transfer execution without borrowing the freeze turn${previousReport ? " with a previous model report" : " and without requiring a model report"}`, async () => userFixture(async fixture => {
  await fixture.turn("transfer");
  await fixture.sync();

  if (previousReport) resultRecord(await fixture.fx.runtime.feedback("actual-model-report", { useId: fixture.useId, exposure: "reported_used",
    evidenceRefs: [`session:${fixture.sessionId}/turn:transfer/tool:actual-read`], followedStepIds: ["confirm-owner"], explanation: "Self-reported use with an actual post-adoption receipt." }));

  const result = resultRecord(await handleWorkflowImprovementCommand(fixture.ctx, ["improve-user-feedback", fixture.useId]));

  assert.ok(record(result.feedback));
  assert.equal(result.feedback.executionId, `${fixture.sessionId}/transfer`);
  assert.equal(result.feedback.quality, "unknown");
  assert.ok(record(result.feedback.userAssessment));
  assert.equal(result.feedback.userAssessment.judgment, "helped");
  assert.equal(fixture.prompts.length, 1);
  assert.match(fixture.prompts[0]!, /helped \/ harmed \/ neutral/);
}));

test("multiple actual executions require one combined execution and assessment choice", async () => userFixture(async fixture => {
  await fixture.turn("transfer-one");
  await fixture.turn("transfer-two");
  fixture.answer("2 harmed");
  const result = resultRecord(await handleWorkflowImprovementCommand(fixture.ctx, ["improve-user-feedback", fixture.useId]));
  assert.ok(record(result.feedback));
  assert.equal(result.feedback.executionId, `${fixture.sessionId}/transfer-two`);
  assert.ok(record(result.feedback.userAssessment));
  assert.equal(result.feedback.userAssessment.judgment, "harmed");
  assert.equal(fixture.prompts.length, 1);
  assert.match(fixture.prompts[0]!, /1\).*transfer-one/);
  assert.match(fixture.prompts[0]!, /2\).*transfer-two/);
}));

test("freeze-only exposure and workflow hook receipts cannot invent an actual-use execution", async () => userFixture(async fixture => {
  await fixture.turn("guidance-only", "workflow_learning");
  const result = await handleWorkflowImprovementCommand(fixture.ctx, ["improve-user-feedback", fixture.useId]);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "workflow_user_execution_unavailable");
    assert.match(result.message, /guidance exposure/);
  }
  assert.equal(fixture.prompts.length, 0);
  const view = await fixture.fx.ports.store.read();
  assert.ok(view.ok);
  assert.equal(view.value.feedback.length, 0);
}));

test("an ambiguous bare assessment and a non-user host cannot create attributed user feedback", async () => userFixture(async fixture => {
  await fixture.turn("transfer-one");
  await fixture.turn("transfer-two");
  const ambiguous = await handleWorkflowImprovementCommand(fixture.ctx, ["improve-user-feedback", fixture.useId]);
  assert.equal(ambiguous.ok, false);

  for (const ctx of [{ ...fixture.ctx, stdinIsTty: false }, { ...fixture.ctx, userSourceAvailable: false as const }]) {
    const result = await handleWorkflowImprovementCommand(ctx, ["improve-user-feedback", fixture.useId]);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "workflow_user_source_required");
  }

  assert.equal(fixture.prompts.length, 1);
  const view = await fixture.fx.ports.store.read();
  assert.ok(view.ok);
  assert.equal(view.value.feedback.length, 0);
}));
