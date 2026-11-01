import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createFilePermissionStore } from "../../adapters/permission-store/file-ledger.js";
import { seedToolProduction, productionTestTime } from "../../integration/testing/tool-production-fixtures.js";
import { issueAgentMethodReceipt } from "../../integration/testing/authority-fixtures.js";
import { saveToolProductionPlan, TOOL_PRODUCTION_GENERATOR, TOOL_PRODUCTION_VERIFIER } from "../../integration/tool-learning/production-assets.js";
import { admitToolProductionVerification } from "../../integration/tool-learning/production-evidence.js";
import { readActiveProductionTool } from "../../integration/tool-learning/production-reader.js";
import { openToolProductionUse } from "../../integration/tool-learning/production-use.js";
import { toolProductionScope, toolProductionVersion } from "../../learning/domains/tool/evolution/production-plan.js";
import { activateToolProduction, reviewToolProductionActivation, stopToolProduction } from "./tool-production-activation.js";

test("replacement pins a new exact name, rejects an old borrowed mount and rolls back only to the approved predecessor", async t => {
  const fx = await seedToolProduction(t); await fx.admit();
  const permission = createFilePermissionStore({ path: path.join(fx.root, "permission.ndjson") });
  const enable = async (versionId: string) => {
    const selection = { ...fx.selection, versionId }, review = await reviewToolProductionActivation(selection); assert.ok(review.ok);
    const issued = await permission.issue({ action: "activate", candidateId: review.reviewId, packageVersionId: versionId, scope: toolProductionScope(review.plan), issuedAt: productionTestTime, expiry: "2026-10-31T00:01:00.000Z" }); assert.ok(issued.ok);
    const result = await activateToolProduction({ ...selection, reviewId: review.reviewId, permission, token: { grantId: issued.grant.grantId }, issuedAt: productionTestTime }); assert.ok(result.ok, JSON.stringify(result));
  };
  await enable(fx.selection.versionId);
  let calls = 0, ids = 0;
  const options = { ...fx.selection, sessionId: "test", now: () => 0, newId: () => `use-${++ids}`, warn: () => {},
    executor: { execute: async () => { calls++; return { kind: "value" as const, value: 4 }; } } };
  const old = await openToolProductionUse(options); assert.ok(old.ok); t.after(old.mount.close);
  const nextPlan = { ...fx.plan, checks: { ...fx.plan.checks, requestId: "new-frozen-review" } }, nextVersion = toolProductionVersion(nextPlan);
  assert.ok((await saveToolProductionPlan(fx.root, nextPlan, productionTestTime)).ok);
  const receipt = await issueAgentMethodReceipt(fx.harness, { ...fx.record, packageVersionId: nextVersion },
    { scope: toolProductionScope(nextPlan), generatorId: TOOL_PRODUCTION_GENERATOR, verifierId: TOOL_PRODUCTION_VERIFIER });
  assert.ok((await admitToolProductionVerification({ ...fx.selection, versionId: nextVersion, receiptId: receipt.receiptId, issuedAt: productionTestTime })).ok);
  await enable(nextVersion);
  assert.equal((await old.mount.tools.execute({ toolCallId: "old", name: old.mount.binding.name, arguments: { input: 2 } }, new AbortController().signal)).outcome, "error");
  assert.equal(calls, 0); assert.equal((await readActiveProductionTool(fx.selection)).ok, false);
  const next = await openToolProductionUse({ ...options, versionId: nextVersion }); assert.ok(next.ok); t.after(next.mount.close);
  assert.notEqual(next.mount.binding.name, old.mount.binding.name);
  assert.equal((await stopToolProduction({ ...fx.selection, action: "withdraw", commandId: "stale", issuedAt: productionTestTime })).ok, false);
  assert.ok((await stopToolProduction({ ...fx.selection, versionId: nextVersion, action: "rollback", commandId: "rollback", issuedAt: productionTestTime })).ok);
  assert.ok((await readActiveProductionTool(fx.selection)).ok);
  assert.equal((await next.mount.tools.execute({ toolCallId: "rolled", name: next.mount.binding.name, arguments: { input: 2 } }, new AbortController().signal)).outcome, "error");
  // A turn must refresh even when rollback returns to its old bytes: the generation changed.
  assert.equal((await old.mount.tools.execute({ toolCallId: "old-again", name: old.mount.binding.name, arguments: { input: 2 } }, new AbortController().signal)).outcome, "error");
  const fresh = await openToolProductionUse(options); assert.ok(fresh.ok); t.after(fresh.mount.close);
  assert.equal((await fresh.mount.tools.execute({ toolCallId: "fresh", name: fresh.mount.binding.name, arguments: { input: 2 } }, new AbortController().signal)).outcome, "result");
});
