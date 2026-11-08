import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createRewardV2BoardPort, RewardV2BoardError } from "../reward/v2-board-port.js";
import { canonicalJson } from "../../learning/control/hash.js";
import { createCentralPublicSourceFrames, readCentralPublicSourceFrame, type CentralPublicSourceFrameInput } from "./public-source-frames.js";

const SCOPE = "project:public-source-frame";
const source = (): CentralPublicSourceFrameInput => ({ ref: "native-public-body:immutable-one",
  text: "Original public feedback with retained uncertainty. ".repeat(3000), sourceRefs: ["native-feedback:one"],
  origin: { originalRef: "native-frame:one", originalSourceHash: "raw-source-hash", publicViewHash: "public-view-hash" } });

async function withRoot(run: (root: string) => Promise<void>) {
  const parent = resolve(tmpdir()), root = await mkdtemp(join(parent, "central-public-source-"));
  try { await run(root); }
  finally {
    assert.equal(dirname(resolve(root)), parent);
    assert.ok(root.startsWith(join(parent, "central-public-source-")));
    await rm(root, { recursive: true, force: true });
  }
}

const options = (boardRoot: string) => ({ boardRoot, scope: SCOPE, enabled: () => true });

test("complete public source bytes survive cold read and repeated metadata observes the first immutable frame", async () => withRoot(async root => {
  const owner = createCentralPublicSourceFrames(options(root)), original = source();
  const frozen = await owner.freeze(original);
  assert.ok(frozen.text.length > 131072);
  assert.deepEqual(frozen.origin, original.origin);
  assert.ok(Object.isFrozen(frozen));
  assert.ok(Object.isFrozen(frozen.origin));
  const board = createRewardV2BoardPort(root, () => true), before = await board.read();

  assert.deepEqual(readCentralPublicSourceFrame(before.facts, { scope: SCOPE, ref: original.ref, boardSequence: before.revision }), frozen);
  assert.throws(() => readCentralPublicSourceFrame(before.facts, { scope: SCOPE, ref: original.ref, boardSequence: before.revision - 1 }), /prefix_corrupt/);
  const cold = createCentralPublicSourceFrames(options(root));
  assert.deepEqual(await cold.read(original.ref), frozen);
  assert.deepEqual(await cold.freeze({ ...original, sourceRefs: ["native-feedback:later-observation"], origin: { observedAgainAt: 2 } }), frozen);
  assert.equal((await board.read()).revision, before.revision);
  await assert.rejects(cold.freeze({ ...original, text: "Different bytes under the same immutable body alias" }), /source_conflict/);
  assert.equal((await board.read()).revision, before.revision);
  assert.ok(before.facts.every(fact => fact.kind === "projection" && fact.payloadJson.length <= 131072));
  assert.equal(await createCentralPublicSourceFrames({ ...options(root), scope: "project:other" }).read(original.ref), undefined);
}));

test("source batches retry proved pre-entry contention, suspend unknown partial writes and recover committed bytes without replay", async () => withRoot(async root => {
  const board = createRewardV2BoardPort(root, () => true), appendBatch = board.appendBatch;

  assert.ok(appendBatch, "the original file Board exposes batch admission");
  type BatchArgs = Parameters<NonNullable<typeof board.appendBatch>>;
  const signal = new AbortController().signal;

  let singleWrites = 0;
  const knownBatches: BatchArgs[] = [];
  const known = createCentralPublicSourceFrames({ ...options(root), board: {
    read: board.read,

    async append(...args: Parameters<typeof board.append>) {
      singleWrites += 1;
      return board.append(...args);
    },

    async appendBatch(...args: BatchArgs) {
      knownBatches.push(args);
      if (knownBatches.length === 1) throw new RewardV2BoardError("multi_writer", "not_started");
      return appendBatch(...args);
    },
  } });
  const contended = { ...source(), ref: "native-public-body:known-contention" };
  const recoveredContention = await known.freeze(contended, signal);

  assert.equal(singleWrites, 0, "a normal batch port must not fall back to per-fragment append");
  assert.equal(knownBatches.length, 2, "one proved pre-entry failure permits one retry of the same batch");
  assert.ok(knownBatches.every(args => args[2] === signal), "each original admission receives the exact cancellation signal");
  const committedFacts = knownBatches[1]![1];

  assert.ok(committedFacts.length >= 3, "multiple fragments and their manifest share one successful batch");
  assert.ok(committedFacts.slice(0, -1).every(fact => fact.algorithmVersion.endsWith(":chunk:v1")));
  assert.ok(committedFacts.at(-1)!.algorithmVersion.endsWith(":manifest:v1"));
  assert.deepEqual(knownBatches[0]![1], committedFacts, "contention must not replace the immutable facts");
  assert.equal(recoveredContention.text, contended.text);
  assert.deepEqual(await known.read(contended.ref), recoveredContention);

  const partialBatches: BatchArgs[] = [];
  let partialSingleWrites = 0;
  const partial = createCentralPublicSourceFrames({ ...options(root), board: {
    read: board.read,

    async append(...args: Parameters<typeof board.append>) {
      partialSingleWrites += 1;
      return board.append(...args);
    },

    async appendBatch(...args: BatchArgs) {
      partialBatches.push(args);
      await appendBatch(args[0], args[1].slice(0, 1), args[2]);
      throw new Error("unknown acknowledgement after the first durable fragment");
    },
  } });
  const interrupted = { ...source(), ref: "native-public-body:unknown-partial" };

  await assert.rejects(partial.freeze(interrupted, signal), /write_unconfirmed/);
  assert.equal(partialSingleWrites, 0);
  assert.equal(partialBatches.length, 1);
  const partialFacts = partialBatches[0]![1], partialSnapshot = await board.read();

  assert.ok(partialFacts.length >= 3);
  assert.ok(partialSnapshot.facts.some(fact => fact.id === partialFacts[0]!.id), "the failed batch really persisted a fragment");
  assert.ok(!partialSnapshot.facts.some(fact => fact.id === partialFacts.at(-1)!.id), "an unknown partial batch must not manufacture its manifest");
  assert.equal(await partial.read(interrupted.ref), undefined, "orphan fragments are not an archived body");
  await assert.rejects(partial.freeze({ ...interrupted, ref: "native-public-body:blocked-after-partial" }, signal), /writer_suspended/);
  assert.equal(partialBatches.length, 1);
  assert.equal(partialSingleWrites, 0);
  assert.equal((await board.read()).revision, partialSnapshot.revision, "suspension must prevent subsequent writes");

  let durableBatches = 0, durableSingleWrites = 0;
  const owner = createCentralPublicSourceFrames({ ...options(root), board: {
    read: board.read,

    async append(...args: Parameters<typeof board.append>) {
      durableSingleWrites += 1;
      return board.append(...args);
    },

    async appendBatch(...args: BatchArgs) {
      durableBatches += 1;
      const result = await appendBatch(...args);
      if (durableBatches === 1) throw new Error("complete batch acknowledgement lost after commit");
      return result;
    },
  } });
  const original = { ...source(), ref: "native-public-body:durable-ack-loss", text: "public_archive_marker_before_credentials_change" };
  const frozen = await owner.freeze(original, signal);

  assert.equal(durableBatches, 1);
  assert.equal(durableSingleWrites, 0);
  assert.deepEqual(await owner.freeze(original, signal), frozen);
  assert.deepEqual(await owner.read(original.ref), frozen);
  assert.equal(durableBatches, 1, "exact durable readback confirms the same archive without appending again");
  const next = { ...original, ref: "native-public-body:after-confirmed-ack-loss" };

  assert.equal((await owner.freeze(next, signal)).text, next.text);
  assert.equal(durableBatches, 2, "a fully confirmed batch must not leave this owner permanently suspended");
  assert.equal(durableSingleWrites, 0);
  assert.deepEqual(await createCentralPublicSourceFrames(options(root)).read(original.ref), frozen);
  await assert.rejects(createCentralPublicSourceFrames({ ...options(root), secrets: [original.text] }).read(original.ref), /sensitive/);
  let reads = 0;
  const disabled = createCentralPublicSourceFrames({ ...options(root), enabled: () => false,
    board: { read: async () => {
      reads += 1;
      return board.read();
    }, append: board.append } });

  await assert.rejects(disabled.read(original.ref), /collect_disabled/);
  assert.equal(reads, 0);
}));

test("orphan chunks, altered bytes and exhausted known-stale retries never manufacture an archived source", async () => withRoot(async root => {
  const board = createRewardV2BoardPort(root, () => true), original = { ...source(), text: "A bounded real public frame" };
  const interrupted = createCentralPublicSourceFrames({ ...options(root), board: { read: board.read, async append(...args: Parameters<typeof board.append>) {
    if (args[1].algorithmVersion.endsWith(":manifest:v1")) throw new Error("stopped before manifest");
    return board.append(...args);
  } } });

  await assert.rejects(interrupted.freeze(original), /write_unconfirmed/);
  assert.equal(await interrupted.read(original.ref), undefined);
  const owner = createCentralPublicSourceFrames(options(root));
  await owner.freeze(original);
  const current = await board.read(), corrupted = { ...current, facts: current.facts.map(fact => {
    if (!fact.algorithmVersion.endsWith(":chunk:v1")) return fact;
    const body = JSON.parse(fact.payloadJson);
    return { ...fact, payloadJson: canonicalJson({ ...body, text: body.text.replace("bounded", "ALTERED") }) };
  }) };

  await assert.rejects(createCentralPublicSourceFrames({ ...options(root), board: { read: async () => corrupted, append: board.append } }).read(original.ref), /chunk_corrupt/);
  let attempts = 0;
  const stale = createCentralPublicSourceFrames({ ...options(root), board: { read: board.read,

    async append() {
      attempts += 1;
      return { status: "stale" as const };
    } } });

  await assert.rejects(stale.freeze({ ...original, ref: "native-public-body:stale" }), /source_stale/);
  assert.equal(attempts, 4);
  await assert.rejects(owner.freeze({ ...original, ref: "native-public-body:oversized", text: "x".repeat(1024 * 1024) }), /chunk_capacity/);
  assert.equal((await board.read()).revision, current.revision);
}));
