import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createDeferredCentralRuntimeDriver } from "./deferred-driver.js";
import { createCentralScopeOwner } from "./owner.js";
import { serveCentralRuntime } from "./server.js";
import { runtimeScopePaths, readRuntimeIntent, type RuntimeIntent } from "./files.js";
import { requestCentralRuntime } from "./transport.js";
import type { CentralRuntimeDriver } from "./contracts.js";

const scope = { homeRoot: "D:/deferred-profile", workspaceRoot: "D:/deferred-workspace", scopeKey: "deferred-scope" };
const tick = async () => { await new Promise<void>(resolve => setImmediate(resolve)); };

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

function initial(): RuntimeIntent {
  return { schemaVersion: 1, homeRoot: scope.homeRoot, workspaceRoot: scope.workspaceRoot, enabled: true,
    configuration: { providerId: "reference-only" }, wakeSequence: 0, consumedSequence: 0, wakeReason: "source", sourceRefs: [] };
}

function fixture(driver: CentralRuntimeDriver) {
  let saved = initial();
  const owner = createCentralScopeOwner({ scope, ownerId: "deferred-owner", intent: saved,
    store: { owns: () => true, writeIntent(value) {
      saved = value as RuntimeIntent;
      return { ok: true };
    } }, driver });
  return { owner, saved: () => saved };
}

test("ready gate precedes initialization, and real root metadata persists without losing concurrent wake facts before actual drive", async () => {
  const ready = gate(), loaded = gate();
  let initializes = 0, drives = 0, closes = 0;
  const expected = initial().configuration, configuration = { ...expected, rootRef: { budgetId: "original-root" } };
  let persist: (value: Readonly<Record<string, unknown>>) => { readonly ok: true } | { readonly ok: false; readonly reason: string } = () => { throw new Error("owner_not_bound"); };
  const driver = createDeferredCentralRuntimeDriver({ readyGate: ready.promise,
    initialize: async () => { initializes++;
    await loaded.promise;
    return { configuration, driver: {
      async drive(input) {
        drives++;
        assert.deepEqual(input.configuration, configuration);
        return { state: "waiting" };
      },
      async close() { closes++; },
    } }; }, persist: value => persist(value) });
  const h = fixture(driver);
  h.owner.start();
  await tick();
  assert.equal(initializes, 0);
  assert.equal(drives, 0);
  assert.equal(h.owner.snapshot().progress?.phase, "initializing");
  persist = value => h.owner.updateConfiguration(value, expected);
  ready.release();
  await tick();
  assert.equal(initializes, 1);
  assert.equal(drives, 0);
  assert.ok(h.owner.wake({ reason: "concurrent_business_source", sourceRefs: ["source:arrived-during-init"] }).ok);
  const sequence = h.saved().wakeSequence;
  loaded.release();
  await tick();
  assert.deepEqual(h.saved().configuration, configuration);
  assert.equal(h.saved().wakeSequence, sequence);
  assert.deepEqual(h.saved().sourceRefs, ["source:arrived-during-init"]);
  assert.equal(h.saved().enabled, true);
  assert.equal(drives, 2);
  assert.equal(initializes, 1);
  assert.equal(h.owner.snapshot().progress?.phase, undefined);
  await h.owner.close();
  assert.equal(closes, 1);
});

test("stop before readiness never initializes and closes without needing the ready gate to open", async () => {
  const ready = gate();
  let initializes = 0, persists = 0;
  const h = fixture(createDeferredCentralRuntimeDriver({ readyGate: ready.promise,
    initialize: async () => {
      initializes++;
      return undefined;
    }, persist: () => {
      persists++;
      return { ok: true };
    } }));
  h.owner.start();
  await tick();
  const stopped = h.owner.requestClose("stop");
  assert.equal(stopped.receipt.ok, true);
  assert.equal(h.saved().enabled, false);
  await stopped.closed;
  assert.equal(initializes, 0);
  assert.equal(persists, 0);
  assert.equal(h.owner.snapshot().state, "stopped");
});

test("stop during initialization acknowledges immediately, preserves disabled intent and cleans the late resource without inference", async () => {
  const loaded = gate();
  let initializes = 0, drives = 0, persists = 0, closes = 0;
  const expected = initial().configuration;
  let persist: (value: Readonly<Record<string, unknown>>) => { readonly ok: true } | { readonly ok: false; readonly reason: string } = () => ({ ok: false, reason: "owner_not_bound" });
  const h = fixture(createDeferredCentralRuntimeDriver({ readyGate: Promise.resolve(),
    initialize: async signal => { initializes++;
    await loaded.promise;
    assert.equal(signal.aborted, true);
    return {
      configuration: { rootRef: "original-root" }, driver: { async drive() {
        drives++;
        return { state: "waiting" };
      }, async close() { closes++; } },
    }; }, persist: value => {
      persists++;
      return persist(value);
    } }));

  persist = value => h.owner.updateConfiguration(value, expected);
  h.owner.start();
  await tick();
  assert.equal(initializes, 1);
  const stopped = h.owner.requestClose("stop");
  assert.equal(stopped.receipt.ok, true);
  assert.equal(closes, 0);
  assert.equal(h.saved().enabled, false);
  loaded.release();
  await stopped.closed;
  assert.equal(persists, 1);
  assert.equal(drives, 0);
  assert.equal(closes, 1);
  assert.equal(h.saved().enabled, false);
  assert.deepEqual(h.saved().configuration, { rootRef: "original-root" });
});

test("metadata write failure closes the initialized resource before reporting failed and never calls the real driver", async () => {
  let drives = 0, closes = 0;
  const h = fixture(createDeferredCentralRuntimeDriver({ readyGate: Promise.resolve(), initialize: async () => ({
    configuration: { rootRef: "actual-returned-root" }, driver: { async drive() {
      drives++;
      return { state: "waiting" };
    }, async close() { closes++; } },
  }), persist: () => ({ ok: false, reason: "runtime_io_failed" }) }));

  h.owner.start();
  await tick();
  assert.equal(h.owner.snapshot().state, "failed");
  assert.equal(h.saved().enabled, true);
  assert.equal(drives, 0);
  assert.equal(closes, 1);
  await tick();
  assert.equal(drives, 0);
  await h.owner.close();
  assert.equal(closes, 1);
});

test("initialization rejection retains failed enabled intent without retry and close still completes", async () => {
  let initializes = 0;
  const h = fixture(createDeferredCentralRuntimeDriver({ readyGate: Promise.resolve(),
    initialize: async () => {
      initializes++;
      throw new Error("runtime_provider_configuration_unavailable");
    },
    persist: () => { throw new Error("No initialized metadata exists."); } }));
  h.owner.start();
  await tick();
  assert.equal(initializes, 1);
  assert.equal(h.owner.snapshot().state, "failed");
  assert.equal(h.saved().enabled, true);
  await tick();
  assert.equal(initializes, 1);
  await h.owner.close();
});

test("the real server returns a controllable initializing locator before semantic readiness and stop needs no initialization", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "trylo-deferred-ready-")), paths = runtimeScopePaths(root, root), ready = gate();
  let initializes = 0;
  const driver = createDeferredCentralRuntimeDriver({ readyGate: ready.promise,
    initialize: async () => {
      initializes++;
      return undefined;
    }, persist: () => ({ ok: true }) });
  const host = await serveCentralRuntime({ paths, configuration: { providerId: "reference-only" }, driver });

  try {
    const status = await requestCentralRuntime(host.address, { operation: "status" });
    assert.equal(status.ok && status.snapshot.progress?.phase, "initializing");
    assert.equal(initializes, 0);
    assert.equal((await requestCentralRuntime(host.address, { operation: "stop" })).ok, true);
    await host.close();
    assert.equal(initializes, 0);
    const saved = readRuntimeIntent(paths);
    assert.equal(saved.ok && saved.value?.enabled, false);
  } finally {
    await host.close();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
    assert.match(path.basename(root), /^trylo-deferred-ready-/);
    rmSync(root, { recursive: true, force: true });
  }
});
