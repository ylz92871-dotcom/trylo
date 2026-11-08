import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import { attachCentralRuntime } from "./client.js";
import { readRuntimeIntent, runtimeScopePaths, tryAcquireRuntimeOwner } from "./files.js";
import type { CentralRuntimeSnapshot } from "./contracts.js";
import { CentralRuntimeStartupRefusal, launchCentralRuntime, runtimeActivationFailure } from "./launch.js";

function fixture(t: { after(fn: () => void | Promise<void>): void }) {
  const root = mkdtempSync(path.join(tmpdir(), "trylo-runtime-bootstrap-"));

  t.after(async () => {
    assert.ok(root.startsWith(path.join(tmpdir(), "trylo-runtime-bootstrap-")));
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 10 });
  });
  const home = path.join(root, "home"), paths = runtimeScopePaths(home, root);
  const input = { homeRoot: home, workspaceRoot: root, configuration: { providerId: "stale-caller" } };
  // A denied startup must never reach even this deliberately unavailable executable.
  const launch = { executable: path.join(root, "unavailable-node.exe"), entrypoint: path.join(root, "absent.js"), environment: {} };

  return { root, home, paths, input, launch };
}

function seed(f: ReturnType<typeof fixture>, changes: { readonly enabled?: boolean; readonly recoveryPolicy?: "eligible" | "paused" } = {}) {
  const lease = tryAcquireRuntimeOwner(f.paths);
  assert.ok(lease.ok);

  try {
    const latest = readRuntimeIntent(f.paths);
    assert.ok(latest.ok);
    assert.ok(lease.value.writeIntent({ schemaVersion: 1, homeRoot: f.paths.homeRoot, workspaceRoot: f.paths.workspaceRoot,
      enabled: true, configuration: { providerId: "original-provider" }, wakeSequence: 7, consumedSequence: 7,
      wakeReason: "original_source", sourceRefs: [], ...latest.value, ...changes }).ok);
  } finally { lease.value.close(); }
}

for (const activation of ["recover", "preserve"] as const) {
  test(`${activation} refuses a missing original intent before creating a runtime directory`, async t => {
    const f = fixture(t);
    assert.deepEqual(await attachCentralRuntime({ ...f.input, activation }, f.launch), { ok: false, reason: "runtime_intent_missing" });
    assert.equal(existsSync(f.home), false);
  });
}

async function liveFixture(t: { after(fn: () => void | Promise<void>): void }, state: CentralRuntimeSnapshot["state"] = "waiting") {
  const f = fixture(t), operations: string[] = [];
  let onStatus: (() => void) | undefined;
  const snapshot: CentralRuntimeSnapshot = { schemaVersion: 1, scopeKey: f.paths.scopeKey, ownerId: "bootstrap-owner",
    revision: 0, wakeSequence: 7, consumedSequence: 7, state };
  const server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { operation: string };
    operations.push(input.operation);
    if (input.operation === "status") onStatus?.();
    response.end(JSON.stringify({ ok: true, snapshot }));
  });

  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  seed(f);
  const lease = tryAcquireRuntimeOwner(f.paths);
  assert.ok(lease.ok);

  try {
    assert.ok(lease.value.writeLocator({ schemaVersion: 1, scopeKey: f.paths.scopeKey, ownerId: snapshot.ownerId,
      pid: lease.value.pid, port: address.port, token: "fixture-transport" }).ok);
  } finally { lease.value.close(); }

  return { ...f, operations, onStatus(value: () => void) { onStatus = value; } };
}

test("ordinary attach durably activates an existing owner without a wake", async t => {
  const f = await liveFixture(t);
  const attached = await attachCentralRuntime({ ...f.input, activation: "ordinary" }, f.launch);
  assert.ok(attached.ok);
  attached.client.detach();
  assert.deepEqual(f.operations, ["status", "activate"]);
});

test("recover inspects an existing failed legacy owner without activation or wake", async t => {
  const f = await liveFixture(t, "failed");
  const attached = await attachCentralRuntime({ ...f.input, activation: "recover" }, f.launch);
  assert.ok(attached.ok);
  assert.equal(attached.ownerSource, "existing");
  attached.client.detach();
  assert.deepEqual(f.operations, ["status"]);
});

test("cold recovery refuses unclassified legacy authority without launching", async t => {
  const f = fixture(t);
  seed(f);
  assert.deepEqual(await attachCentralRuntime({ ...f.input, activation: "recover" }, f.launch),
    { ok: false, reason: "runtime_recovery_unclassified" });
});

test("public pause bars recovery and maintenance while ordinary entry retains activation authority", async t => {
  const f = fixture(t);
  seed(f, { recoveryPolicy: "paused" });
  for (const activation of ["recover", "preserve"] as const) {
    assert.deepEqual(await attachCentralRuntime({ ...f.input, activation }, f.launch), { ok: false, reason: "runtime_paused" });
  }
  assert.equal(runtimeActivationFailure("ordinary", { enabled: true, recoveryPolicy: "paused" }, "launch"), undefined);
});

test("every activation refuses persistent stop and a stop arriving during an existing-owner probe", async t => {
  const f = await liveFixture(t);

  f.onStatus(() => seed(f, { enabled: false }));
  assert.deepEqual(await attachCentralRuntime({ ...f.input, activation: "ordinary" }, f.launch), { ok: false, reason: "runtime_disabled" });
  assert.deepEqual(f.operations, ["status"]);

  for (const activation of ["ordinary", "recover", "preserve"] as const) {
    assert.deepEqual(await attachCentralRuntime({ ...f.input, activation }, f.launch), { ok: false, reason: "runtime_disabled" });
  }
});

test("a pause arriving during a recovery status probe is not lost", async t => {
  const f = await liveFixture(t);
  f.onStatus(() => seed(f, { recoveryPolicy: "paused" }));
  assert.deepEqual(await attachCentralRuntime({ ...f.input, activation: "recover" }, f.launch), { ok: false, reason: "runtime_paused" });
  assert.deepEqual(f.operations, ["status"]);
});

test("the child admission boundary rechecks current policy and preserves generic compatibility", () => {
  assert.equal(runtimeActivationFailure("recover", { enabled: true }, "existing"), undefined);
  assert.equal(runtimeActivationFailure("recover", { enabled: true }, "launch"), "runtime_recovery_unclassified");
  assert.equal(runtimeActivationFailure("recover", { enabled: true, recoveryPolicy: "eligible" }, "launch"), undefined);
  assert.equal(runtimeActivationFailure("recover", { enabled: true, recoveryPolicy: "paused" }, "launch"), "runtime_paused");
  assert.equal(runtimeActivationFailure("recover", undefined, "launch"), "runtime_intent_missing");
  assert.equal(runtimeActivationFailure("preserve", undefined, "launch"), "runtime_intent_missing");
  assert.equal(runtimeActivationFailure("preserve", { enabled: true }, "launch"), undefined);
  assert.equal(runtimeActivationFailure(undefined, undefined, "launch"), undefined);
  assert.equal(runtimeActivationFailure(undefined, { enabled: false }, "launch"), "runtime_disabled");
});

test("a late child refusal crosses the original startup pipe as an exact typed failure", async t => {
  const f = fixture(t), entrypoint = path.join(f.root, "refused.mjs");
  writeFileSync(entrypoint, "process.stdout.write(JSON.stringify({ok:false,reason:'runtime_paused'})+'\\n');\n");
  await assert.rejects(launchCentralRuntime({ ...f.launch, executable: process.execPath, entrypoint },
    { schemaVersion: 1, ...f.input, activation: "recover" }, f.paths.scopeKey),
  (error: unknown) => error instanceof CentralRuntimeStartupRefusal && error.reason === "runtime_paused");
});

test("the actual child rejects a saved pause under its owner lock before initializing a worker", t => {
  const f = fixture(t);
  seed(f, { recoveryPolicy: "paused" });
  const entrypoint = fileURLToPath(new URL("../../../cmd/trylo/central-runtime-main.js", import.meta.url));
  const configuration = { schemaVersion: 1, providerId: "fixture", model: "reference-only", endpointHash: "reference-hash",
    workspaceId: "bootstrap:workspace", userLearning: false,
    allowance: { schemaVersion: 2, unit: "total_model_tokens", maxTokens: 100, maxCalls: 1, maxSteps: 1, maxPromptChars: 100 } };
  const before = readFileSync(f.paths.intentPath, "utf8");
  const child = spawnSync(process.execPath, [entrypoint], { input: JSON.stringify({ schemaVersion: 1, ...f.input,
    configuration, activation: "recover" }) + "\n", encoding: "utf8", timeout: 5000, windowsHide: true,
  });

  assert.equal(child.error, undefined);
  assert.equal(child.status, 1);
  assert.deepEqual(JSON.parse(child.stdout.trim()), { ok: false, reason: "runtime_paused" });
  assert.equal(readFileSync(f.paths.intentPath, "utf8"), before);
  assert.equal(existsSync(f.paths.locatorPath), false);
  assert.equal(existsSync(f.paths.ownerLockPath), false);
});
