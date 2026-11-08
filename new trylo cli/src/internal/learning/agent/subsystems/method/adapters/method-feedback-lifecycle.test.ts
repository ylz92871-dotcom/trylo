import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createMethodBoardWriter } from "./board-writer.js";
import { createMethodBoard } from "../orchestration/board.js";
import type { MethodCard } from "../domain/contracts.js";
import { nicheOf } from "../domain/niche.js";
import { emptyBoardState, normalizeBoardState } from "../../../../control/state.js";
import { reduce } from "../../../../control/reducer.js";
import { createBoardReader, withBoardWriter } from "../../../../../adapters/learning-store/file-event-store.js";
import { recoverMethodCommandIdentities } from "../../../../control/method-replay.js";

const AT = "2026-10-15T12:00:00.000Z";
const card: MethodCard = {
  schemaVersion: 1,
  hint: "keep changes inside the workspace",
  appliesWhen: { tools: ["read_file"] },
  labels: ["containment"],
  family: "containment",
  lineage: { createdFrom: { turnId: "seed", beat: 1, reason: "containment" } },
};

async function seeded(root: string) {
  const writer = createMethodBoardWriter(root);
  const committed = await writer.commitCard({
    card, nicheId: nicheOf(card), versionId: "version-1", proposalId: "proposal-1",
    evidenceId: "evidence-1", writeId: "seed-1", sample: "read_file:outside", observedAt: AT,
  });

  assert.equal(committed.ok, true);

  return writer;
}

async function withRoot(run: (root: string) => Promise<void>) {
  const root = mkdtempSync(path.join(os.tmpdir(), "trylo-method-feedback-"));
  try { await run(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

test("method replay rejects a changed payload under an already applied commandId", () => {
  const fielding = {
    type: "record_method_fielding" as const, commandId: "use-1", issuedAt: AT,
    exposureId: "exposure-1", versionId: "version-1", proposalId: "proposal-1",
    turnId: "turn-1", beat: 1, requestId: "request-1", scope: "niche-1",
  };
  const first = reduce(emptyBoardState(), fielding);

  assert.ok(first.ok);
  const feedback = {
    type: "record_method_feedback" as const, commandId: "feedback-1", issuedAt: AT,
    exposureId: "exposure-1", versionId: "version-1", turnId: "turn-1", helped: true,
  };
  const second = reduce(first.state, feedback);

  assert.ok(second.ok);
  const exact = reduce(second.state, { ...feedback, issuedAt: "2026-10-15T12:00:01.000Z" });

  assert.ok(exact.ok && exact.idempotent);
  const changed = reduce(second.state, { ...feedback, exposureId: "missing", helped: false });

  assert.equal(changed.ok, false);

  if (!changed.ok) assert.equal(changed.reason, "command_payload_conflict");

  assert.deepEqual(changed.state.feedbacks, second.state.feedbacks);
  const legacy = normalizeBoardState({ ...second.state,
    appliedCommands: second.state.appliedCommands.map(({ commandId, sequence }) => ({ commandId, sequence })) });

  assert.ok(legacy);
  const legacyExact = reduce(legacy, feedback);

  assert.equal(legacyExact.ok, false, "an old compacted snapshot cannot prove the original command payload");

  if (!legacyExact.ok) assert.equal(legacyExact.reason, "command_identity_unavailable");

  assert.equal(reduce(legacy, { ...feedback, exposureId: "missing" }).ok, false);
  const recovered = recoverMethodCommandIdentities(legacy, [fielding, feedback]);
  const recoveredExact = reduce(recovered, feedback);

  assert.ok(recoveredExact.ok && recoveredExact.idempotent, "original logs restore exact replay identity");
  assert.equal(reduce(recovered, { ...feedback, exposureId: "missing" }).ok, false);
});

test("persisted feedback projects distinct-turn fielding/helped counts without inventing unknown feedback", async () => {
  await withRoot(async root => {
    const writer = await seeded(root);

    for (let beat = 1; beat <= 2; beat += 1) {
      const exposureId = `exposure-${beat}`;

      assert.equal((await writer.recordUse({
        writeId: exposureId, exposureId, versionId: "version-1", proposalId: "proposal-1",
        turnId: "turn-1", beat, requestId: `request-${beat}`, scope: nicheOf(card), observedAt: AT,
      })).ok, true);
      assert.equal((await writer.recordFeedback({
        writeId: exposureId, exposureId, versionId: "version-1", turnId: "turn-1",
        helped: true, observedAt: AT,
      })).ok, true);
    }

    assert.equal((await writer.recordUse({
      writeId: "unknown", exposureId: "unknown", versionId: "version-1", proposalId: "proposal-1",
      turnId: "turn-2", beat: 1, requestId: "request-unknown", scope: nicheOf(card), observedAt: AT,
    })).ok, true);
    const loaded = await createMethodBoardWriter(root).load();

    assert.ok(loaded.ok);
    const variant = loaded.variants[0];

    assert.ok(variant);
    assert.equal(Reflect.get(variant.ledger, "fieldedCount"), 2);
    assert.equal(Reflect.get(variant.ledger, "helpedCount"), 1);
    assert.equal(variant.ledger.counterexamples, 0);
  });
});

test("legacy feedback settles to middle across restart without fabricating stable qualification", async () => {
  await withRoot(async root => {
    await seeded(root);
    const board = createMethodBoard({ archive: createMethodBoardWriter(root), emit: () => {}, now: () => AT });

    for (let turn = 1; turn <= 8; turn += 1) {
      const turnId = `turn-${turn}`;
      const slot = await board.requestSlot({ turnId, beat: 1, toolNames: ["read_file"] });

      assert.ok(slot);
      await board.recordFielding({ attemptId: `attempt-${turn}`, turnId, beat: 1, receipts: slot.receipts });
      await board.recordFeedback({ attemptId: `attempt-${turn}`, turnId, beat: 1,
        items: [{ versionId: "version-1", helped: turn <= 4 }] });
      await board.endTurn(turnId);
      const loaded = await createMethodBoardWriter(root).load();

      assert.ok(loaded.ok);
      const variant = loaded.variants[0];

      assert.ok(variant);
      assert.equal(Reflect.get(variant, "layer"), turn < 3 ? "working" : "middle");
    }

    const restarted = createMethodBoard({ archive: createMethodBoardWriter(root), emit: () => {}, now: () => AT });
    const slot = await restarted.requestSlot({ turnId: "turn-9", beat: 1, toolNames: ["read_file"] });

    assert.ok(slot, "legacy middle methods remain available for trial use");
    const compacted = await withBoardWriter(root, async store => {
      const loaded = await store.load();
      assert.ok(loaded.ok);
      return store.compact(loaded.generation);
    });

    assert.ok(compacted.ok);
    const restored = await createMethodBoardWriter(root).load();

    assert.ok(restored.ok);
    assert.equal(restored.variants[0]?.layer, "middle");
    assert.equal(restored.variants[0]?.ledger.helpedCount, 4);
    const facts = await createBoardReader(root).load();

    assert.ok(facts.ok);
    assert.equal(facts.state.fieldings.length, 8);
    assert.equal(facts.state.feedbacks.length, 8);
  });
});

test("writer rejects reused feedback identity with changed exposure after process-style reload", async () => {
  await withRoot(async root => {
    const writer = await seeded(root);

    assert.equal((await writer.recordUse({ writeId: "use-1", exposureId: "exposure-1", versionId: "version-1",
      proposalId: "proposal-1", turnId: "turn-1", beat: 1, requestId: "request-1", scope: nicheOf(card), observedAt: AT })).ok, true);
    const feedback = { writeId: "feedback-1", exposureId: "exposure-1", versionId: "version-1",
      turnId: "turn-1", helped: true, observedAt: AT };

    assert.equal((await writer.recordFeedback(feedback)).ok, true);
    const restarted = createMethodBoardWriter(root);
    const exact = await restarted.recordFeedback({ ...feedback, observedAt: "2026-10-15T12:00:01.000Z" });

    assert.ok(exact.ok && exact.duplicate);
    const conflict = await restarted.recordFeedback({ ...feedback, exposureId: "missing" });

    assert.equal(conflict.ok, false);

    if (!conflict.ok) assert.equal(conflict.reason, "command_payload_conflict");

    const loaded = await createBoardReader(root).load();

    assert.ok(loaded.ok);
    assert.equal(loaded.state.feedbacks.length, 1);
  });
});

test("retention commands guard promotion evidence and preserve evicted assets across reload", async () => {
  await withRoot(async root => {
    await seeded(root);
    const unjustified = await withBoardWriter(root, store => store.apply({
      type: "set_method_retention", commandId: "promote-without-use", issuedAt: AT,
      record: { versionId: "version-1", layer: "middle", retention: "retained", recordedAt: AT },
    }));

    assert.equal(unjustified.ok, false);

    if (!unjustified.ok) assert.equal(unjustified.reason, "invalid_method_retention");

    const evicted = await withBoardWriter(root, store => store.apply({
      type: "set_method_retention", commandId: "evict-1", issuedAt: AT,
      record: { versionId: "version-1", layer: "working", retention: "evicted", recordedAt: AT },
    }));

    assert.ok(evicted.ok);
    const restored = await createMethodBoardWriter(root).load();

    assert.ok(restored.ok);
    assert.equal(restored.variants.length, 1, "eviction keeps the source asset");
    assert.equal(restored.variants[0]?.retention, "evicted");
    const board = createMethodBoard({ archive: createMethodBoardWriter(root), emit: () => {}, now: () => AT });

    assert.equal(await board.requestSlot({ turnId: "after-eviction", beat: 1, toolNames: ["read_file"] }), undefined);
  });
});
