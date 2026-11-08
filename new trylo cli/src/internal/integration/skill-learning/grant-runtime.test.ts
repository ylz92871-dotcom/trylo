import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createBoardReader, withBoardWriter } from "../../adapters/learning-store/file-event-store.js";
import type { BoardStore } from "../../learning/control/store-port.js";
import { emptyUsage, type ProviderEvent, type ProviderPort, type ProviderRequest } from "../../ports/provider.js";
import { createSkillLearningGrant } from "./grant-runtime.js";
import { withSkillLearningGrant } from "./grant-provider.js";

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(path.join(os.tmpdir(), "trylo-skill-grant-"));

  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("trylo-skill-grant-"));
    rmSync(root, { recursive: true, force: true });
  });
  const board: BoardStore = { load: () => createBoardReader(root).load(),
    apply: command => withBoardWriter(root, store => store.apply(command)),
    snapshot: generation => withBoardWriter(root, store => store.snapshot(generation)),
    compact: generation => withBoardWriter(root, store => store.compact(generation)), close: async () => {} };
  const runtime = () => createSkillLearningGrant({ board, workspaceId: "workspace-a", now: () => "2026-11-03T00:00:00Z" });

  return { board, root, runtime };
}

const allowance = { grantId: "grant-a", sourceRef: "execution:session:turn", maxCalls: 3, maxOutputTokens: 10 };
const request = (attemptId = "r1", cap = 8): ProviderRequest => ({ attemptId, model: "test", messages: [], tools: [], maxOutputTokens: cap });
const finish: ProviderEvent = { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
const usage = (inputTokens: number, outputTokens: number, mode: "snapshot" | "delta" = "snapshot"): ProviderEvent => ({ type: "usage", usage: { ...emptyUsage(mode), inputTokens, outputTokens, totalTokens: inputTokens + outputTokens } });

function provider(events: readonly ProviderEvent[], seen: ProviderRequest[] = []): ProviderPort {
  return { fork: () => provider(events, seen), async *stream(input) {
    seen.push(input);
    for (const event of events) yield event;
  } };
}

async function drain(stream: AsyncIterable<ProviderEvent>) { for await (const _event of stream) { /* Observe every provider fact. */ } }

async function opened(runtime: ReturnType<typeof createSkillLearningGrant>) {
  const result = await runtime.open(allowance);
  assert.ok(result.ok, JSON.stringify(result));
  return result;
}

const signal = () => new AbortController().signal;

test("durable allowance, immutable grant identity and unsettled reservations survive process reconstruction", async t => {
  const fx = fixture(t), first = fx.runtime();
  await opened(first);
  const reserved = await first.reserve({ grantId: "grant-a", reservationId: "r1", maxOutputTokens: 8 });
  assert.ok(reserved.ok);
  assert.equal(reserved.status, "reserved");
  const restarted = fx.runtime();
  const duplicate = await restarted.reserve({ grantId: "grant-a", reservationId: "r1", maxOutputTokens: 8 });
  assert.ok(duplicate.ok);
  assert.equal(duplicate.status, "duplicate");
  const blocked = await restarted.reserve({ grantId: "grant-a", reservationId: "r2" });
  assert.equal(blocked.ok, false);

  if (!blocked.ok) assert.equal(blocked.code, "learning_grant_unsettled");

  const conflict = await restarted.open({ ...allowance, maxOutputTokens: 100 });
  assert.equal(conflict.ok, false);
  const settled = await restarted.settle({ grantId: "grant-a", reservationId: "r1", usage: { kind: "reported", inputTokens: 3, outputTokens: 6, totalTokens: 9 } });
  assert.ok(settled.ok);
  const remaining = await fx.runtime().reserve({ grantId: "grant-a", reservationId: "r2", maxOutputTokens: 100 });
  assert.ok(remaining.ok);
  assert.equal(remaining.reservation.maxOutputTokens, 4);
  const scoped = createSkillLearningGrant({ board: fx.board, workspaceId: "foreign", now: () => "now" });
  const foreign = await scoped.read("grant-a");
  assert.equal(foreign.ok, false);
  if (!foreign.ok) assert.equal(foreign.code, "learning_grant_scope_mismatch");
});

test("snapshot and compaction retain grant spending and payload replay identity", async t => {
  const fx = fixture(t), runtime = fx.runtime();
  await opened(runtime);
  await runtime.reserve({ grantId: "grant-a", reservationId: "r1", maxOutputTokens: 8 });
  assert.ok((await runtime.settle({ grantId: "grant-a", reservationId: "r1", usage: { kind: "reported", inputTokens: 2, outputTokens: 8, totalTokens: 10 } })).ok);
  const compact = await withBoardWriter(fx.root, async store => {
    const loaded = await store.load();
    assert.ok(loaded.ok);
    return store.compact(loaded.generation);
  });
  assert.ok(compact.ok);
  const again = await opened(fx.runtime());
  assert.equal(again.status, "existing");
  assert.equal(again.snapshot.reportedOutputTokens, 8);
  const duplicate = await fx.runtime().settle({ grantId: "grant-a", reservationId: "r1", usage: { kind: "reported", inputTokens: 2, outputTokens: 8, totalTokens: 10 } });
  assert.ok(duplicate.ok);
  assert.equal(duplicate.status, "duplicate");
  const conflicting = await fx.runtime().settle({ grantId: "grant-a", reservationId: "r1", usage: { kind: "reported", inputTokens: 2, outputTokens: 1, totalTokens: 3 } });
  assert.equal(conflicting.ok, false);
});

test("forked providers share a grant; actual caps and snapshot plus delta usage charge cumulatively", async t => {
  const fx = fixture(t), runtime = fx.runtime();
  await opened(runtime);
  const seen: ProviderRequest[] = [];
  const wrapped = withSkillLearningGrant(provider([usage(5, 2), usage(1, 1, "delta"), finish], seen), { runtime, grantId: "grant-a", reservationIdFactory: req => req.attemptId });
  const child = wrapped.fork?.([]);
  assert.ok(child);
  assert.notEqual(child, wrapped);
  await drain(child.stream(request("r1", 9), signal()));
  await drain(wrapped.stream(request("r2", 99), signal()));
  assert.deepEqual(seen.map(item => item.maxOutputTokens), [9, 7]);
  const read = await fx.runtime().read("grant-a");
  assert.ok(read.ok);
  assert.equal(read.snapshot.callsReserved, 2);
  assert.equal(read.snapshot.reportedOutputTokens, 6);
  assert.equal(read.snapshot.reportedInputTokens, 12);
  await assert.rejects(drain(wrapped.stream(request("r1", 9), signal())), /learning_grant_conflict/);
  assert.equal(seen.length, 2);
});

test("normal consumer returning after finish records reported usage rather than false unknown", async t => {
  const fx = fixture(t), runtime = fx.runtime();
  await opened(runtime);
  const wrapped = withSkillLearningGrant(provider([usage(4, 3), finish]), { runtime, grantId: "grant-a", reservationIdFactory: req => req.attemptId });
  for await (const event of wrapped.stream(request(), signal())) if (event.type === "finish") break;
  const read = await fx.runtime().read("grant-a");
  assert.ok(read.ok);
  assert.equal(read.snapshot.status, "open");
  assert.equal(read.snapshot.reportedOutputTokens, 3);
});

test("unknown usage freezes the same grant across restart; a new explicit grant can proceed", async t => {
  const fx = fixture(t), runtime = fx.runtime();
  await opened(runtime);
  const seen: ProviderRequest[] = [];
  const wrapped = withSkillLearningGrant(provider([finish], seen), { runtime, grantId: "grant-a", reservationIdFactory: req => req.attemptId });
  await drain(wrapped.stream(request(), signal()));
  const frozen = await fx.runtime().read("grant-a");
  assert.ok(frozen.ok);
  assert.equal(frozen.snapshot.status, "unknown");
  assert.equal(frozen.snapshot.reservations[0]?.state, "unknown");
  await assert.rejects(drain(wrapped.stream(request("r2"), signal())), /learning_grant_unsettled/);
  assert.equal(seen.length, 1);
  assert.ok((await fx.runtime().open({ ...allowance, grantId: "grant-b", sourceRef: "skill-command:explicit-new-id" })).ok);
  const fresh = withSkillLearningGrant(provider([usage(1, 1), finish], seen), { runtime: fx.runtime(), grantId: "grant-b", reservationIdFactory: req => req.attemptId });
  await drain(fresh.stream(request(), signal()));
  assert.equal(seen.length, 2);
});

test("abort before reserve is free; abort after reserve records unknown even when transport ignores abort", async t => {
  const fx = fixture(t), runtime = fx.runtime();
  await opened(runtime);
  const seen: ProviderRequest[] = [];
  const waiting: ProviderPort = { async *stream(input) {
    seen.push(input);
    yield usage(1, 1);
    await new Promise<void>(() => {});
  } };
  const wrapped = withSkillLearningGrant(waiting, { runtime, grantId: "grant-a", reservationIdFactory: req => req.attemptId });
  const pre = new AbortController();
  pre.abort();
  await assert.rejects(drain(wrapped.stream(request(), pre.signal)), /learning_aborted/);
  assert.equal(seen.length, 0);
  const controller = new AbortController(), iterator = wrapped.stream(request(), controller.signal)[Symbol.asyncIterator]();

  assert.equal((await iterator.next()).value?.type, "usage");
  controller.abort();

  // The listener starts the durable settlement without waiting for iterator return.
  for (let index = 0; index < 20; index += 1) {
    const current = await runtime.read("grant-a");
    if (current.ok && current.snapshot.status === "unknown") break;
    await new Promise<void>(resolve => setImmediate(resolve));
  }

  const frozen = await fx.runtime().read("grant-a");
  assert.ok(frozen.ok);
  assert.equal(frozen.snapshot.status, "unknown");
  assert.equal(frozen.snapshot.callsReserved, 1);
});

test("observed overrun is preserved and further calls never reach the provider", async t => {
  const fx = fixture(t), runtime = fx.runtime();
  await opened(runtime);
  const seen: ProviderRequest[] = [];
  const wrapped = withSkillLearningGrant(provider([usage(2, 9), finish], seen), { runtime, grantId: "grant-a", reservationIdFactory: req => req.attemptId });
  await assert.rejects(drain(wrapped.stream(request("r1", 3), signal())), /learning_grant_exhausted/);
  const frozen = await fx.runtime().read("grant-a");
  assert.ok(frozen.ok);
  assert.equal(frozen.snapshot.status, "overrun");
  assert.equal(frozen.snapshot.reportedOutputTokens, 9);
  assert.equal(frozen.snapshot.reservations[0]?.state, "reported");
  await assert.rejects(drain(wrapped.stream(request("r2"), signal())), /learning_grant_exhausted/);
  assert.equal(seen.length, 1);
});

test("two runtimes racing on one reservation receive one durable admission and one provider call", async t => {
  const fx = fixture(t);
  await opened(fx.runtime());
  let arrived = 0;
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  let tail = Promise.resolve(), replayed = 0;
  const board: BoardStore = { ...fx.board,

    async load() {
      const loaded = await fx.board.load();
      arrived += 1;
      if (arrived <= 2) {
      if (arrived === 2) release();
      await barrier;
    }
      return loaded;
    },

    async apply(command) {
      // Both callers observed the old state. Admit the second real Board write
      // after the first writer releases its lock, exercising canonical replay.
      const previous = tail;
      let finishWrite!: () => void;
      tail = new Promise<void>(resolve => { finishWrite = resolve; });
      await previous;
      try {
        const result = await fx.board.apply(command);
        if (result.ok && result.idempotent) replayed += 1;
        return result;
      }
      finally { finishWrite(); }
    },
  };
  const seen: ProviderRequest[] = [], make = () => withSkillLearningGrant(provider([usage(1, 1), finish], seen), {
    runtime: createSkillLearningGrant({ board, workspaceId: "workspace-a", now: () => "now" }), grantId: "grant-a", reservationIdFactory: req => req.attemptId });
  const results = await Promise.allSettled([drain(make().stream(request(), signal())), drain(make().stream(request(), signal()))]);

  assert.equal(results.filter(item => item.status === "fulfilled").length, 1);
  assert.equal(seen.length, 1);
  assert.equal(replayed, 1);
});
