import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createBoardReader, withBoardWriter } from "../../../../../adapters/learning-store/file-event-store.js";
import type { ExperienceReviewRequest } from "../experience-port.js";
import { createExperienceFunding } from "./experience-funding.js";

const REQUEST: ExperienceReviewRequest = { snapshotId: "snapshot", versionId: "v1", method: "Inspect before retrying", confidence: .99,
  observations: [], counterexamples: [], scope: { id: "h1", scopeId: "s1", versionId: "v1", proposedSequence: 0,
    predicate: { all: [{ feature: "operation", value: "retry" }], exclude: [] } } };

function funding(root: string, turnId: string, enabled = () => true) {
  return createExperienceFunding({ boardRoot: root, workspaceId: "workspace", turnId, now: () => "2026-11-03T08:00:00.000Z", request: REQUEST, enabled });
}

test("central scope normalization retains the existing method lifetime purse and never refills exhausted calls", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "trylo-method-central-scope-"));
  try {
    const legacy = funding(root, "legacy-turn");

    assert.ok((await legacy.reserve({ reservationId: "legacy-call", maxTokens: 6000 })).ok);
    assert.ok((await legacy.settle({ reservationId: "legacy-call", usage: { kind: "reported", totalTokens: 150 } })).ok);
    const current = (index: number) => createExperienceFunding({ boardRoot: root, workspaceId: "workspace", centralScope: "D:/project/workspace",
      turnId: `current-turn-${index}`, now: () => "2026-11-03T08:00:00.000Z", request: REQUEST, enabled: () => true });

    for (let index = 1; index < 4; index++) {
      const port = current(index), inspected = await port.inspect();
      assert.ok(inspected.ok);
      assert.equal(inspected.remaining.calls, 4 - index);
      assert.ok((await port.reserve({ reservationId: `current-call-${index}`, maxTokens: 6000 })).ok);
      assert.ok((await port.settle({ reservationId: `current-call-${index}`, usage: { kind: "reported", totalTokens: 150 } })).ok);
    }

    assert.deepEqual(await current(4).inspect(), { ok: false, reason: "method_review_budget_exhausted" });
    const loaded = await createBoardReader(root).load();
    assert.ok(loaded.ok);
    const grants = loaded.state.centralLearningGrants!;

    assert.equal(grants.length, 1);
    assert.equal(grants[0]?.scope, "workspace");
    assert.equal(grants[0]?.reservations.length, 4);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("one scope keeps its original four-call central allowance across new turns", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "trylo-method-funding-"));
  try {
    for (let n = 0; n < 4; n++) {
      const port = funding(root, `turn-${n}`), state = await port.inspect();
      assert.ok(state.ok && state.active);
      assert.equal(state.remaining.calls, 4 - n);
      const maxTokens = n === 0 ? 12000 : 6000;
      assert.deepEqual(await port.reserve({ reservationId: `call-${n}`, maxTokens }), { ok: true, status: "reserved" });
      assert.deepEqual(await port.reserve({ reservationId: `call-${n}`, maxTokens }), { ok: true, status: "duplicate" });
      assert.deepEqual(await port.settle({ reservationId: `call-${n}`, usage: { kind: "reported", totalTokens: 150, inputTokens: 120, outputTokens: 30 } }), { ok: true });
    }

    assert.deepEqual(await funding(root, "turn-5").inspect(), { ok: false, reason: "method_review_budget_exhausted" });
    const loaded = await createBoardReader(root).load();
    assert.ok(loaded.ok);
    assert.equal(loaded.state.centralLearningGrants?.length, 1);
    assert.equal(loaded.state.centralLearningGrants?.[0]?.reservations.length, 4);
    assert.equal(loaded.state.centralLearningGrants?.[0]?.allowance.maxTokens, 24000);
    assert.equal(loaded.state.jobs[0]?.domain, "prompt");
    assert.equal(loaded.state.jobs[0]?.state, "queued");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("cancellation still settles the original reservation with unknown usage", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "trylo-method-cancel-"));
  let active = true;

  try {
    const port = funding(root, "turn", () => active);

    assert.ok((await port.inspect()).ok);
    assert.ok((await port.reserve({ reservationId: "call", maxTokens: 6000 })).ok);
    active = false;
    assert.deepEqual(await port.settle({ reservationId: "call", usage: { kind: "unknown", reason: "cancelled_after_send" } }), { ok: true });
    const loaded = await createBoardReader(root).load();
    assert.ok(loaded.ok);
    assert.equal(loaded.state.centralLearningGrants?.[0]?.reservations[0]?.usage?.kind, "unknown");
    assert.equal(loaded.state.centralLearningGrants?.[0]?.claim, undefined);
    assert.deepEqual(await funding(root, "disabled", () => false).inspect(), { ok: false, reason: "method_review_inactive" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("an externally supplied unrelated claim cannot be charged", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "trylo-method-binding-"));
  try {
    const port = createExperienceFunding({ boardRoot: root, workspaceId: "workspace", turnId: "turn", now: () => "2026-11-03T08:00:00.000Z",
      request: REQUEST, enabled: () => true, binding: { grantId: "missing", claimId: "forged" } });
    assert.deepEqual(await port.inspect(), { ok: false, reason: "method_review_grant_binding" });
    const loaded = await createBoardReader(root).load();
    assert.ok(loaded.ok);
    assert.equal(loaded.state.centralLearningGrants?.length ?? 0, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a live claim for another method source cannot fund this request even in the same workspace", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "trylo-method-source-binding-"));
  try {
    assert.ok((await funding(root, "source").inspect()).ok);
    const loaded = await createBoardReader(root).load();
    assert.ok(loaded.ok);
    const grant = loaded.state.centralLearningGrants![0]!;
    const claimed = await withBoardWriter(root, board => board.apply({ type: "coordinate_learning", commandId: "claim-source", issuedAt: "2026-11-03T08:00:00.000Z",
      action: { kind: "claim", jobId: grant.jobId, expectedAttempt: 0, claimId: "claim-source", ownerId: "test-owner", expiresAt: "2026-11-03T08:01:00.000Z" } }));

    assert.ok(claimed.ok);
    const wrong = createExperienceFunding({ boardRoot: root, workspaceId: "workspace", turnId: "wrong-source", now: () => "2026-11-03T08:00:00.000Z",
      request: { ...REQUEST, versionId: "unrelated-method" }, enabled: () => true, binding: { grantId: grant.grantId, claimId: "claim-source" } });

    assert.deepEqual(await wrong.inspect(), { ok: false, reason: "method_review_grant_binding" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("an observed overrun closes the central grant without trying to yield its already failed job", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "trylo-method-overrun-"));
  try {
    const port = funding(root, "turn");
    assert.ok((await port.inspect()).ok);
    assert.ok((await port.reserve({ reservationId: "call", maxTokens: 6000 })).ok);
    assert.deepEqual(await port.settle({ reservationId: "call", usage: { kind: "reported", totalTokens: 50000 } }), { ok: true });
    const loaded = await createBoardReader(root).load();
    assert.ok(loaded.ok);
    assert.equal(loaded.state.centralLearningGrants?.[0]?.closedReason, "model_token_overrun");
    assert.equal(loaded.state.jobs[0]?.state, "failed");
    assert.deepEqual(await funding(root, "later").inspect(), { ok: false, reason: "method_review_grant_closed" });
  } finally { await rm(root, { recursive: true, force: true }); }
});
