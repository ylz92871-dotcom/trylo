import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { serveCentralRuntime } from "./server.js";
import { runtimeScopePaths, readRuntimeIntent, tryAcquireRuntimeOwner, isRuntimeIntent } from "./files.js";
import { requestCentralRuntime } from "./transport.js";

test("server bootstrap retains the saved native workspace spelling when the caller uses another case", { skip: path.sep !== "\\" }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "trylo-central-case-")), native = root.toUpperCase();
  const paths = runtimeScopePaths(root, root.toLowerCase()), acquired = tryAcquireRuntimeOwner(paths);
  assert.ok(acquired.ok);

  try { assert.ok(acquired.value.writeIntent({ schemaVersion: 1, homeRoot: paths.homeRoot, workspaceRoot: native,
    enabled: true, configuration: {}, wakeSequence: 0, consumedSequence: 0, wakeReason: "original", sourceRefs: [] }).ok); }
  finally { acquired.value.close(); }

  const host = await serveCentralRuntime({ paths, configuration: {}, driver: { async drive() { return { state: "waiting" }; } } });

  try {
    const saved = readRuntimeIntent(paths);
    assert.ok(saved.ok);
    assert.equal(saved.value?.workspaceRoot, native);
  } finally {
    await host.close();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
    assert.match(path.basename(root), /^trylo-central-case-/);
    rmSync(root, { recursive: true, force: true });
  }
});

test("direct server close retains a later stop while sharing an already started restart cleanup", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "trylo-central-close-upgrade-")), paths = runtimeScopePaths(root, root);
  let release!: () => void, entered!: () => void;
  const running = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  const host = await serveCentralRuntime({ paths, configuration: {}, driver: {
    async drive() {
      entered();
      await running;
      return { state: "waiting" };
    } } });

  await started;
  const restarting = host.close("restart"), stopping = host.close("stop");

  try {
    const saved = readRuntimeIntent(paths);
    assert.equal(saved.ok && saved.value?.enabled, false);
  } finally {
    release();
    await Promise.all([restarting, stopping]);
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
    assert.match(path.basename(root), /^trylo-central-close-upgrade-/);
    rmSync(root, { recursive: true, force: true });
  }
});

test("HTTP stop overrides a prior privacy pause before the original driver finishes draining", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "trylo-central-stop-upgrade-")), paths = runtimeScopePaths(root, root);
  let release!: () => void, entered!: () => void;
  const running = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  const host = await serveCentralRuntime({ paths, configuration: {}, driver: {
    async drive() {
      entered();
      await running;
      return { state: "waiting" };
    } } });

  try {
    await started;
    assert.equal((await requestCentralRuntime(host.address, { operation: "stop", mode: "pause" })).ok, true);
    const stopped = await requestCentralRuntime(host.address, { operation: "stop", mode: "stop" });
    assert.equal(stopped.ok, true);
    assert.equal(host.owner.snapshot().state, "stopping");
    const saved = readRuntimeIntent(paths);
    assert.equal(saved.ok && saved.value?.enabled, false);
  } finally {
    release();
    await host.close();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
    assert.match(path.basename(root), /^trylo-central-stop-upgrade-/);
    rmSync(root, { recursive: true, force: true });
  }
});

test("HTTP stop reports durable write failure immediately while still cancelling and draining the original driver", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "trylo-central-stop-failed-")), paths = runtimeScopePaths(root, root);
  const acquired = tryAcquireRuntimeOwner(paths);
  assert.ok(acquired.ok);
  let release!: () => void, entered!: () => void, closed = false;
  const running = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  const host = await serveCentralRuntime({ paths, configuration: {}, owner: { ...acquired.value,
    writeIntent(value) {
      return isRuntimeIntent(value) && !value.enabled ? { ok: false, reason: "runtime_io_failed", detail: "Injected stop publication failure" }
        : acquired.value.writeIntent(value);
    } }, driver: {
    async drive(input) {
      entered();
      await running;
      assert.equal(input.signal.aborted, true);
      return { state: "waiting" };
    },
    async close() { closed = true; } } });

  try {
    await started;
    assert.deepEqual(await requestCentralRuntime(host.address, { operation: "stop" }), { ok: false, reason: "runtime_io_failed" });
    assert.equal(closed, false, "the typed failure receipt must not wait for the ongoing driver to drain");
    const saved = readRuntimeIntent(paths);
    assert.equal(saved.ok && saved.value?.enabled, true);
  } finally {
    release();
    await host.close();
    assert.equal(closed, true);
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
    assert.match(path.basename(root), /^trylo-central-stop-failed-/);
    rmSync(root, { recursive: true, force: true });
  }
});

test("RPC wake returns before a domain worker ends; status/wait report progress and client cancellation does not stop driver", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "trylo-central-runtime-"));
  const paths = runtimeScopePaths(root, root);
  let release: (() => void) | undefined, publish: ((value: { message: string; sourceRefs: readonly string[] }) => void) | undefined;
  let started = 0;
  const host = await serveCentralRuntime({ paths, configuration: { providerId: "provider-reference" }, driver: {
    async drive(input) {
      started++;
      publish = input.publish;
      await new Promise<void>(resolve => {
        release = resolve;
        input.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return { state: "waiting" };
    } } });

  try {
    const first = await requestCentralRuntime(host.address, { operation: "status" });

    assert.equal(first.ok, true);
    if (!first.ok) return;

    assert.equal(first.snapshot.state, "running");
    assert.equal(started, 1);
    const wake = await requestCentralRuntime(host.address, { operation: "wake", wake: { reason: "source_committed", sourceRefs: ["session:1"] } });

    assert.equal(wake.ok, true);
    assert.equal(started, 1);
    const waiting = requestCentralRuntime(host.address, { operation: "wait", afterRevision: wake.ok ? wake.snapshot.revision : 0 });

    setImmediate(() => publish!({ message: "Domain result retained", sourceRefs: ["receipt:1"] }));
    const progress = await waiting;
    assert.equal(progress.ok && progress.snapshot.progress?.sourceRefs[0], "receipt:1");
    const cancelled = new AbortController();
    cancelled.abort();
    assert.deepEqual(await requestCentralRuntime(host.address, { operation: "status" }, cancelled.signal), { ok: false, reason: "runtime_client_aborted" });
    assert.equal(host.owner.snapshot().state, "running");
    const denied = await requestCentralRuntime({ ...host.address, token: "wrong-token" }, { operation: "stop" });

    assert.equal(denied.ok, false);
    assert.equal(host.owner.snapshot().state, "running");
    release!();
    await new Promise<void>(resolve => setImmediate(resolve));
  } finally {
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("one home/scope has one owner, restart retains intent, and explicit stop is persistent", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "trylo-central-runtime-owner-"));
  const paths = runtimeScopePaths(root, root);
  const options = { paths, configuration: {}, driver: { async drive() { return { state: "waiting" as const }; } } };
  let host = await serveCentralRuntime(options);

  try {
    await assert.rejects(serveCentralRuntime(options), /runtime_owner_busy/);
    await host.close();
    const intent = readRuntimeIntent(paths);
    assert.equal(intent.ok && intent.value?.enabled, true);
    host = await serveCentralRuntime(options);
    const before = host.owner.snapshot().wakeSequence;

    assert.ok(before > 0);
    const reply = await requestCentralRuntime(host.address, { operation: "stop" });
    assert.equal(reply.ok, true);
    await host.close("stop");
    const stopped = readRuntimeIntent(paths);
    assert.equal(stopped.ok && stopped.value?.enabled, false);
  } finally {
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});
