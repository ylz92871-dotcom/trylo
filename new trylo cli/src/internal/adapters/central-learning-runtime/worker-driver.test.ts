import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeCentralRuntimeWorker, type CentralRuntimeWorkerDriver } from "./worker-driver.js";
import { createDeferredCentralRuntimeDriver } from "./deferred-driver.js";
import { createCentralScopeOwner } from "./owner.js";
import { runtimeScopePaths, type RuntimeIntent } from "./files.js";

const entrypoint = new URL("./worker-fixture.test.js", import.meta.url);

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "trylo-worker-carrier-")), scope = runtimeScopePaths(root, root);
  const diagnostics: string[] = [];

  return { scope, diagnostics, options: { homeRoot: root, workspaceRoot: root, configuration: { providerId: "fixture-reference" },
    entrypoint, diagnostic: (text: string) => diagnostics.push(text) },
  close() {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
    assert.match(path.basename(root), /^trylo-worker-carrier-/);
    rmSync(root, { recursive: true, force: true });
  } };
}

test("thread carrier requires metadata ACK before actual drive and pipes both worker output channels as diagnostics", async () => {
  const f = fixture(), cancel = new AbortController();
  const carrier = await initializeCentralRuntimeWorker(f.options, cancel.signal);
  assert.ok(carrier);

  try {
    const progress: string[] = [];
    const input = { scope: f.scope, configuration: carrier.configuration, wake: { reason: "actual_source", sourceRefs: [] }, signal: cancel.signal,
      publish: (value: { readonly message: string }) => { progress.push(value.message); } };

    await assert.rejects(carrier.driver.drive(input), /runtime_worker_metadata_uncommitted/);
    assert.equal(f.diagnostics.join("").includes("fixture_actual_drive"), false);
    carrier.acknowledgeMetadata();
    assert.equal((await carrier.driver.drive(input)).reason, "actual_fixture_result");
    assert.deepEqual(progress, ["actual_fixture_progress"]);
  } finally {
    await carrier.driver.close?.();
    f.close();
  }

  const diagnostics = f.diagnostics.join("");

  assert.match(diagnostics, /fixture_stdout_diagnostic/);
  assert.match(diagnostics, /fixture_stderr_diagnostic/);
  assert.equal(diagnostics.split("fixture_actual_drive").length - 1, 1);
  assert.equal(diagnostics.split("fixture_original_close").length - 1, 1);
});

test("a real stopped thread can still return its constructed root for disabled parent metadata without a late drive", async () => {
  const f = fixture(), native = path.sep === "\\" ? f.scope.workspaceRoot.toUpperCase() : f.scope.workspaceRoot;
  const original = { ...f.options.configuration, fixtureHold: true, fixtureNativeRoot: native };
  let saved: RuntimeIntent = { schemaVersion: 1, homeRoot: f.scope.homeRoot, workspaceRoot: f.scope.workspaceRoot,
    enabled: true, configuration: original, wakeSequence: 0, consumedSequence: 0, wakeReason: "source", sourceRefs: [] };
  let carrier: CentralRuntimeWorkerDriver | undefined, started!: () => void;
  const initializing = new Promise<void>(resolve => { started = resolve; });
  const driver = createDeferredCentralRuntimeDriver({ readyGate: Promise.resolve(),
    initialize: async signal => carrier = await initializeCentralRuntimeWorker({ ...f.options, configuration: original,
      diagnostic: text => {
        f.diagnostics.push(text);
        if (text.includes("fixture_initializing")) started();
      } }, signal),
    persist(value) {
      const result = owner.updateConfiguration(value, original, carrier!.workspaceRoot);
      if (result.ok) carrier!.acknowledgeMetadata();
      return result;
    } });
  const owner = createCentralScopeOwner({ scope: f.scope, ownerId: "parent-only-owner", intent: saved,
    store: { owns: () => true, writeIntent(value) {
      saved = value as RuntimeIntent;
      return { ok: true };
    } }, driver });

  try {
    owner.start();
    await initializing;
    const stopped = owner.requestClose("stop");
    assert.equal(stopped.receipt.ok, true);
    assert.equal(saved.enabled, false);
    await stopped.closed;
    assert.equal(saved.enabled, false);
    assert.deepEqual(saved.configuration, { ...original, rootRef: "original-fixture-root" });
    assert.equal(saved.workspaceRoot, native);
    assert.equal(f.diagnostics.join("").includes("fixture_actual_drive"), false);
    assert.equal(f.diagnostics.join("").split("fixture_original_close").length - 1, 1);
  } finally {
    await owner.close();
    f.close();
  }
});

test("thread metadata returns the verified primary while original drive receives the exact budget scope", { skip: path.sep !== "\\" }, async () => {
  const f = fixture(), alias = f.scope.workspaceRoot.toLowerCase(), primary = f.scope.workspaceRoot.toUpperCase();
  const requested = runtimeScopePaths(f.scope.homeRoot, alias), cancel = new AbortController();
  const carrier = await initializeCentralRuntimeWorker({ ...f.options, workspaceRoot: alias, configuration: {
    fixtureNativeRoot: primary, fixtureBudgetScope: f.scope.workspaceRoot } }, cancel.signal);
  assert.ok(carrier);

  try {
    assert.equal(carrier.workspaceRoot, primary);
    carrier.acknowledgeMetadata();
    const result = await carrier.driver.drive({ scope: requested, configuration: carrier.configuration,
      wake: { reason: "actual_source", sourceRefs: [] }, signal: cancel.signal, publish() {} });
    assert.equal(result.reason, "actual_fixture_result", "the fixture rejects caller case at its original budget boundary");
  } finally {
    await carrier.driver.close?.();
    f.close();
  }
});

test("initialization failure drains its thread before rejecting and does not create a replacement carrier", async () => {
  const f = fixture();
  try { await assert.rejects(initializeCentralRuntimeWorker({ ...f.options, configuration: { fixtureReject: true } },
    new AbortController().signal), /runtime_worker_initialization_failed/); }
  finally { f.close(); }
});

test("domain ready published after a thread drive returns waiting still wakes the original scope owner", async () => {
  const f = fixture(), cancel = new AbortController(), original = { ...f.options.configuration, fixtureLateReady: true };
  let twice!: () => void;
  const continued = new Promise<void>(resolve => { twice = resolve; });
  const carrier = await initializeCentralRuntimeWorker({ ...f.options, configuration: original, diagnostic: text => {
    f.diagnostics.push(text);
    if (f.diagnostics.join("").split("fixture_actual_drive").length - 1 >= 2) twice();
  } }, cancel.signal);
  assert.ok(carrier);
  let saved: RuntimeIntent = { schemaVersion: 1, homeRoot: f.scope.homeRoot, workspaceRoot: f.scope.workspaceRoot,
    enabled: true, configuration: original, wakeSequence: 0, consumedSequence: 0, wakeReason: "source", sourceRefs: [] };
  const owner = createCentralScopeOwner({ scope: f.scope, ownerId: "late-publish-owner", intent: saved,
    store: { owns: () => true, writeIntent(value) {
      saved = value as RuntimeIntent;
      return { ok: true };
    } }, driver: carrier.driver });

  try {
    assert.ok(owner.updateConfiguration(carrier.configuration, original).ok);
    carrier.acknowledgeMetadata();
    owner.start();
    await continued;
    assert.equal(saved.wakeSequence, 2);
    assert.deepEqual(saved.sourceRefs, ["fixture:late-domain-result"]);
  } finally {
    await owner.close();
    f.close();
  }
});
