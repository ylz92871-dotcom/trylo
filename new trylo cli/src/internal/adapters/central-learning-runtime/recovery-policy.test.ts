import test from "node:test";
import assert from "node:assert/strict";
import { createCentralScopeOwner } from "./owner.js";
import { isRuntimeIntent, type RuntimeIntent } from "./files-contract.js";
import { runtimeScopePaths } from "./files.js";
import path from "node:path";

function fixture(policy?: "eligible" | "paused") {
  const scope = runtimeScopePaths(path.resolve("fixture-profile"), path.resolve("fixture-workspace"));
  let saved: RuntimeIntent = { schemaVersion: 1, homeRoot: scope.homeRoot, workspaceRoot: scope.workspaceRoot,
    configuration: { rootRef: "unchanged-original-root" }, enabled: true, wakeSequence: 3, consumedSequence: 3,
    wakeReason: "original_source", sourceRefs: ["source:original"], ...(policy === undefined ? {} : { recoveryPolicy: policy }) };
  const owner = createCentralScopeOwner({ scope, ownerId: "policy-owner", intent: saved,
    store: { owns: () => true, writeIntent(value) {
      assert.ok(isRuntimeIntent(value));
      saved = value;
      return { ok: true };
    } },
    driver: { async drive() { return { state: "waiting" }; } } });

  return { owner, saved: () => saved };
}

test("public pause is durable, and a later stop wins without replacing original configuration or notification", async () => {
  const f = fixture("eligible"), before = f.saved();
  const pause = f.owner.requestClose("pause");

  assert.ok(pause.receipt.ok);
  assert.equal(f.saved().recoveryPolicy, "paused");
  assert.equal(f.saved().enabled, true);
  const stop = f.owner.requestClose("stop");

  assert.ok(stop.receipt.ok);
  assert.equal(f.saved().enabled, false);
  assert.deepEqual(f.saved().configuration, before.configuration);
  assert.equal(f.saved().wakeSequence, before.wakeSequence);
  await Promise.all([pause.closed, stop.closed]);
});

test("maintenance restart retains classification while explicit ordinary activation classifies legacy without a wake", async () => {
  const f = fixture(), before = f.saved();
  assert.ok(f.owner.activate().ok);
  assert.equal(f.saved().recoveryPolicy, "eligible");
  assert.equal(f.saved().wakeSequence, before.wakeSequence);
  assert.equal(f.saved().enabled, true);
  await f.owner.close("restart");
  assert.equal(f.saved().recoveryPolicy, "eligible");
});

test("explicit stop cannot be undone by ordinary activation or a later pause", async () => {
  const f = fixture("eligible");
  const stopped = f.owner.requestClose("stop");
  assert.deepEqual(f.owner.activate(), { ok: false, reason: "runtime_disabled" });
  const paused = f.owner.requestClose("pause");
  assert.equal(f.saved().enabled, false);
  await Promise.all([stopped.closed, paused.closed]);
});

test("legacy intent remains readable and only the two declared recovery policies are persisted", async () => {
  const f = fixture(), legacy = f.saved();
  assert.ok(isRuntimeIntent(legacy));
  assert.ok(isRuntimeIntent({ ...legacy, recoveryPolicy: "paused" }));
  assert.equal(isRuntimeIntent({ ...legacy, recoveryPolicy: "automatic_guess" }), false);
  await f.owner.close();
});
