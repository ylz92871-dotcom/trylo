import assert from "node:assert/strict";
import test from "node:test";
import { seedToolProduction } from "../../learning/agent/subsystems/tool/testing/production-fixtures.js";
import { readToolAssetInventory, readToolLearningPipeline } from "../../learning/agent/subsystems/tool/runtime/index.js";
import { createToolLibrary } from "./index.js";
import { createRuntimeToolSource, createBoardToolLearning } from "./host/index.js";
import type { ToolPort } from "../../ports/tools.js";

test("learning assets project from their owner, remain unavailable before activation, and do not expose code or samples", async t => {
  const fx = await seedToolProduction(t);
  const tools: ToolPort = { snapshot: () => [], execute: async () => ({ outcome: "cancelled" }), cancel: async () => {} };
  const library = createToolLibrary({ sources: [createRuntimeToolSource({ tools, production: { boardRoot: fx.root, workspaceId: fx.plan.workspaceId } })],
    access: async () => ({ ok: true, value: { tools, configuredNames: [], permission: {} } }),
    learning: createBoardToolLearning({ boardRoot: fx.root, now: () => Date.parse("2026-11-03T00:00:00Z"), permission: () => ({
      request: async action => ({ ticketId: "revision", toolCallId: action.toolCallId }), awaitDecision: async () => ({ resolution: "approved", scope: "once" }),
    }) }) });
  const context = { memberId: "personal", scope: fx.plan.workspaceId };
  const catalog = await library.query(context);
  assert.ok(catalog.ok);
  assert.equal(catalog.value.items.length, 1);
  const entry = catalog.value.items[0]!;
  assert.equal(entry.source.kind, "learned");
  assert.equal(entry.source.reference, fx.selection.versionId);
  assert.equal(entry.configuration, "blocked");
  assert.equal(entry.reason, "production_not_active");
  const selected = await library.resolve(context, [entry.id]);
  assert.ok(selected.ok);
  assert.deepEqual(selected.value.tools.snapshot(), []);
  assert.ok(!JSON.stringify(catalog).includes("module.exports"));
  assert.ok(!JSON.stringify(catalog).includes("expected"));
  const revision = await library.requestCapability(context, { requestKey: "revise-one", taskId: "task", capability: "revise double for decimals", targetToolId: entry.id }, new AbortController().signal);

  assert.ok(revision.ok);
  assert.equal(revision.value.kind, "request");
  const pipeline = await readToolLearningPipeline(fx.root);
  assert.ok(pipeline.ok);
  assert.equal(pipeline.jobs[0]?.plan?.trigger.tool, entry.id);
  assert.ok(pipeline.jobs[0]?.plan?.trigger.evidenceRefs.includes(fx.selection.versionId));
  const candidates = await readToolAssetInventory(fx.root, "test");
  assert.ok(candidates.ok);
  assert.equal(candidates.items[0]?.reason, "candidate_requires_production_approval");
  const foreign = await readToolAssetInventory(fx.root, "foreign");
  assert.ok(foreign.ok);
  assert.deepEqual(foreign.items, []);
});
