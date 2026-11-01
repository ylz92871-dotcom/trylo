import assert from "node:assert/strict";
import test from "node:test";
import { createBoardReader } from "../../adapters/learning-store/file-event-store.js";
import { seedToolProduction, productionTestTime } from "../testing/tool-production-fixtures.js";
import { claimToolProductionCheck, finishToolProductionCheck, expireToolProductionCheck } from "./production-jobs.js";
import { admitToolProductionVerification } from "./production-evidence.js";

test("checks claim one Board job; lost claims require explicit expiration and three attempts exhaust budget", async t => {
  const fx = await seedToolProduction(t), input = { ...fx.selection, issuedAt: productionTestTime };
  for (let i = 0; i < 3; i += 1) {
    const claim = await claimToolProductionCheck(input); assert.ok(claim.ok, JSON.stringify(claim));
    assert.equal((await claimToolProductionCheck(input)).ok, false);
    assert.equal((await expireToolProductionCheck({ ...input, workspaceId: "foreign", jobId: claim.jobId })).ok, false);
    assert.ok((await expireToolProductionCheck({ ...input, jobId: claim.jobId })).ok);
    const receipt = await fx.issue();
    assert.equal((await admitToolProductionVerification({ ...input, jobId: claim.jobId, receiptId: receipt.receiptId })).ok, false);
    assert.equal((await finishToolProductionCheck({ ...input, jobId: claim.jobId, record: fx.record, outcome: "verified", receiptId: "forged" })).ok, false);
  }
  assert.equal((await claimToolProductionCheck(input)).ok, false);
  const loaded = await createBoardReader(fx.root).load(); assert.ok(loaded.ok);
  assert.equal(loaded.state.jobs.length, 3); assert.equal(loaded.state.evidence.length, 0); assert.equal(loaded.state.activations.length, 0);
});

test("archived checker output alone grants no activation or promotion evidence", async t => {
  const fx = await seedToolProduction(t), input = { ...fx.selection, issuedAt: productionTestTime };
  const claim = await claimToolProductionCheck(input); assert.ok(claim.ok);
  assert.ok((await finishToolProductionCheck({ ...input, jobId: claim.jobId, record: fx.record, outcome: "failed" })).ok);
  const loaded = await createBoardReader(fx.root).load(); assert.ok(loaded.ok);
  assert.equal(loaded.state.evidence.length, 0); assert.equal(loaded.state.activations.length, 0);
  assert.equal(loaded.state.jobs[0]?.state, "failed"); assert.ok(loaded.state.assets.some(item => item.kind === "workflow"));
});

test("successful check jobs terminate after receipt admission while activation remains a separate pending lifecycle", async t => {
  const fx = await seedToolProduction(t), input = { ...fx.selection, issuedAt: productionTestTime };
  const claim = await claimToolProductionCheck(input); assert.ok(claim.ok);
  assert.equal((await finishToolProductionCheck({ ...input, jobId: claim.jobId, record: fx.record, outcome: "verified", receiptId: "forged" })).ok, false);
  const receipt = await fx.admit();
  assert.ok((await finishToolProductionCheck({ ...input, jobId: claim.jobId, record: fx.record, outcome: "verified", receiptId: receipt.receiptId })).ok);
  const loaded = await createBoardReader(fx.root).load(); assert.ok(loaded.ok);
  assert.equal(loaded.state.jobs[0]?.state, "succeeded"); assert.equal(loaded.state.activations.length, 0);
  assert.equal((await claimToolProductionCheck(input)).ok, false);
});
