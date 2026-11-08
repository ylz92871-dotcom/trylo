import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createDeferredCentralRuntimeDriver } from "./deferred-driver.js";
import { initializeCentralRuntimeWorker, type CentralRuntimeWorkerDriver } from "./worker-driver.js";
import { readRuntimeIntent, readRuntimeLocator, runtimeScopePaths, tryAcquireRuntimeOwner } from "./files.js";
import { serveCentralRuntime } from "./server.js";
import { requestCentralRuntime } from "./transport.js";

const cases = [
  { mode: "drive-known", stage: "drive", code: "organization_sensitive_content", drives: 1 },
  { mode: "drive-private", stage: "drive", code: "unclassified", drives: 1 },
  { mode: "initialization-known", stage: "initialization", code: "organization_sensitive_content", drives: 0 },
  { mode: "transport-exit", stage: "transport", code: "runtime_worker_closed", drives: 1 },
] as const;

for (const row of cases) test(`actual worker failure ${row.mode} reaches original file owner status without consuming or replaying its wake`, async t => {
  const root = mkdtempSync(path.join(tmpdir(), "trylo-worker-failure-")), paths = runtimeScopePaths(root, root);
  const diagnostics: string[] = [], configuration = { providerId: "fixture-reference", fixtureFailure: row.mode };
  let lateReady!: () => void;
  const latePublished = new Promise<void>(resolve => { lateReady = resolve; });
  let release!: () => void;
  const readyGate = new Promise<void>(resolve => { release = resolve; });
  let carrier: CentralRuntimeWorkerDriver | undefined;
  const driver = createDeferredCentralRuntimeDriver({ readyGate,
    initialize: async signal => carrier = await initializeCentralRuntimeWorker({ homeRoot: root, workspaceRoot: root, configuration,
      entrypoint: new URL("./worker-fixture.test.js", import.meta.url), diagnostic: text => {
        diagnostics.push(text);
        if (text.includes("fixture_late_failure_progress")) lateReady();
      } }, signal),
    persist(value) {
      assert.ok(carrier);
      const saved = host.owner.updateConfiguration(value, configuration, carrier.workspaceRoot);
      if (saved.ok) carrier.acknowledgeMetadata();
      return saved;
    },
  });
  const host = await serveCentralRuntime({ paths, configuration, driver });

  t.after(async () => {
    try {
      if (row.mode === "transport-exit") await assert.rejects(host.close("stop"), /runtime_worker_close_unconfirmed/);
      else await host.close("stop");
      const locator = readRuntimeLocator(paths);
      assert.ok(locator.ok);
      assert.equal(locator.value, undefined);
      const lease = tryAcquireRuntimeOwner(paths);
      assert.ok(lease.ok, JSON.stringify(lease));
      lease.value.close();
    } finally {
      assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
      assert.match(path.basename(root), /^trylo-worker-failure-/);
      rmSync(root, { recursive: true, force: true });
    }
  });
  const deadline = AbortSignal.timeout(10000);
  const pending = await requestCentralRuntime(host.address, { operation: "wake", wake: { reason: "actual_pending_source", sourceRefs: ["source:pending"] } }, deadline);

  assert.ok(pending.ok);
  release();
  let status = await requestCentralRuntime(host.address, { operation: "status" }, deadline);

  while (status.ok && status.snapshot.state !== "failed") {
    status = await requestCentralRuntime(host.address, { operation: "wait", afterRevision: status.snapshot.revision }, deadline);
  }

  assert.ok(status.ok, JSON.stringify(status));

  if (row.mode === "drive-known") {
    await Promise.race([latePublished, new Promise<void>((_, reject) => deadline.addEventListener("abort", () => reject(new Error("fixture_late_progress_missing")), { once: true }))]);
    await new Promise<void>(resolve => setImmediate(resolve));
  }

  assert.equal(status.snapshot.reason, "runtime_drive_failed", "the original public failure reason remains compatible");
  assert.deepEqual(Object.getOwnPropertyDescriptor(status.snapshot, "failure")?.value, { stage: row.stage, code: row.code });
  assert.equal(status.snapshot.progress, undefined, "an old successful or initializing progress cannot survive failed state");
  assert.equal(JSON.stringify(status).includes("fixture-secret"), false);
  assert.equal(JSON.stringify(status).includes("/private/"), false);
  const saved = readRuntimeIntent(paths);
  assert.ok(saved.ok && saved.value);
  assert.equal(saved.value.enabled, true);
  assert.equal(saved.value.consumedSequence, 0);
  assert.ok(saved.value.wakeSequence >= 2);
  assert.deepEqual(saved.value.sourceRefs, ["source:pending"]);
  const another = await requestCentralRuntime(host.address, { operation: "status" }, deadline);
  assert.deepEqual(another, status);
  assert.equal(diagnostics.join("").split("fixture_actual_drive").length - 1, row.drives);
  const held = tryAcquireRuntimeOwner(paths);
  assert.ok(!held.ok);
  assert.equal(held.reason, "runtime_owner_busy");
});
