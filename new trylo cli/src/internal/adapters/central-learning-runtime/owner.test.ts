import test from "node:test";
import assert from "node:assert/strict";
import { createCentralScopeOwner } from "./owner.js";
import type { RuntimeIntent } from "./files.js";
import { isRuntimeConfiguration } from "./contracts.js";
import { runtimeScopePaths } from "./files.js";
import path from "node:path";

const scope = { homeRoot: "D:/profile", workspaceRoot: "D:/workspace", scopeKey: "scope-identity" };

function initial(): RuntimeIntent {
  return { schemaVersion: 1, homeRoot: scope.homeRoot, workspaceRoot: scope.workspaceRoot, enabled: true,
    configuration: {}, wakeSequence: 0, consumedSequence: 0, wakeReason: "start", sourceRefs: [] };
}

const tick = async () => { await new Promise<void>(resolve => setImmediate(resolve)); };

test("coalesced lifecycle wakes retain pending advisory feedback through owner restart", async () => {
  let saved = initial(), resumed: ReturnType<typeof createCentralScopeOwner> | undefined;
  const feedback = ["organization-record:adoption-one", "organization-record:adoption-two"];
  const store = { owns: () => true, writeIntent(value: unknown) {
    saved = value as RuntimeIntent;
    return { ok: true as const };
  } };
  const owner = createCentralScopeOwner({ scope, ownerId: "busy-owner", intent: saved, store,
    driver: { async drive({ signal }) {
      await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
      return { state: "waiting" };
    } } });

  try {
    owner.wake({ reason: "ordinary_task_started", sourceRefs: [] });
    await tick();
    owner.wake({ reason: "actual_advisory_feedback", sourceRefs: [feedback[0]!] });
    owner.wake({ reason: "actual_advisory_feedback", sourceRefs: [feedback[1]!, feedback[0]!] });
    owner.wake({ reason: "ordinary_task_finished", sourceRefs: [] });
    assert.deepEqual(saved.sourceRefs, feedback, "an empty lifecycle wake cannot erase accepted, unconsumed feedback");
    await owner.close("restart");
    const batches: string[][] = [];

    resumed = createCentralScopeOwner({ scope, ownerId: "recovered-owner", intent: saved, store,
      driver: { async drive({ wake }) {
        batches.push([...wake.sourceRefs]);
        return { state: "waiting" };
      } } });
    resumed.start();
    await tick();
    assert.deepEqual(batches, [feedback]);
    assert.equal(saved.consumedSequence, saved.wakeSequence);
    resumed.wake({ reason: "later_independent_task", sourceRefs: ["source:new-task"] });
    await tick();
    assert.deepEqual(batches[1], ["source:new-task"], "a fully consumed batch must not accumulate into later wakes");
  } finally {
    await owner.close("restart");
    await resumed?.close("restart");
  }
});

test("coalescing refuses overflow of the existing wake contract without losing pending references", async () => {
  let saved: RuntimeIntent = { ...initial(), wakeSequence: 1, sourceRefs: Array.from({ length: 32 }, (_, i) => `source:${i}`) };
  const before = saved;
  const owner = createCentralScopeOwner({ scope, ownerId: "pending-owner", intent: saved,
    store: { owns: () => true, writeIntent(value) {
      saved = value as RuntimeIntent;
      return { ok: true };
    } },
    driver: { async drive() { return { state: "waiting" }; } } });

  try {
    assert.deepEqual(owner.wake({ reason: "additional_source", sourceRefs: ["source:additional"] }),
      { ok: false, reason: "runtime_wake_source_refs_capacity" });
    assert.equal(saved, before, "a refused batch cannot acknowledge or overwrite any original wake");
  } finally { await owner.close("restart"); }
});

test("verified startup root repairs only this folded key while preserving a newer stop and wake", { skip: path.sep !== "\\" }, async () => {
  const actual = runtimeScopePaths("D:\\Profile", "d:\\workspace"), native = "D:\\Workspace";
  let saved: RuntimeIntent = { ...initial(), homeRoot: actual.homeRoot, workspaceRoot: actual.workspaceRoot };
  const expected = saved.configuration;
  let release!: () => void;
  const running = new Promise<void>(resolve => { release = resolve; });
  const owner = createCentralScopeOwner({ scope: actual, ownerId: "verified-root-owner", intent: saved,
    store: { owns: () => true, writeIntent(value) {
      saved = value as RuntimeIntent;
      return { ok: true };
    } },
    driver: { async drive() {
      await running;
      return { state: "waiting" };
    } } });

  owner.wake({ reason: "new_source", sourceRefs: ["source:latest"] });
  await tick();
  const stopped = owner.requestClose("stop"), before = saved;

  try {
    assert.deepEqual(owner.updateConfiguration({ rootRef: "actual-root" }, expected, "D:\\OtherWorkspace"),
      { ok: false, reason: "runtime_scope_mismatch" });
    assert.equal(saved, before, "a different runtime key must not change any metadata");
    assert.ok(owner.updateConfiguration({ rootRef: "actual-root" }, expected, native).ok);
    assert.equal(saved.workspaceRoot, native);
    assert.equal(saved.enabled, false);
    assert.equal(saved.wakeSequence, before.wakeSequence);
    assert.equal(saved.wakeReason, "new_source");
    assert.deepEqual(saved.sourceRefs, ["source:latest"]);
  } finally {
    release();
    await stopped.closed;
  }
});

test("startup metadata updates preserve latest wake facts, reject hot configuration handoffs and cannot revive stop", async () => {
  let saved = initial();
  const expected = saved.configuration;
  const owner = createCentralScopeOwner({ scope, ownerId: "metadata-owner", intent: saved,
    store: { owns: () => true, writeIntent(value) {
      saved = value as RuntimeIntent;
      return { ok: true };
    } },
    driver: { async drive() { return { state: "waiting" }; } } });

  assert.deepEqual(owner.wake({ reason: "unsupported_hot_change", sourceRefs: [] }, { model: "other" }),
    { ok: false, reason: "runtime_configuration_handoff_required" });
  assert.equal(saved.wakeSequence, 0);
  owner.wake({ reason: "business_source", sourceRefs: ["source:latest"] });
  const sequence = saved.wakeSequence;

  assert.ok(owner.updateConfiguration({ rootRef: "actual-root" }, expected).ok);
  assert.equal(saved.wakeSequence, sequence);
  assert.deepEqual(saved.sourceRefs, ["source:latest"]);
  assert.deepEqual(owner.updateConfiguration({ invalid: () => {} }, saved.configuration), { ok: false, reason: "runtime_configuration_invalid" });
  assert.deepEqual(owner.updateConfiguration({ rootRef: "stale" }, expected), { ok: false, reason: "runtime_configuration_changed" });
  await owner.close("stop");
  assert.deepEqual(owner.updateConfiguration({ rootRef: "late" }, saved.configuration), { ok: false, reason: "runtime_stopping" });
  assert.equal(saved.enabled, false);
  assert.deepEqual(saved.configuration, { rootRef: "actual-root" });
});

test("explicit stop upgrades an already draining pause and all close callers retain one driver drain", async () => {
  let saved = initial(), release!: () => void, closes = 0;
  const running = new Promise<void>(resolve => { release = resolve; });
  const owner = createCentralScopeOwner({ scope, ownerId: "pause-stop-owner", intent: saved,
    store: { owns: () => true, writeIntent(value) {
      saved = value as RuntimeIntent;
      return { ok: true };
    } },
    driver: { async drive() {
      await running;
      return { state: "waiting" };
    }, async close() { closes++; } } });

  owner.start();
  await tick();
  const paused = owner.close("restart"), stopped = owner.close("stop");

  try {
    assert.equal(saved.enabled, false, "a later explicit stop must persist even while the original pause is draining");
    assert.equal(closes, 0);
  } finally {
    release();
    await Promise.all([paused, stopped]);
  }

  assert.equal(closes, 1);
  assert.equal(owner.snapshot().state, "stopped");
});

test("compatibility close rejects an unpersisted stop after completing the shared drain", async () => {
  let saved = initial(), closes = 0;
  const owner = createCentralScopeOwner({ scope, ownerId: "write-failed-owner", intent: saved,
    store: { owns: () => true, writeIntent(value) {
      const next = value as RuntimeIntent;
      if (!next.enabled) return { ok: false, reason: "runtime_io_failed" };
      saved = next;
      return { ok: true };
    } }, driver: { async drive() { return { state: "waiting" }; }, async close() { closes++; } } });

  await assert.rejects(owner.close("stop"), /runtime_io_failed/);
  assert.equal(saved.enabled, true);
  assert.equal(closes, 1);
});

test("wake acknowledges durable acceptance while the independent driver is still running; concurrent wakes serialize", async () => {
  let saved = initial(), calls = 0, running = 0, maximum = 0;
  const releases: (() => void)[] = [];
  const owner = createCentralScopeOwner({ scope, ownerId: "owner-identity", intent: saved,
    store: { owns: () => true, writeIntent(value) {
      saved = value as RuntimeIntent;
      return { ok: true };
    } },
    driver: { async drive() {
      calls++;
      running++;
      maximum = Math.max(maximum, running);
      await new Promise<void>(resolve => releases.push(resolve));
      running--;
      return { state: "waiting" };
    } } });

  assert.equal(owner.wake({ reason: "source_committed", sourceRefs: ["source:1"] }).ok, true);
  assert.equal(saved.wakeSequence, 1);
  await tick();
  assert.equal(calls, 1);
  assert.equal(owner.snapshot().state, "running");
  owner.wake({ reason: "worker_result", sourceRefs: ["result:2"] });
  await tick();
  assert.equal(calls, 1);
  releases.shift()!();
  await tick();
  assert.equal(calls, 2);
  releases.shift()!();
  await tick();
  assert.equal(maximum, 1);
  assert.equal(saved.consumedSequence, saved.wakeSequence);
  await tick();
  assert.equal(calls, 2);
  await owner.close();
  assert.equal(saved.enabled, true);
});

test("restart drives persisted intent, explicit stop disables it, and failed drive keeps unconsumed wake without retry", async () => {
  let saved = { ...initial(), wakeSequence: 7, consumedSequence: 7 }, calls = 0;
  const owner = createCentralScopeOwner({ scope, ownerId: "recovered-owner", intent: saved,
    store: { owns: () => true, writeIntent(value) {
      saved = value as RuntimeIntent;
      return { ok: true };
    } },
    driver: { async drive() {
      calls++;
      throw new Error("injected transport failure");
    } } });

  owner.start();
  await tick();
  assert.equal(calls, 1);
  assert.equal(saved.wakeSequence, 8);
  assert.equal(saved.consumedSequence, 7);
  assert.equal(owner.snapshot().state, "failed");
  await tick();
  assert.equal(calls, 1);
  await owner.close("stop");
  assert.equal(saved.enabled, false);
});

test("configuration persistence rejects non-JSON objects and serialization transformations", () => {
  assert.equal(isRuntimeConfiguration({ selection: "provider-ref", allowance: { calls: 2 }, refs: [] }), true);
  assert.equal(isRuntimeConfiguration({ value: new Date() }), false);
  assert.equal(isRuntimeConfiguration({ value: new Map() }), false);
  assert.equal(isRuntimeConfiguration({ value: new Array(2) }), false);
  assert.equal(isRuntimeConfiguration({ toJSON() { return {}; } }), false);
  assert.equal(isRuntimeConfiguration(Object.defineProperty({}, "credential", { enumerable: true, get: () => "secret" })), false);
});

test("only a real worker ready return or exact until timer resumes waiting; diagnostics do not spin", async () => {
  let saved = initial(), clock = 0, calls = 0;
  let publish: Parameters<Parameters<typeof createCentralScopeOwner>[0]["driver"]["drive"]>[0]["publish"] | undefined;
  const timers: { run: () => void; ms: number; cancelled: boolean }[] = [];
  const owner = createCentralScopeOwner({ scope, ownerId: "scheduled-owner", intent: saved, now: () => clock,
    schedule(run, ms) {
      const timer = { run, ms, cancelled: false };
      timers.push(timer);
      return () => { timer.cancelled = true; };
    },
    store: { owns: () => true, writeIntent(value) {
      saved = value as RuntimeIntent;
      return { ok: true };
    } },
    driver: { async drive(input) { publish = input.publish;
    calls++;
      return calls === 1 ? { state: "waiting", wakeAt: 100, sourceRefs: ["wait:original"] } : { state: "waiting" };
    } } });

  owner.start();
  await tick();
  assert.equal(calls, 1);
  assert.equal(timers[0]?.ms, 100);
  publish!({ message: "diagnostic only", sourceRefs: [] });
  await tick();
  assert.equal(calls, 1);
  clock = 99;
  timers[0]!.run();
  await tick();
  assert.equal(calls, 1);
  assert.equal(timers[1]?.ms, 1);
  clock = 100;
  timers[1]!.run();
  await tick();
  assert.equal(calls, 2);
  publish!({ state: "ready", message: "original domain worker returned", sourceRefs: ["worker:result"] });
  await tick();
  assert.equal(calls, 3);
  assert.equal(saved.sourceRefs[0], "worker:result");
  await owner.close();
});
