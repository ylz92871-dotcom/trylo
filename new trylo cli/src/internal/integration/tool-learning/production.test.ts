import assert from "node:assert/strict";
import { appendFile } from "node:fs/promises";
import test from "node:test";
import { createBoardReader, withBoardWriter } from "../../adapters/learning-store/file-event-store.js";
import { contentHashOf } from "../../learning/control/hash.js";
import { productionTestTime, seedToolProduction } from "../testing/tool-production-fixtures.js";
import { productionFromBoard, saveToolProductionPlan } from "./production-assets.js";
import { admitToolProductionVerification } from "./production-evidence.js";
import { readActiveProductionTool, verifiedProductionFromBoard } from "./production-reader.js";

test("production plans persist as authority-requesting proposals without evidence or activation; repeat is immutable", async t => {
  const fx = await seedToolProduction(t), loaded = await createBoardReader(fx.root).load(); assert.ok(loaded.ok);
  assert.equal(loaded.state.activations.length, 0); assert.equal(loaded.state.evidence.length, 0);
  const proposal = loaded.state.proposals.find(item => item.proposalId.startsWith("production-proposal:")); assert.ok(proposal);
  assert.equal(proposal.risk, "medium"); assert.deepEqual(proposal.requestedAuthorities, ["tool_activation"]);
  assert.ok((await saveToolProductionPlan(fx.root, fx.plan, productionTestTime)).ok);
  const fast = await withBoardWriter(fx.root, store => store.apply({ type: "fast_lane_validate", commandId: "bypass", issuedAt: productionTestTime, proposalId: proposal.proposalId })); assert.equal(fast.ok, false);
  const absent = await verifiedProductionFromBoard(loaded.state, fx.selection.versionId, fx.plan.workspaceId, fx.selection.authority);
  assert.equal(absent.ok, false);
});

test("forged receipt and legacy checker identities cannot admit production evidence", async t => {
  const fx = await seedToolProduction(t);
  const forged = await admitToolProductionVerification({ ...fx.selection, receiptId: "forged", issuedAt: productionTestTime }); assert.equal(forged.ok, false);
  const legacy = await fx.issue({ verifierId: "tool-validation-pipeline" });
  const rejected = await admitToolProductionVerification({ ...fx.selection, receiptId: legacy.receiptId, issuedAt: productionTestTime }); assert.equal(rejected.ok, false);
  const loaded = await createBoardReader(fx.root).load(); assert.ok(loaded.ok); assert.equal(loaded.state.evidence.length, 0);
});

test("real registry coordinates admit evidence but never activate; revocation and corruption refuse reads", async t => {
  const fx = await seedToolProduction(t), receipt = await fx.admit();
  assert.equal((await readActiveProductionTool(fx.selection)).ok, false);
  const loaded = await createBoardReader(fx.root).load(); assert.ok(loaded.ok);
  assert.ok((await verifiedProductionFromBoard(loaded.state, fx.selection.versionId, fx.plan.workspaceId, fx.selection.authority)).ok);
  assert.ok((await fx.harness.registry.revoke(receipt.receiptId, productionTestTime, "TEST ONLY")).ok);
  assert.equal((await verifiedProductionFromBoard(loaded.state, fx.selection.versionId, fx.plan.workspaceId, fx.selection.authority)).ok, false);
  await appendFile(fx.harness.registry.path, "corrupt\n");
  assert.equal((await verifiedProductionFromBoard(loaded.state, fx.selection.versionId, fx.plan.workspaceId, fx.selection.authority)).ok, false);
});

test("workspace, source lineage, proposal authority and receipt digests cannot be rewritten", async t => {
  const fx = await seedToolProduction(t); await fx.admit();
  const loaded = await createBoardReader(fx.root).load(); assert.ok(loaded.ok);
  assert.equal(productionFromBoard(loaded.state, fx.selection.versionId, "other-workspace").ok, false);
  const tampered = { ...loaded.state, assets: loaded.state.assets.map(asset => asset.versionId !== fx.origin.versionId ? asset : { ...asset, contentHash: "0".repeat(64) }) };
  assert.equal(productionFromBoard(tampered, fx.selection.versionId, fx.plan.workspaceId).ok, false);
  const forged = { ...loaded.state, assets: loaded.state.assets.map(asset => asset.versionId !== fx.selection.versionId ? asset : { ...asset, content: { ...fx.plan, workspaceId: "other" }, contentHash: contentHashOf({ ...fx.plan, workspaceId: "other" }) }) };
  assert.equal(productionFromBoard(forged, fx.selection.versionId, "other").ok, false);
  const mismatch = { ...loaded.state, evidence: loaded.state.evidence.map(item => ({ ...item, receipt: { ...item.receipt!, checksDigest: "0".repeat(64) } })) };
  assert.equal((await verifiedProductionFromBoard(mismatch, fx.selection.versionId, fx.plan.workspaceId, fx.selection.authority)).ok, false);
});
