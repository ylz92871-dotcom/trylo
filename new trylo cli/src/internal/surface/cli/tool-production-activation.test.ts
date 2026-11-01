import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createFilePermissionStore } from "../../adapters/permission-store/file-ledger.js";
import { productionTestTime, seedToolProduction } from "../../integration/testing/tool-production-fixtures.js";
import { readActiveProductionTool } from "../../integration/tool-learning/production-reader.js";
import { toolProductionScope } from "../../learning/domains/tool/evolution/production-plan.js";
import { activateToolProduction, reviewToolProductionActivation, stopToolProduction } from "./tool-production-activation.js";

test("only the exact activation grant can activate a reviewed production version; replay, stale review and withdrawal refuse", async t => {
  const fx = await seedToolProduction(t); await fx.admit();
  const review = await reviewToolProductionActivation(fx.selection); assert.ok(review.ok);
  const permission = createFilePermissionStore({ path: path.join(fx.root, "permission.ndjson") });
  const grant = async (action: "activate" | "acquire", candidateId = review.reviewId) => {
    const issued = await permission.issue({ action, candidateId, packageVersionId: fx.selection.versionId, scope: toolProductionScope(fx.plan),
      issuedAt: productionTestTime, expiry: "2026-10-31T00:01:00.000Z" }); assert.ok(issued.ok); return { grantId: issued.grant.grantId };
  };
  const base = { ...fx.selection, reviewId: review.reviewId, permission, issuedAt: productionTestTime };
  assert.equal((await activateToolProduction({ ...base, token: { grantId: "forged" } })).ok, false);
  const acquire = await grant("acquire");
  const wrongAction = await activateToolProduction({ ...base, token: acquire }); assert.equal(wrongAction.ok, false);
  if (!wrongAction.ok) assert.equal(wrongAction.code, "action_mismatch");
  const token = await grant("activate"), active = await activateToolProduction({ ...base, token }); assert.ok(active.ok, JSON.stringify(active));
  assert.ok((await readActiveProductionTool(fx.selection)).ok);
  assert.equal((await activateToolProduction({ ...base, token })).ok, false);
  assert.equal((await activateToolProduction({ ...base, reviewId: "old", token: await grant("activate") })).ok, false);
  assert.ok((await stopToolProduction({ ...fx.selection, action: "suspend", commandId: "pause", issuedAt: productionTestTime })).ok);
  assert.equal((await readActiveProductionTool(fx.selection)).ok, false);
  const resume = await reviewToolProductionActivation(fx.selection); assert.ok(resume.ok);
  assert.notEqual(resume.reviewId, review.reviewId);
  const restored = await activateToolProduction({ ...base, reviewId: resume.reviewId, token: await grant("activate", resume.reviewId) }); assert.ok(restored.ok, JSON.stringify(restored));
  assert.ok((await readActiveProductionTool(fx.selection)).ok);
  assert.ok((await stopToolProduction({ ...fx.selection, action: "withdraw", commandId: "stop", issuedAt: productionTestTime })).ok);
  assert.equal((await readActiveProductionTool(fx.selection)).ok, false);
});

test("verification alone, cross-workspace approval and revoked receipts never activate", async t => {
  const fx = await seedToolProduction(t);
  assert.equal((await reviewToolProductionActivation(fx.selection)).ok, false);
  const receipt = await fx.admit();
  assert.equal((await reviewToolProductionActivation({ ...fx.selection, workspaceId: "other" })).ok, false);
  assert.ok((await fx.harness.registry.revoke(receipt.receiptId, productionTestTime, "TEST ONLY")).ok);
  assert.equal((await reviewToolProductionActivation(fx.selection)).ok, false);
});
