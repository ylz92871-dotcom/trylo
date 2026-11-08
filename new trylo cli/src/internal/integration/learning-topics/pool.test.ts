import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, access, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createTopicBudgetPool } from "./pool.js";
import { createBoardReader } from "../../adapters/learning-store/file-event-store.js";
import { createRewardV2BoardPort } from "../reward/v2-board-port.js";

async function fixture(totalQuota = 3) {
  const parent = await mkdtemp(path.join(os.tmpdir(), "trylo-topic-pool-")), boardRoot = path.join(parent, "board");
  const options = { boardRoot, scope: "workspace-one", poolId: "host-budget-one", algorithmVersion: "ws1-pool-v1",
    utilityUnit: "goal-v1", quotaUnit: "probe-v1", totalQuota, enabled: () => true };
  return { options, boardRoot, pool: createTopicBudgetPool(options) };
}

function request(sequence: number, quota = 2, version = "value-one") {
  return JSON.stringify({ schemaVersion: 1, scope: "workspace-one", boardSequence: sequence, utilityUnit: "goal-v1", quotaUnit: "probe-v1",
    domainRelation: "separable", totalQuota: quota, bids: [{ schemaVersion: 1, valuationId: version, domain: "prompt", scope: "workspace-one",
      basis: { boardSequence: sequence, evidenceWindowHash: "evidence-one" }, utilityUnit: "goal-v1", quotaUnit: "probe-v1",
      modelKind: "declared_finite_expected_utility", curve: [{ quota: 0, netValue: 0 }, { quota: 1, netValue: 0.1 }, { quota: 2, netValue: 0.8 }] }] });
}

test("disabled pools parse nothing and perform no filesystem IO", async () => {
  const fx = await fixture(), { enabled: _enabled, ...options } = fx.options, pool = createTopicBudgetPool(options);
  assert.deepEqual(await pool.open(), { status: "disabled" });
  assert.deepEqual(await pool.issue("invalid"), { status: "disabled" });
  await assert.rejects(access(fx.boardRoot));
});

test("a reservation survives owner restart and a new issue cannot reset the same pool's total cap", async () => {
  const fx = await fixture(), opened = await fx.pool.open();
  assert.equal(opened.status, "open");
  if (opened.status !== "open") return;

  assert.equal(opened.remaining, 3);
  const issued = await fx.pool.issue(request(opened.revision));
  assert.equal(issued.status, "issued");
  if (issued.status !== "issued") return;

  assert.equal(issued.remaining, 1);
  const restarted = createTopicBudgetPool(fx.options), current = await restarted.open();
  assert.equal(current.status, "open");
  if (current.status !== "open") return;

  assert.equal(current.remaining, 1);
  assert.deepEqual(await restarted.issue(request(current.revision, 2, "new-value")), { status: "rejected", reason: "topic_pool_quota" });
  assert.deepEqual(await restarted.issue(request(opened.revision)), { status: "already_issued", allocationId: issued.grant.allocationId });
});

test("only a live issued capability can claim its bound domain and actual indivisible units", async () => {
  const fx = await fixture(), open = await fx.pool.open();
  if (open.status !== "open") throw new Error("fixture_failed");

  const issued = await fx.pool.issue(request(open.revision));
  if (issued.status !== "issued") throw new Error("fixture_failed");

  const grant = issued.grant;

  assert.deepEqual(await fx.pool.claim({ ...grant }, "prompt", "value-one", 1, "work"), { status: "rejected", reason: "topic_pool_capability" });
  assert.deepEqual(await fx.pool.claim(grant, "tool", "value-one", 1, "work"), { status: "rejected", reason: "topic_pool_claim_binding" });
  assert.deepEqual(await fx.pool.claim(grant, "prompt", "wrong-value", 1, "work"), { status: "rejected", reason: "topic_pool_claim_binding" });
  assert.deepEqual(await fx.pool.claim(grant, "prompt", "value-one", 0.5, "work"), { status: "rejected", reason: "topic_pool_claim_binding" });
  const claimed = await fx.pool.claim(grant, "prompt", "value-one", 2, "work");
  assert.equal(claimed.status, "claimed");

  if (claimed.status === "claimed") assert.equal(claimed.units, 2);

  assert.deepEqual(await fx.pool.claim(grant, "prompt", "value-one", 1, "other"), { status: "rejected", reason: "topic_pool_quota" });
  const read = await createBoardReader(fx.boardRoot).load();
  assert.ok(read.ok);
  if (!read.ok) return;

  assert.equal(read.state.rewardV2Facts?.length, 3);
  assert.equal(read.state.assets.length, 0);
  assert.equal(read.state.activations.length, 0);
  assert.equal(read.state.approvals.length, 0);
});

test("concurrent owners cannot issue two reservations from the same prefix or mint a second capability on replay", async () => {
  const fx = await fixture(), open = await fx.pool.open();
  if (open.status !== "open") throw new Error("fixture_failed");
  const other = createTopicBudgetPool(fx.options);
  const results = await Promise.all([fx.pool.issue(request(open.revision)), other.issue(request(open.revision))]);
  assert.equal(results.filter(row => row.status === "issued").length, 1);
  const reloaded = await createTopicBudgetPool(fx.options).open();
  assert.equal(reloaded.status, "open");
  if (reloaded.status === "open") assert.equal(reloaded.remaining, 1);
});

test("same-owner concurrent claims and revoked collection do not overspend or create work", async () => {
  const fx = await fixture(2);
  let enabled = true;
  const pool = createTopicBudgetPool({ ...fx.options, enabled: () => enabled });
  const open = await pool.open();
  if (open.status !== "open") throw new Error("fixture_failed");
  const issued = await pool.issue(request(open.revision));
  if (issued.status !== "issued") throw new Error("fixture_failed");
  const results = await Promise.all([pool.claim(issued.grant, "prompt", "value-one", 2, "same-work"), pool.claim(issued.grant, "prompt", "value-one", 2, "same-work")]);
  assert.equal(results.filter(row => row.status === "claimed").length, 1);
  enabled = false;
  assert.deepEqual(await pool.claim(issued.grant, "prompt", "value-one", 1, "other"), { status: "disabled" });
});

test("a stable logical spend id cannot claim twice and changed units under that id conflict", async () => {
  const fx = await fixture(2), open = await fx.pool.open();
  if (open.status !== "open") throw new Error("fixture_failed");
  const issued = await fx.pool.issue(request(open.revision));
  if (issued.status !== "issued") throw new Error("fixture_failed");
  const first = await fx.pool.claim(issued.grant, "prompt", "value-one", 1, "same-work");
  assert.equal(first.status, "claimed");
  const repeat = await fx.pool.claim(issued.grant, "prompt", "value-one", 1, "same-work");
  assert.equal(repeat.status, "replayed");
  assert.deepEqual(await fx.pool.claim(issued.grant, "prompt", "value-one", 2, "same-work"), { status: "rejected", reason: "topic_pool_spend_conflict" });
  assert.equal((await fx.pool.claim(issued.grant, "prompt", "value-one", 1, "other-work")).status, "claimed");
});

test("stale planning has no reservation side effect and does not suspend a healthy writer", async () => {
  const fx = await fixture(), open = await fx.pool.open();
  if (open.status !== "open") throw new Error("fixture_failed");
  assert.deepEqual(await fx.pool.issue(request(0)), { status: "stale" });
  assert.equal(fx.pool.inspect().suspended, false);
  const current = await fx.pool.open();
  if (current.status !== "open") throw new Error("fixture_failed");
  assert.equal(current.remaining, 3);
  assert.equal((await fx.pool.issue(request(open.revision))).status, "issued");
});

test("changing an algorithm, unit or total cannot reopen a fresh budget under the same pool id", async () => {
  const fx = await fixture();
  await fx.pool.open();
  for (const patch of [{ totalQuota: 4 }, { quotaUnit: "new-unit" }, { utilityUnit: "new-goal" }, { algorithmVersion: "new-algorithm" }]) {
    const other = createTopicBudgetPool({ ...fx.options, ...patch });
    assert.deepEqual(await other.open(), { status: "rejected", reason: "topic_pool_unconfirmed" });
    assert.equal(other.inspect().suspended, true);
  }
});

test("a restart cannot reuse an in-memory grant, while durable reservations remain charged", async () => {
  const fx = await fixture(), open = await fx.pool.open();
  if (open.status !== "open") throw new Error("fixture_failed");
  const issued = await fx.pool.issue(request(open.revision));
  if (issued.status !== "issued") throw new Error("fixture_failed");
  const other = createTopicBudgetPool(fx.options);
  assert.deepEqual(await other.claim(issued.grant, "prompt", "value-one", 1, "work"), { status: "rejected", reason: "topic_pool_capability" });
  const current = await other.open();
  if (current.status !== "open") throw new Error("fixture_failed");
  assert.equal(current.remaining, 1);
});

test("a corrupted opaque pool payload fails closed rather than resetting its remaining quota", async () => {
  const fx = await fixture(), open = await fx.pool.open();
  if (open.status !== "open") throw new Error("fixture_failed");
  const board = createRewardV2BoardPort(fx.boardRoot, () => true), view = await board.read();
  await board.append(view.revision, { id: view.facts[0]!.id.replace(/:open$/, ":bad"), scope: fx.options.scope,
    algorithmVersion: fx.options.algorithmVersion, kind: "learning_decision", payloadJson: '{"type":"invented"}' });
  const pool = createTopicBudgetPool(fx.options);
  assert.deepEqual(await pool.open(), { status: "rejected", reason: "topic_pool_unconfirmed" });
});

test("unconfirmed storage failures suspend the pool and cannot be treated as refundable unused quota", async () => {
  const fx = await fixture();
  await mkdir(fx.boardRoot);
  await writeFile(path.join(fx.boardRoot, "board-events.ndjson"), "bad\n");
  assert.deepEqual(await fx.pool.open(), { status: "rejected", reason: "topic_pool_unconfirmed" });
  assert.deepEqual(await fx.pool.issue(request(0)), { status: "rejected", reason: "topic_pool_suspended" });
});
