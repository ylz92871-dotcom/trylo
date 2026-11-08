import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createBoardReader, withBoardWriter } from "../../adapters/learning-store/file-event-store.js";
import { centralBudgetProjection } from "../../learning/control/central-budget-state.js";
import { createCentralAccountingFunding, createCentralAccountingFundingAtRoot } from "./central-accounting-funding.js";
import { setCentralLearningBudgetLimitAtRoot } from "./central-accounting-management.js";

const scope = "workspace:accounting-port", issuedAt = "2026-11-05T00:00:00.000Z";
const owner = { kind: "central_deliberation" as const, ownerId: "central:context" };
const userOwner = { kind: "user_learning" as const, ownerId: "user:context" };

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "trylo-central-accounting-"));

  t.after(() => rm(root, { recursive: true, force: true }));
  const opened = await withBoardWriter(root, store => store.apply({ type: "coordinate_learning", commandId: "root:open", issuedAt,
    action: { kind: "open_budget", expectedSequence: 0, budget: { schemaVersion: 1, budgetId: "root", scope,
      unit: "total_model_tokens", limits: { tokens: 1000, calls: 4, steps: 4 }, authorizationRef: "host:explicit" } } }));

  assert.ok(opened.ok);
  const read = async () => {
    const loaded = await createBoardReader(root).load();
    assert.ok(loaded.ok);
    return loaded.state;
  };
  const options = { boardRoot: root, budgetId: "root", scope, owner, enabled: () => true, now: () => issuedAt };

  return { root, options, read };
}

test("original file Board compaction/reopen keeps reservations, unknown cost and duplicate dispatch exclusion", async t => {
  const f = await fixture(t), central = createCentralAccountingFundingAtRoot(f.options);
  const first = await central.reserve({ reservationId: "model:1", maxTokens: 400 });
  assert.ok(first.ok);
  assert.equal(first.status, "reserved");
  const compacted = await withBoardWriter(f.root, async store => {
    const loaded = await store.load();
    assert.ok(loaded.ok);
    return store.compact(loaded.generation);
  });

  assert.ok(compacted.ok);
  const reopened = createCentralAccountingFundingAtRoot(f.options);
  const repeated = await reopened.reserve({ reservationId: "model:1", maxTokens: 400 });
  assert.ok(repeated.ok);
  assert.equal(repeated.status, "duplicate");
  assert.equal(repeated.projection.occupied.tokens, 400);
  const unknown = await reopened.settle({ reservationId: "model:1", usage: { kind: "unknown", reason: "provider_disconnected" } });

  assert.ok(unknown.ok);
  assert.equal(unknown.projection.occupied.tokens, 400);
  const user = createCentralAccountingFundingAtRoot({ ...f.options, owner: userOwner });
  const userRequest = await user.reserve({ reservationId: "user:1", maxTokens: 600 });
  assert.ok(userRequest.ok);
  assert.equal(userRequest.projection.available.tokens, 0);
  assert.equal((await f.read()).centralLearningGrants?.length ?? 0, 0);
  const late = await reopened.settle({ reservationId: "model:1", usage: { kind: "reported", totalTokens: 180 } });

  assert.ok(late.ok);
  assert.equal(late.projection.available.tokens, 220);
  const state = await f.read();
  assert.equal(centralBudgetProjection(state, "root")?.occupied.tokens, 780);
  const snapshot = await readFile(path.join(f.root, "board-snapshot.json"), "utf8");
  assert.match(snapshot, /central_deliberation/);
});

test("a final durable collection gate refuses new reservations while disabled settlement remains allowed", async t => {
  const f = await fixture(t);
  let enabled = true;
  const ordinary = createCentralAccountingFundingAtRoot({ ...f.options, enabled: () => enabled });

  assert.ok((await ordinary.reserve({ reservationId: "existing", maxTokens: 300 })).ok);
  const racing = createCentralAccountingFundingAtRoot({ ...f.options, enabled: () => enabled,

    now: () => {
      enabled = false;
      return issuedAt;
    } });
  const denied = await racing.reserve({ reservationId: "disabled-during-write", maxTokens: 300 });

  assert.ok(!denied.ok);
  assert.equal(denied.reason, "collect_disabled");
  assert.equal(centralBudgetProjection(await f.read(), "root")?.occupied.tokens, 300);
  const settled = await ordinary.settle({ reservationId: "existing", usage: { kind: "reported", totalTokens: 120 } });

  assert.ok(settled.ok);
  assert.equal(settled.projection.occupied.tokens, 120);
  assert.deepEqual(await ordinary.inspect(), { ok: false, reason: "collect_disabled" });
});

test("concurrent peer requests share the same root writer and cannot double-allocate", async t => {
  const f = await fixture(t);
  const results = await Promise.all([owner, userOwner].map((bound, index) => createCentralAccountingFundingAtRoot({ ...f.options, owner: bound })
    .reserve({ reservationId: `race:${index}`, maxTokens: 700 })));
  assert.equal(results.filter(result => result.ok).length, 1);
  const projection = centralBudgetProjection(await f.read(), "root")!;
  assert.equal(projection.occupied.tokens, 700);
  assert.equal(projection.available.tokens, 300);
});

test("explicit root authorization change persists as an absolute cumulative cap and replays after reopen", async t => {
  const f = await fixture(t), port = createCentralAccountingFundingAtRoot(f.options);

  assert.ok((await port.reserve({ reservationId: "request", maxTokens: 300 })).ok);
  assert.ok((await port.settle({ reservationId: "request", usage: { kind: "reported", totalTokens: 200 } })).ok);
  const action = { kind: "set_budget_limit" as const, budgetId: "root", expectedSequence: (await f.read()).sequence,
    changeId: "admin:additional-authorization", limits: { tokens: 2000, calls: 8, steps: 8 }, authorizationRef: "host:explicit-increase" };
  const changed = await setCentralLearningBudgetLimitAtRoot({ boardRoot: f.root, issuedAt, action });
  assert.ok(changed.ok);
  assert.ok((await port.reserve({ reservationId: "request:next-turn", maxTokens: 400 })).ok);
  const replay = await setCentralLearningBudgetLimitAtRoot({ boardRoot: f.root, issuedAt, action: { ...action, expectedSequence: 0 } });

  assert.ok(replay.ok && replay.idempotent);
  const projection = centralBudgetProjection(await f.read(), "root")!;

  assert.equal(projection.budget.limits.tokens, 2000);
  assert.equal(projection.occupied.tokens, 600);
  assert.equal(projection.available.tokens, 1400);
  assert.equal(projection.budget.limitChanges?.length, 1);
});

test("an unconfirmed append never grants a dispatch and a persistent reservation blocks paid retry", async t => {
  const f = await fixture(t);
  let afterAppend = true;
  const port = createCentralAccountingFunding({ ...f.options, board: {
    load: () => createBoardReader(f.root).load(),

    apply: async command => {
      const result = await withBoardWriter(f.root, store => store.apply(command));
      if (afterAppend) {
        afterAppend = false;
        throw new Error("lost_receipt_after_append");
      }
      return result;
    },
  } });
  const unconfirmed = await port.reserve({ reservationId: "uncertain", maxTokens: 300 });

  assert.deepEqual(unconfirmed, { ok: false, reason: "board_unavailable" });
  const repeated = await createCentralAccountingFundingAtRoot(f.options).reserve({ reservationId: "uncertain", maxTokens: 300 });

  assert.ok(repeated.ok);
  assert.equal(repeated.status, "duplicate");
  assert.equal(repeated.projection.occupied.tokens, 300);
});

test("peer capability captures its owner identity instead of retaining a mutable caller reference", async t => {
  const f = await fixture(t), mutableOwner = { ...owner };
  const port = createCentralAccountingFundingAtRoot({ ...f.options, owner: mutableOwner });
  mutableOwner.ownerId = "changed-after-construction";
  const result = await port.reserve({ reservationId: "captured", maxTokens: 100 });
  assert.ok(result.ok);
  assert.equal(result.reservation.owner.ownerId, owner.ownerId);
  const inspected = await port.inspect();
  assert.ok(inspected.ok);
  assert.deepEqual(inspected.owner, owner);
  assert.ok(Object.isFrozen(inspected.owner));
});

test("a peer's projected operation cap keeps its original Board CAS through the funding port", async t => {
  const f = await fixture(t), before = await f.read();
  const first = createCentralAccountingFundingAtRoot({ ...f.options, owner: userOwner });
  const second = createCentralAccountingFundingAtRoot({ ...f.options, owner: userOwner });
  // Both operations checked their source and segment envelope at this same prefix.
  const fence = { expectedSequence: before.sequence };
  const admitted = await first.reserve({ reservationId: "operation:a:logical-call", maxTokens: 300, ...fence });

  assert.ok(admitted.ok);
  assert.equal(admitted.status, "reserved");
  const stale = await second.reserve({ reservationId: "operation:b:logical-call", maxTokens: 300, ...fence });

  assert.ok(!stale.ok, "an internal fresh read must not replace the caller's verified prefix");
  assert.equal(stale.reason, "learning_budget_stale");
  const final = centralBudgetProjection(await f.read(), "root")!;

  assert.equal(final.occupied.tokens, 300);
  assert.equal(final.budget.accounting?.length, 1);
});
