import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { attachCentralRuntime, type CentralRuntimeClient } from "../../adapters/central-learning-runtime/client.js";
import type { CentralRuntimeSnapshot, CentralRuntimeWake } from "../../adapters/central-learning-runtime/contracts.js";
import { createDeferredCentralRuntimeDriver } from "../../adapters/central-learning-runtime/deferred-driver.js";
import { readRuntimeIntent, runtimeScopePaths, tryAcquireRuntimeOwner } from "../../adapters/central-learning-runtime/files.js";
import { serveCentralRuntime } from "../../adapters/central-learning-runtime/server.js";
import { resumeAttachedCentralRuntime } from "./central-runtime-control.js";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

async function waitFor(client: CentralRuntimeClient, predicate: (snapshot: CentralRuntimeSnapshot) => boolean) {
  const signal = AbortSignal.timeout(5000);
  let reply = await client.status(signal);
  assert.ok(reply.ok, JSON.stringify(reply));
  while (!predicate(reply.snapshot)) {
    reply = await client.wait(reply.snapshot.revision, signal);
    assert.ok(reply.ok, JSON.stringify(reply));
  }
  return reply;
}

async function fixture(t: TestContext, input: { readonly pending?: true; readonly rejectInitialization?: true } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "trylo-runtime-resume-"));
  const home = path.join(root, "home"), workspace = path.join(root, "workspace");
  mkdirSync(home);
  mkdirSync(workspace);
  const paths = runtimeScopePaths(home, workspace), configuration = { providerId: "fixture-reference" };
  const initializing = gate(), metadata = gate(), heldDrive = gate(), first = gate(), second = gate();
  const drives: CentralRuntimeWake[] = [], clients: CentralRuntimeClient[] = [];
  let host: Awaited<ReturnType<typeof serveCentralRuntime>> | undefined;

  t.after(async () => {
    metadata.release();
    heldDrive.release();

    try { await host?.close("stop"); }
    finally {
      for (const client of clients) client.detach();
      assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
      assert.match(path.basename(root), /^trylo-runtime-resume-/u);
      rmSync(root, { recursive: true, force: true });
    }
  });
  const seed = tryAcquireRuntimeOwner(paths);
  assert.ok(seed.ok, JSON.stringify(seed));

  try {
    assert.ok(seed.value.writeIntent({ schemaVersion: 1, homeRoot: paths.homeRoot, workspaceRoot: paths.workspaceRoot,
      configuration, enabled: true, wakeSequence: input.pending ? 20 : 19, consumedSequence: 19,
      wakeReason: input.pending ? "normal_task_source_committed" : "last_consumed_source",
      sourceRefs: input.pending ? ["source:original_pending"] : [] }).ok);
  } finally { seed.value.close(); }

  const driver = createDeferredCentralRuntimeDriver({ readyGate: Promise.resolve(),

    async initialize() {
      initializing.release();
      await metadata.promise;

      if (input.rejectInitialization) throw new Error("runtime_configuration_invalid");

      return { configuration, driver: {
        async drive(run) {
          drives.push(structuredClone(run.wake));
          if (drives.length === 1) first.release();else if (drives.length === 2) second.release();
          await heldDrive.promise;
          return { state: "waiting" as const, reason: "fixture_waiting_for_source" };
        },
      } };
    },

    persist(value) {
      assert.ok(host);
      return host.owner.updateConfiguration(value, configuration);
    },
  });

  host = await serveCentralRuntime({ paths, configuration, driver });
  await initializing.promise;
  const attach = async () => {
    const result = await attachCentralRuntime({ homeRoot: home, workspaceRoot: workspace, configuration }, {
      executable: "must-not-launch-a-second-owner", entrypoint: "must-not-launch", environment: {},
    });
    assert.ok(result.ok, JSON.stringify(result));
    assert.equal(result.ownerSource, "existing");
    assert.equal(result.client.ownerId, host!.owner.snapshot().ownerId);
    clients.push(result.client);
    return result;
  };

  return { paths, metadata, heldDrive, first, second, drives, attach };
}

test("cold resume adopts one accepted recovery wake while initialization and semantic work remain held; online resume still wakes", { timeout: 10000 }, async t => {
  const f = await fixture(t), attached = await f.attach();
  assert.ok(attached.initial.ok);
  assert.equal(attached.initial.snapshot.progress?.phase, "initializing");
  const accepted = await resumeAttachedCentralRuntime({ ...attached, ownerSource: "launched" });

  assert.equal(accepted, attached.initial, "acceptance uses the original receipt without waiting for future initialization or work");
  assert.ok(accepted.ok);
  assert.equal(accepted.snapshot.wakeSequence, 20);
  assert.equal(accepted.snapshot.consumedSequence, 19);
  assert.equal(f.drives.length, 0);
  f.metadata.release();
  await f.first.promise;
  const ready = await attached.client.status();
  assert.ok(ready.ok);
  assert.equal(ready.snapshot.progress?.phase, undefined);
  assert.equal(ready.snapshot.state, "running");
  assert.equal(ready.snapshot.wakeSequence, 20);
  assert.equal(ready.snapshot.consumedSequence, 19);
  assert.equal(f.drives[0]!.reason, "owner_recovery");
  const existing = await f.attach(), resumed = await resumeAttachedCentralRuntime(existing);
  assert.ok(resumed.ok);
  assert.equal(resumed.snapshot.wakeSequence, 21);
  assert.equal(resumed.snapshot.consumedSequence, 19);
  f.heldDrive.release();
  await f.second.promise;
  await waitFor(existing.client, snapshot => snapshot.state === "waiting" && snapshot.consumedSequence === 21);
  assert.equal(f.drives.length, 2);
  assert.deepEqual(f.drives[1], { reason: "explicit_runtime_resume", sourceRefs: [] });
});

test("startup preserves the original pending wake and a concurrent real source reaches the next drive without an added recovery wake", { timeout: 10000 }, async t => {
  const f = await fixture(t, { pending: true }), attached = await f.attach();
  const accepted = await resumeAttachedCentralRuntime({ ...attached, ownerSource: "launched" });
  assert.ok(accepted.ok);
  assert.equal(accepted.snapshot.wakeSequence, 20);
  assert.equal(accepted.snapshot.consumedSequence, 19);
  f.metadata.release();
  await f.first.promise;
  assert.deepEqual(f.drives[0], { reason: "normal_task_source_committed", sourceRefs: ["source:original_pending"] });
  const source = { reason: "normal_task_source_committed", sourceRefs: ["source:concurrent_business"] };
  const received = await attached.client.wake(source);
  assert.ok(received.ok);
  assert.equal(received.snapshot.wakeSequence, 21);
  assert.equal(f.drives.length, 1, "the in-flight original drive is preserved");
  f.heldDrive.release();
  await f.second.promise;
  await waitFor(attached.client, snapshot => snapshot.state === "waiting" && snapshot.consumedSequence === 21);
  assert.equal(f.drives.length, 2);
  assert.deepEqual(f.drives[1], source);
  const saved = readRuntimeIntent(f.paths);
  assert.ok(saved.ok && saved.value);
  assert.equal(saved.value.wakeSequence, 21);
  assert.equal(saved.value.consumedSequence, 21);
  assert.deepEqual(saved.value.sourceRefs, source.sourceRefs);
});

test("an already failed initialization receipt and a real stopping receipt cannot be acknowledged as a successful cold resume", { timeout: 10000 }, async t => {
  const f = await fixture(t, { rejectInitialization: true }), attached = await f.attach();

  f.metadata.release();
  const failed = await waitFor(attached.client, snapshot => snapshot.state === "failed");
  assert.ok(failed.ok);
  const result = await resumeAttachedCentralRuntime({ ...attached, initial: failed, ownerSource: "launched" });

  assert.deepEqual(result, { ok: false, reason: "runtime_drive_failed" });
  assert.equal(f.drives.length, 0);
  const saved = readRuntimeIntent(f.paths);
  assert.ok(saved.ok && saved.value);
  assert.equal(saved.value.wakeSequence, 20);
  assert.equal(saved.value.consumedSequence, 19);
  const stopped = await attached.client.stop();
  assert.ok(stopped.ok);
  assert.deepEqual(await resumeAttachedCentralRuntime({ ...attached, initial: stopped, ownerSource: "launched" }), { ok: false, reason: "runtime_stopping" });
});
