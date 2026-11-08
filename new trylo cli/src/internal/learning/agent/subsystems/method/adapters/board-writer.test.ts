import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createMethodBoardWriter, METHOD_ASSET_KIND, METHOD_DOMAIN } from "./board-writer.js";
import { createBoardReader } from "../../../../../adapters/learning-store/file-event-store.js";
import type { MethodCard, VariantRecord } from "../domain/contracts.js";
import { nicheOf } from "../domain/niche.js";
import type { CommitCardInput } from "../port.js";

/**
 * 适配器的合同：一张卡进去，控制板上真的多了一条生命周期，读回来还是那张卡。
 *
 * 这一组用的是**真的** `FileBoardStore`（临时目录里的真文件），不是假 store：
 * 「入档落点」这件事的全部风险就在于真实的 reducer 守卫会不会放行这个次序，
 * 而假 store 恰好会把那个风险抹掉。规格 §7.2 明令「按守卫调整次序，不许改守卫」，
 * 所以这里量的是守卫，不是我们的意图。
 */

const OBSERVED_AT = "2026-09-16T00:00:00.000Z";

function card(hint: string, labels: ReadonlyArray<string> = ["containment"]): MethodCard {
  return {
    schemaVersion: 1,
    hint,
    appliesWhen: { tools: ["write_file"], failureFamily: "containment" },
    labels,
    family: "containment",
    lineage: { createdFrom: { turnId: "turn-1", beat: 2, reason: "containment" } },
  };
}

function commit(hint: string, writeId: string): CommitCardInput {
  return {
    card: card(hint),
    nicheId: nicheOf(card(hint)),
    versionId: `ver:${writeId}`,
    proposalId: `prop:${writeId}`,
    evidenceId: `ev:${writeId}`,
    writeId,
    sample: "write_file:path_outside_workspace",
    observedAt: OBSERVED_AT,
  };
}

async function withBoard(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "trylo-method-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function variantFor(variants: ReadonlyArray<VariantRecord>, writeId: string): VariantRecord {
  const found = variants.find((variant) => variant.versionId === `ver:${writeId}`);
  assert.notEqual(found, undefined, `expected ver:${writeId} in ${variants.length} variants`);
  return found as VariantRecord;
}

test("a closed controller reads an empty archive instead of failing", async () => {
  await withBoard(async (dir) => {
    const loaded = await createMethodBoardWriter(path.join(dir, "board")).load();
    assert.equal(loaded.ok, true);
    assert.deepEqual(loaded.ok ? loaded.variants : undefined, []);
    assert.deepEqual(loaded.ok ? loaded.shadowActivations : undefined, {});
  });
});

test("a card walks the board lifecycle and comes back as the same card", async () => {
  await withBoard(async (dir) => {
    const writer = createMethodBoardWriter(dir);
    const written = await writer.commitCard(commit("keep paths inside the root", "w1"));

    assert.deepEqual(written.ok, true, JSON.stringify(written));
    assert.equal(written.ok ? written.duplicate : true, false);
    assert.equal(written.ok ? written.events > 0 : false, true);

    const loaded = await writer.load();

    assert.equal(loaded.ok, true);
    const variants = loaded.ok ? loaded.variants : [];

    assert.equal(variants.length, 1);
    const variant = variantFor(variants, "w1");

    assert.equal(variant.card.hint, "keep paths inside the root");
    assert.equal(variant.nicheId, commit("keep paths inside the root", "w1").nicheId);
    assert.deepEqual(variant.card.appliesWhen, {
      tools: ["write_file"],
      failureFamily: "containment",
    });
  });
});

test("the archive records where a card came from and under which identity", async () => {
  await withBoard(async (dir) => {
    const writer = createMethodBoardWriter(dir);

    await writer.commitCard(commit("keep paths inside the root", "w1"));
    const loaded = await writer.load();
    const variant = variantFor(loaded.ok ? loaded.variants : [], "w1");

    assert.equal(variant.card.lineage.createdFrom.turnId, "turn-1");
    assert.equal(variant.card.lineage.createdFrom.beat, 2);
    assert.equal(variant.card.lineage.createdFrom.reason, "containment");
    assert.equal(METHOD_DOMAIN, "prompt");
    assert.equal(METHOD_ASSET_KIND, "prompt_patch");
  });
});

test("the same card written twice leaves one lifecycle, not two", async () => {
  await withBoard(async (dir) => {
    const writer = createMethodBoardWriter(dir);

    await writer.commitCard(commit("keep paths inside the root", "w1"));
    const again = await writer.commitCard(commit("keep paths inside the root", "w1"));

    assert.equal(again.ok, true, JSON.stringify(again));
    assert.equal(again.ok ? again.duplicate : false, true);
    const loaded = await writer.load();

    assert.equal(loaded.ok ? loaded.variants.length : -1, 1);
  });
});

test("nothing this package writes ever points a variant somewhere other than shadow", async () => {
  await withBoard(async (dir) => {
    const writer = createMethodBoardWriter(dir);

    await writer.commitCard(commit("keep paths inside the root", "w1"));
    // 停在 `commit_asset`：一条 activation 都没有，所以「不许到 active」是
    // 构造事实而不是纪律。若哪天有写入者真的写了 shadow 收据，这个断言会变成
    // 「只有一个键，且它来自 shadow 指针」，而不会变成放行 active。
    const loaded = await writer.load();

    assert.deepEqual(loaded.ok ? loaded.shadowActivations : {}, {});
  });
});

test("accounting folds out of board evidence, not out of a second local ledger", async () => {
  await withBoard(async (dir) => {
    const writer = createMethodBoardWriter(dir);

    await writer.commitCard(commit("keep paths inside the root", "w1"));
    await writer.recordAccount({
      writeId: "w1",
      evidenceId: "acc-1",
      proposalId: "prop:w1",
      outcome: "supports",
      samples: [],
      observedAt: OBSERVED_AT,
    });
    const loaded = await writer.load();
    const variant = variantFor(loaded.ok ? loaded.variants : [], "w1");

    assert.equal(variant.ledger.supports, 1);
    assert.equal(variant.ledger.counterexamples, 0);
    assert.equal(variant.ledger.state, "active_pool");
  });
});

test("two counterexamples make a variant dormant without deleting it", async () => {
  await withBoard(async (dir) => {
    const writer = createMethodBoardWriter(dir);

    await writer.commitCard(commit("keep paths inside the root", "w1"));

    for (const n of ["1", "2"]) {
      await writer.recordAccount({
        writeId: "w1",
        evidenceId: `acc-${n}`,
        proposalId: "prop:w1",
        outcome: "counterexamples",
        samples: ["write_file:path_outside_workspace"],
        observedAt: OBSERVED_AT,
      });
    }

    const loaded = await writer.load();
    const variants = loaded.ok ? loaded.variants : [];

    // 还在档里——反例不删档，只是不进候选。
    assert.equal(variants.length, 1);
    const variant = variantFor(variants, "w1");

    assert.equal(variant.ledger.counterexamples, 2);
    assert.equal(variant.ledger.supports, 0);
    assert.equal(variant.ledger.state, "dormant");
  });
});

test("a broken board fails closed instead of pretending to be empty", async () => {
  await withBoard(async (dir) => {
    const writer = createMethodBoardWriter(dir);

    await writer.commitCard(commit("keep paths inside the root", "w1"));
    // 把日志改坏：校验和/解码必然失败，而「读不出来」与「空档」必须是两件事。
    const log = path.join(dir, "board-events.ndjson");
    const { writeFile } = await import("node:fs/promises");

    await writeFile(log, "not-a-record\n", "utf8");
    const loaded = await writer.load();

    assert.equal(loaded.ok, false);
  });
});

test("a second niche is a second variant, not a replacement", async () => {
  await withBoard(async (dir) => {
    const writer = createMethodBoardWriter(dir);

    await writer.commitCard(commit("keep paths inside the root", "w1"));
    const other: CommitCardInput = {
      ...commit("stop repeating the same call", "w2"),
      card: {
        ...card("stop repeating the same call", ["repeat_call"]),
        appliesWhen: { tools: ["read_file"], failureFamily: "repeat_call" },
        family: "repeat_call",
      },
    };

    await writer.commitCard(other);
    const loaded = await writer.load();

    assert.equal(loaded.ok ? loaded.variants.length : -1, 2);
  });
});

test("M1: uses survive reload and dedupe by turn while keeping request detail", async () => {
  await withBoard(async (dir) => {
    const writer = createMethodBoardWriter(dir);

    await writer.commitCard(commit("keep paths inside the root", "w1"));
    const use = (exposureId: string, turnId: string, beat: number, requestId: string, writeId: string) =>
      writer.recordUse({
        writeId,
        exposureId,
        versionId: "ver:w1",
        proposalId: "prop:w1",
        turnId,
        beat,
        requestId,
        scope: "ws",
        observedAt: OBSERVED_AT,
      });

    // 同一 turn 两拍：两次请求明细都落盘，但上场只计一次（D-M1）。
    assert.equal((await use("exp-1", "turn-a", 1, "req-1", "u1")).ok, true);
    assert.equal((await use("exp-2", "turn-a", 2, "req-2", "u2")).ok, true);
    // 换 turn：第二次上场。
    assert.equal((await use("exp-3", "turn-b", 1, "req-3", "u3")).ok, true);
    // 同一 exposure 重放：幂等，不多记。
    const replay = await use("exp-3", "turn-b", 1, "req-3", "u3");

    assert.equal(replay.ok, true);
    assert.equal(replay.ok ? replay.duplicate : false, true);

    const reloaded = await createMethodBoardWriter(dir).load();

    assert.equal(reloaded.ok, true);
    const variant = variantFor(reloaded.ok ? reloaded.variants : [], "w1");

    assert.equal(variant.ledger.uses, 2);
    // P2-2: recency is the persistent log ordinal, NOT the max beat. The three
    // appended fieldings are turn-a/beat-1, turn-a/beat-2, turn-b/beat-1; the most
    // recent is the turn-b one at ordinal 3. The old max-beat projection returned 2
    // (turn-a/beat-2), wrongly ranking the earlier turn as the latest use.
    assert.equal(variant.ledger.lastUsedSeq, 3);
  });
});

test("M1: use and feedback for an unknown version are refused, not recorded", async () => {
  await withBoard(async (dir) => {
    const writer = createMethodBoardWriter(dir);

    await writer.commitCard(commit("keep paths inside the root", "w1"));
    const use = await writer.recordUse({
      writeId: "ux",
      exposureId: "exp-x",
      versionId: "ver:ghost",
      proposalId: "prop:ghost",
      turnId: "turn-a",
      beat: 1,
      requestId: "req-x",
      scope: "ws",
      observedAt: OBSERVED_AT,
    });

    assert.equal(use.ok, false);
    const feedback = await writer.recordFeedback({
      writeId: "fx",
      versionId: "ver:ghost",
      turnId: "turn-a",
      helped: true,
      observedAt: OBSERVED_AT,
    });

    assert.equal(feedback.ok, false);
    const loaded = await writer.load();

    assert.equal(loaded.ok ? loaded.variants.length : -1, 1);
  });
});

test("M1: feedback persists alongside uses and survives reload", async () => {
  await withBoard(async (dir) => {
    const writer = createMethodBoardWriter(dir);

    await writer.commitCard(commit("keep paths inside the root", "w1"));
    await writer.recordUse({
      writeId: "u1",
      exposureId: "exp-1",
      versionId: "ver:w1",
      proposalId: "prop:w1",
      turnId: "turn-a",
      beat: 1,
      requestId: "req-1",
      scope: "ws",
      observedAt: OBSERVED_AT,
    });
    const feedback = await writer.recordFeedback({
      writeId: "f1",
      versionId: "ver:w1",
      turnId: "turn-a",
      helped: true,
      exposureId: "exp-1",
      providerAttemptId: "att-1",
      sourceEventId: "evt-1",
      observedAt: OBSERVED_AT,
    });

    assert.equal(feedback.ok, true, JSON.stringify(feedback));
    // 缺失反馈不成 false：这里只断言 true 那条落盘且 uses 不动。
    const loaded = await createMethodBoardWriter(dir).load();
    const variant = variantFor(loaded.ok ? loaded.variants : [], "w1");

    assert.equal(variant.ledger.uses, 1);
    assert.equal(variant.ledger.supports, 0);
  });
});

test("P1-2: feedback for a filed-but-never-fielded version is refused, not persisted", async () => {
  await withBoard(async (dir) => {
    const writer = createMethodBoardWriter(dir);

    await writer.commitCard(commit("keep paths inside the root", "w1"));
    // The external review's probe: the version IS filed, so the old write口 (which
    // only checked version existence) returned {"ok":true,"events":1} for a feedback
    // that names a turn/exposure that never happened. Attribution against canonical
    // board state must now refuse it and persist nothing.
    const phantom = await writer.recordFeedback({
      writeId: "f-phantom",
      versionId: "ver:w1",
      turnId: "never-fielded",
      helped: true,
      exposureId: "does-not-exist",
      observedAt: OBSERVED_AT,
    });

    assert.equal(phantom.ok, false);
    assert.equal(phantom.ok ? "" : phantom.reason, "feedback_unattributable");

    // A real exposure is attributable, so the gate is not a blanket refusal: after a
    // genuine fielding, the same shape of feedback is accepted.
    await writer.recordUse({
      writeId: "u1",
      exposureId: "exp-1",
      versionId: "ver:w1",
      proposalId: "prop:w1",
      turnId: "turn-a",
      beat: 1,
      requestId: "req-1",
      scope: "ws",
      observedAt: OBSERVED_AT,
    });
    const attributed = await writer.recordFeedback({
      writeId: "f-real",
      versionId: "ver:w1",
      turnId: "turn-a",
      helped: true,
      exposureId: "exp-1",
      observedAt: OBSERVED_AT,
    });

    assert.equal(attributed.ok, true, JSON.stringify(attributed));

    // The phantom feedback left no trace: only the genuine fielding is on the board.
    const loaded = await createMethodBoardWriter(dir).load();

    assert.equal(loaded.ok, true);
    const variant = variantFor(loaded.ok ? loaded.variants : [], "w1");

    assert.equal(variant.ledger.uses, 1);
  });
});

test("P1-3: a conflicting second feedback for one exposure is refused through the real locked write path", async () => {
  await withBoard(async (dir) => {
    const writer = createMethodBoardWriter(dir);

    await writer.commitCard(commit("keep paths inside the root", "w1"));
    await writer.recordUse({
      writeId: "u1",
      exposureId: "exp-1",
      versionId: "ver:w1",
      proposalId: "prop:w1",
      turnId: "turn-a",
      beat: 1,
      requestId: "req-1",
      scope: "ws",
      observedAt: OBSERVED_AT,
    });
    const first = await writer.recordFeedback({
      writeId: "f1",
      versionId: "ver:w1",
      turnId: "turn-a",
      helped: true,
      exposureId: "exp-1",
      observedAt: OBSERVED_AT,
    });

    assert.equal(first.ok, true, JSON.stringify(first));

    // One exposure, one verdict: a *different* writeId (hence a different commandId)
    // carrying the opposite verdict for the same exposure must be refused by the
    // canonical reducer inside the write lock — not appended as a second row.
    const contradicting = await writer.recordFeedback({
      writeId: "f2",
      versionId: "ver:w1",
      turnId: "turn-a",
      helped: false,
      exposureId: "exp-1",
      observedAt: OBSERVED_AT,
    });

    assert.equal(contradicting.ok, false);
    assert.equal(contradicting.ok ? "" : contradicting.reason, "feedback_conflict");

    // Read the canonical state back off disk: exactly one feedback persisted, and it
    // is the first (helped:true). The refused write left no trace.
    const reread = await createBoardReader(dir).load();

    assert.equal(reread.ok, true);
    assert.equal(reread.ok ? reread.state.feedbacks.length : -1, 1);
    assert.equal(reread.ok ? reread.state.feedbacks[0]?.helped : undefined, true);
  });
});

/** Count the non-empty ndjson log lines under a board dir (0 if the log is absent). */
async function logRecordCount(dir: string): Promise<number> {
  try {
    const raw = await readFile(path.join(dir, "board-events.ndjson"), "utf8");
    return raw.split("\n").filter((line) => line.trim().length > 0).length;
  } catch {
    return 0;
  }
}

/**
 * P2-3: a partial write mid-sequence is normalized to a typed failure, leaves the
 * already-appended commands on disk, and a same-writeId retry completes the lifecycle
 * without duplicating events.
 *
 * The append seam throws on the Nth append (Nth command, since each non-idempotent
 * command appends exactly one record). The audit asked for failure at commands 2, 3
 * and 4 of the five-command commit sequence; each is exercised in its own fresh dir.
 */
for (const failAt of [2, 3, 4]) {
  test(`P2-3: append failure at command ${failAt} is recoverable and idempotent on retry`, async () => {
    await withBoard(async (dir) => {
      let appends = 0;
      const failing = createMethodBoardWriter(dir, {
        logAppender: (file, data, encoding) => {
          appends += 1;
          if (appends === failAt) {
            throw new Error("injected disk failure");
          }
          appendFileSync(file, data, encoding);
        },
      });

      const input = commit("keep paths inside the root", "w1");
      const failed = await failing.commitCard(input);

      assert.equal(failed.ok, false, "a mid-sequence append failure must not report success");
      assert.equal(failed.ok ? "" : failed.reason, "archive_write_failed");
      // Commands 1..failAt-1 were appended before the throw; the failing one wrote nothing.
      assert.equal(await logRecordCount(dir), failAt - 1);

      // Retry the SAME writeId with a healthy store: the earlier commands replay as
      // idempotent, the rest append fresh, and the lifecycle completes exactly once.
      const healthy = createMethodBoardWriter(dir);
      const retried = await healthy.commitCard(input);

      assert.equal(retried.ok, true, JSON.stringify(retried));
      assert.equal(retried.ok ? retried.duplicate : false, true, "earlier commands were already on the log");

      const loaded = await createMethodBoardWriter(dir).load();

      assert.equal(loaded.ok, true);
      assert.equal(loaded.ok ? loaded.variants.length : -1, 1, "exactly one lifecycle, no duplicate");
      const variant = variantFor(loaded.ok ? loaded.variants : [], "w1");

      assert.equal(variant.card.hint, "keep paths inside the root");
      assert.equal(await logRecordCount(dir), 5, "the full sequence is on the log once");
    });
  });
}
