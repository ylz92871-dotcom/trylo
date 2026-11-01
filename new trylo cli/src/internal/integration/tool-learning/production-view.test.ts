import assert from "node:assert/strict";
import test from "node:test";
import { createBoardReader } from "../../adapters/learning-store/file-event-store.js";
import { seedToolProduction, productionTestTime } from "../testing/tool-production-fixtures.js";
import { productionFromBoard } from "./production-assets.js";
import { projectToolProductionDetail, readToolProductionList } from "./production-view.js";
import { claimToolProductionCheck, finishToolProductionCheck } from "./production-jobs.js";

test("bounded production inventory is scoped, read-only and excludes candidate code and frozen examples", async t => {
  const fx = await seedToolProduction(t), before = await createBoardReader(fx.root).load(); assert.ok(before.ok);
  const listed = await readToolProductionList(fx.root, fx.plan.workspaceId); assert.ok(listed.ok);
  assert.equal(listed.formatVersion, 1); assert.equal(listed.items.length, 1); assert.equal(listed.items[0]?.versionId, fx.selection.versionId);
  assert.deepEqual(listed.items[0]?.uses, { total: 0, returned: 0, quality: "unverified" });
  const wire = JSON.stringify(listed); assert.ok(!wire.includes("module.exports")); assert.ok(!wire.includes("expected"));
  const foreign = await readToolProductionList(fx.root, "foreign"); assert.ok(foreign.ok); assert.equal(foreign.items.length, 0);
  const after = await createBoardReader(fx.root).load(); assert.deepEqual(after, before);
});
test("archived passing diagnostics do not manufacture an activation review or a trusted receipt", async t => {
  const fx = await seedToolProduction(t), input = { ...fx.selection, issuedAt: productionTestTime };
  const claim = await claimToolProductionCheck(input); assert.ok(claim.ok);
  assert.ok((await finishToolProductionCheck({ ...input, jobId: claim.jobId, record: fx.record, outcome: "failed" })).ok);
  const loaded = await createBoardReader(fx.root).load(); assert.ok(loaded.ok);
  const selected = productionFromBoard(loaded.state, fx.selection.versionId, fx.plan.workspaceId); assert.ok(selected.ok);
  const detail = projectToolProductionDetail(loaded.state, selected, { ok: false, code: "production_verification_required" });
  assert.equal(detail.report?.stages.length, 10); assert.equal(detail.review.status, "unavailable");
  assert.equal(detail.checkState, "failed"); assert.equal(detail.source[0]?.origin, "generated_candidate");
  assert.ok(!JSON.stringify(detail).includes("module.exports")); assert.ok(!JSON.stringify(detail).includes("trainingInputs"));
});
