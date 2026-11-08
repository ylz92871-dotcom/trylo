import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runtimeScopePaths, tryAcquireRuntimeOwner, type RuntimeOwner } from "../../adapters/central-learning-runtime/files.js";
import { notifyCentralRuntimeForSource } from "./central-runtime-notify.js";
import type { CliContext } from "./context.js";

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "trylo-runtime-notify-")), homeRoot = path.join(root, "home");
  const workspaceRoot = path.join(root, "original-workspace"), paths = runtimeScopePaths(homeRoot, workspaceRoot);
  const ctx: CliContext = { homeDir: root, cwd: path.join(root, "unrelated-workspace"), env: { TRYLO_HOME: homeRoot },
    nodeVersion: "v24.0.0", stdinIsTty: false, readFile: () => undefined, isDirectory: () => false, readDir: () => [],
    writeFile: () => false, readStdin: async () => "", readLine: async () => undefined, readSecret: async () => undefined,
    stdout() {}, stderr() {}, now: () => 0, newId: prefix => prefix };
  const intent = (enabled = true) => ({ schemaVersion: 1, homeRoot, workspaceRoot, enabled, configuration: {},
    wakeSequence: 0, consumedSequence: 0, wakeReason: "initial", sourceRefs: [] });
  const acquire = (): RuntimeOwner => {
    const result = tryAcquireRuntimeOwner(paths, { ownerPid: 1234, createToken: () => "fixture-owner-lock", processStatus: () => "alive" });
    assert.ok(result.ok);
    return result.value;
  };

  return { ctx, paths, intent, acquire, input: { workspaceRoot, reason: "original_source_committed", sourceRefs: ["source:one"] } };
}

test("source notification leaves absent or disabled runtimes untouched and never creates a root", async () => {
  const f = fixture();

  assert.deepEqual(await notifyCentralRuntimeForSource(f.ctx, f.input), { ok: true, notified: false });
  assert.equal(existsSync(f.paths.directory), false);
  const owner = f.acquire();

  try {
    assert.ok(owner.writeIntent(f.intent(false)).ok);
    assert.deepEqual(await notifyCentralRuntimeForSource(f.ctx, f.input), { ok: true, notified: false });
    assert.ok(owner.writeIntent(f.intent()).ok);
    assert.deepEqual(await notifyCentralRuntimeForSource(f.ctx, f.input), { ok: true, notified: false });
  } finally { owner.close(); }
});

test("source notification wakes only the existing original-scope owner with exact refs", async () => {
  const f = fixture(), owner = f.acquire(), requests: unknown[] = [];
  let rejectWake = false;
  const locator = { schemaVersion: 1, scopeKey: f.paths.scopeKey, ownerId: "fixture-runtime", pid: 1234, port: 1, token: "fixture-rpc-token" };
  const server = http.createServer((request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${locator.token}`);
    let text = "";
    request.on("data", chunk => { text += String(chunk); });
    request.on("end", () => { requests.push(JSON.parse(text));
    response.end(JSON.stringify(rejectWake ? { ok: false, reason: "runtime_stopping" } : { ok: true,
      snapshot: { schemaVersion: 1, scopeKey: locator.scopeKey, ownerId: locator.ownerId, revision: 1,
        wakeSequence: 1, consumedSequence: 0, state: "running" } })); });
  });

  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  try {
    assert.ok(owner.writeIntent(f.intent(false)).ok);
    assert.ok(owner.writeLocator({ ...locator, port: address.port }).ok);
    assert.deepEqual(await notifyCentralRuntimeForSource(f.ctx, f.input), { ok: true, notified: false });
    assert.deepEqual(requests, []);
    assert.ok(owner.writeIntent(f.intent()).ok);
    const before = readFileSync(f.paths.intentPath, "utf8");

    assert.deepEqual(await notifyCentralRuntimeForSource(f.ctx, f.input), { ok: true, notified: true });
    assert.deepEqual(requests, [{ operation: "wake", wake: { reason: f.input.reason, sourceRefs: f.input.sourceRefs } }]);
    rejectWake = true;
    assert.deepEqual(await notifyCentralRuntimeForSource(f.ctx, f.input), { ok: false, reason: "runtime_stopping" });
    assert.equal(requests.length, 2, "a rejected wake is not retried or attached");
    assert.equal(readFileSync(f.paths.intentPath, "utf8"), before);
    assert.equal(existsSync(runtimeScopePaths(f.paths.homeRoot, f.ctx.cwd).directory), false);
  } finally {
    owner.close();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test("corrupt persisted runtime state and invalid wake metadata fail closed", async () => {
  const f = fixture(), owner = f.acquire();
  try {
    assert.ok(owner.writeIntent(f.intent()).ok);
    writeFileSync(f.paths.locatorPath, "{corrupt");
    const result = await notifyCentralRuntimeForSource(f.ctx, f.input);

    assert.equal(!result.ok && result.reason, "runtime_record_invalid");
    const invalid = await notifyCentralRuntimeForSource(f.ctx, { ...f.input, sourceRefs: ["x".repeat(513)] });

    assert.equal(!invalid.ok && invalid.reason, "runtime_wake_invalid");
    assert.equal(readFileSync(f.paths.locatorPath, "utf8"), "{corrupt");
  } finally { owner.close(); }
});
