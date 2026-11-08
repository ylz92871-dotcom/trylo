import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { isRuntimeReply, type CentralRuntimeReply } from "./contracts.js";
import { isRuntimeIntent, readRuntimeIntent, runtimeScopePaths, tryAcquireRuntimeOwner, type RuntimeIntent } from "./files.js";
import { serveCentralRuntime } from "./server.js";
import { createCentralScopeOwner } from "./owner.js";
import { requestCentralRuntime } from "./transport.js";

test("a lost wake receipt is confirmed from its original durable acceptance without resending the wake", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "trylo-wake-receipt-"));
  const paths = runtimeScopePaths(root, path.join(root, "workspace"));

  mkdirSync(paths.workspaceRoot);
  const acquired = tryAcquireRuntimeOwner(paths);
  assert.ok(acquired.ok);
  let injected = false, drives = 0;
  const host = await serveCentralRuntime({ paths, configuration: {}, owner: { ...acquired.value,
    writeIntent(value) {
      const saved = acquired.value.writeIntent(value);
      if (saved.ok && !injected && isRuntimeIntent(value) && value.wakeSequence === 2 && value.consumedSequence === 1) {
        injected = true;
        // The client has its own event loop and the unchanged production 3s limit.
        // Only the original intent has been published; no semantic work is repeated.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 4500);
      }

      return saved;
    },
  }, driver: { async drive() {
    drives++;
    return { state: "waiting" };
  } } });
  let client: Worker | undefined;

  try {
    while (host.owner.snapshot().state !== "waiting") await new Promise<void>(resolve => setImmediate(resolve));

    client = new Worker(new URL("./wake-receipt-client.test.js", import.meta.url), { workerData: host.address });
    const replies = await new Promise<readonly CentralRuntimeReply[]>((resolve, reject) => {
      client!.once("error", reject);
      client!.once("message", (value: unknown) => {
        if (!Array.isArray(value) || !value.every(isRuntimeReply)) reject(new Error("invalid_fixture_replies"));
        else resolve(value);
      });
    });

    assert.equal(injected, true);
    assert.deepEqual(replies.map(reply => reply.ok), [true, true, true]);

    while (host.owner.snapshot().state !== "waiting") await new Promise<void>(resolve => setImmediate(resolve));

    const saved = readRuntimeIntent(paths);
    assert.ok(saved.ok && saved.value !== undefined);
    assert.equal(saved.value.wakeSequence, 4, "startup plus three requests, with no delivery replay");
    assert.equal(saved.value.consumedSequence, 4);
    assert.equal(drives, 4);
  } finally {
    await client?.terminate();
    await host.close("stop");
  }
});

test("confirmation cannot borrow another owner, and explicit refusal or abort never sends a confirmation", async () => {
  const operations: string[] = [], nonces: string[] = [];
  const snapshot = { schemaVersion: 1, scopeKey: "receipt-scope", ownerId: "another-owner", revision: 1,
    state: "waiting", wakeSequence: 1, consumedSequence: 1 };
  const server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];

    for await (const chunk of request) chunks.push(chunk);

    const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));

    operations.push(input.operation);
    nonces.push(input.requestId);

    if (input.operation === "wake" && input.wake.reason === "refused") response.end(JSON.stringify({ ok: false, reason: "runtime_io_failed" }));
    else if (input.operation === "wake") response.destroy();
    else response.end(JSON.stringify({ ok: true, snapshot }));
  });

  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const bound = server.address();
  assert.ok(bound !== null && typeof bound !== "string");
  const address = { schemaVersion: 1 as const, scopeKey: "receipt-scope", ownerId: "original-owner", pid: 1, port: bound.port, token: "fixture-token" };

  try {
    const fresh = "00000000-0000-4000-8000-000000000004";

    assert.deepEqual(await requestCentralRuntime(address, { operation: "wake", wake: { reason: "unknown", sourceRefs: [] },
      requestId: "00000000-0000-4000-8000-000000000001" }, undefined, { newIdentity: () => fresh }),
      { ok: false, reason: "runtime_transport_unavailable" });
    assert.deepEqual(operations, ["wake", "wake_receipt"], "confirmation is read-only; the wake must not be sent again");
    assert.deepEqual(nonces, [fresh, fresh], "each actual transport wake supplies its own fresh nonce, ignoring a caller's old one");
    assert.deepEqual(await requestCentralRuntime(address, { operation: "wake", wake: { reason: "refused", sourceRefs: [] } }),
      { ok: false, reason: "runtime_io_failed" });
    const aborted = new AbortController();
    aborted.abort();
    assert.deepEqual(await requestCentralRuntime(address, { operation: "wake", wake: { reason: "aborted", sourceRefs: [] } }, aborted.signal),
      { ok: false, reason: "runtime_client_aborted" });
    assert.deepEqual(operations, ["wake", "wake_receipt", "wake"]);
  } finally {
    server.closeIdleConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("only the latest accepted external nonce under the same live lease confirms; internal wakes preserve it", async () => {
  let owns = true, rejectWrite = false, publish: Parameters<Parameters<typeof createCentralScopeOwner>[0]["driver"]["drive"]>[0]["publish"] | undefined;
  const scope = { homeRoot: path.resolve("D:/receipt-profile"), workspaceRoot: path.resolve("D:/receipt-workspace"), scopeKey: "receipt-scope" };
  let saved: RuntimeIntent = { schemaVersion: 1, homeRoot: scope.homeRoot, workspaceRoot: scope.workspaceRoot,
    enabled: true, configuration: {}, wakeSequence: 0, consumedSequence: 0, wakeReason: "initial", sourceRefs: [] };
  const store = { owns: () => owns, writeIntent(value: unknown) {
    if (rejectWrite) return { ok: false as const, reason: "runtime_io_failed" };
    assert.ok(isRuntimeIntent(value));
    saved = value;
    return { ok: true as const };
  } };
  const owner = createCentralScopeOwner({ scope, ownerId: "receipt-owner", intent: saved, store,
    driver: { async drive(input) {
      publish = input.publish;
      return { state: "waiting" };
    } } });
  const first = "00000000-0000-4000-8000-000000000001", rejected = "00000000-0000-4000-8000-000000000002";
  const latest = "00000000-0000-4000-8000-000000000003";
  const tick = () => new Promise<void>(resolve => setImmediate(resolve));

  try {
    assert.deepEqual(owner.wakeReceipt(first), { ok: false, reason: "runtime_wake_receipt_unknown" });
    assert.equal(owner.wake({ reason: "new_source", sourceRefs: ["source:original"] }, undefined, first).ok, true);
    await tick();
    publish!({ state: "ready", message: "actual_domain_return", sourceRefs: ["result:original"] });
    await tick();
    assert.equal(owner.wakeReceipt(first).ok, true, "an internal domain wake is not another external receipt");
    const before = saved.wakeSequence;

    assert.deepEqual(owner.wake({ reason: "handoff", sourceRefs: [] }, {}, rejected),
      { ok: false, reason: "runtime_configuration_handoff_required" });
    rejectWrite = true;
    assert.deepEqual(owner.wake({ reason: "unwritten", sourceRefs: [] }, undefined, rejected), { ok: false, reason: "runtime_io_failed" });
    rejectWrite = false;
    assert.equal(saved.wakeSequence, before);
    assert.equal(owner.wakeReceipt(first).ok, true);
    assert.deepEqual(owner.wakeReceipt(rejected), { ok: false, reason: "runtime_wake_receipt_unknown" });
    assert.equal(owner.wake({ reason: "later_source", sourceRefs: [] }, undefined, latest).ok, true);
    await tick();
    assert.deepEqual(owner.wakeReceipt(first), { ok: false, reason: "runtime_wake_receipt_unknown" });
    assert.equal(owner.wakeReceipt(latest).ok, true);
    owns = false;
    assert.deepEqual(owner.wakeReceipt(latest), { ok: false, reason: "runtime_owner_lost" });
    owns = true;
    await owner.close("stop");
    assert.deepEqual(owner.wake({ reason: "late", sourceRefs: [] }, undefined, rejected), { ok: false, reason: "runtime_stopping" });
    assert.equal(saved.enabled, false);
    const replacement = createCentralScopeOwner({ scope, ownerId: "replacement-owner", intent: saved, store,
      driver: { async drive() { return { state: "waiting" }; } } });

    try { assert.deepEqual(replacement.wakeReceipt(latest), { ok: false, reason: "runtime_wake_receipt_unknown" }); }
    finally { await replacement.close("stop"); }
  } finally { await owner.close("stop"); }
});
