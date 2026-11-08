import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { CentralFundedStage } from "./contracts.js";
import { createCentralStageReceipts } from "./stage-receipt.js";

/** File/lifecycle contract only: these synthetic returned references are never
 * submitted to a Board, financial writer or qualification observer. */
function input(index: number): CentralFundedStage {
  const policyRef = "workflow:receipt-storage-contract";
  return { issueId: "issue:receipt-storage", grantId: "grant:receipt-storage", expectedIssueRevision: 1,
    stageRef: `stage:receipt-storage:${index}`, sourceBindingRef: `source:receipt-storage:${index}`, policyRef,
    offer: { offerId: `offer:receipt-storage:${index}`, owner: { plane: "agent", domain: "workflow" }, policyRef,
      reserve: { tokens: 1, calls: 1, steps: 1 }, maxPromptChars: 1 } };
}

test("durable dispatch evidence releases serial slots beyond 128 while unresolved in-flight work stays bounded", async () => {
  const parent = path.resolve(tmpdir()), root = await mkdtemp(path.join(parent, "trylo-stage-receipt-"));
  const address = { boardRoot: root, scope: "workspace:receipt-storage", domain: "workflow" as const };
  const receipts = createCentralStageReceipts(address);

  try {
    for (let index = 0; index < 130; index += 1) {
      const stage = input(index);
      assert.deepEqual(await receipts.begin(stage), { ok: true });
      assert.deepEqual(await receipts.record(stage, { ok: true, workAttempted: true, status: "completed", issueId: stage.issueId,
        grantId: stage.grantId, jobId: "job:receipt-storage", result: { kind: "completed", resultRefs: [`version:receipt-storage:${index}`] } }), { status: "retained" });
    }

    const restored = createCentralStageReceipts(address), first = input(0), archived = await restored.read(first);

    assert.equal(archived.status, "ready");

    if (archived.status !== "ready") throw new Error("dispatch_receipt_not_restored");

    assert.deepEqual(archived.dispatch.ok && archived.dispatch.result, { kind: "completed", resultRefs: ["version:receipt-storage:0"] });
    assert.deepEqual(await restored.begin(first), { ok: false, reason: "central_stage_dispatch_already_recorded" });
    assert.equal((await restored.read({ ...first, expectedIssueRevision: 2 })).status, "unknown");
    assert.equal((await restored.read(input(999))).status, "absent");

    for (let index = 1000; index < 1128; index += 1) assert.deepEqual(await receipts.begin(input(index)), { ok: true });

    assert.deepEqual(await receipts.begin(input(1128)), { ok: false, reason: "central_stage_receipt_capacity" });
    assert.deepEqual(await receipts.begin(input(1000)), { ok: false, reason: "central_stage_dispatch_in_flight" });
  } finally {
    assert.equal(path.dirname(path.resolve(root)), parent);
    assert.ok(path.basename(root).startsWith("trylo-stage-receipt-"));
    await rm(root, { recursive: true, force: true });
  }
});
