import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readRuntimeIntent, readRuntimeLocator, runtimeScopePaths, tryAcquireRuntimeOwner,
  type RuntimeIntent, type RuntimeOwner, type RuntimeScopePaths } from "./files.js";

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "trylo-central-runtime-files-"));
  return runtimeScopePaths(path.join(root, "home"), path.join(root, "workspace"));
}

function acquire(paths: RuntimeScopePaths, pid = 1234): RuntimeOwner {
  let sequence = 0;
  const result = tryAcquireRuntimeOwner(paths, { ownerPid: pid,
    createToken: () => `runtime-test-token-${pid}-${++sequence}`, processStatus: () => "alive" });
  if (!result.ok) throw new Error(result.reason);
  return result.value;
}

function intent(paths: RuntimeScopePaths): RuntimeIntent {
  return { schemaVersion: 1, homeRoot: paths.homeRoot, workspaceRoot: paths.workspaceRoot, enabled: true,
    configuration: { providerId: "fixture", nested: { tools: ["read_file"], disabled: false } },
    wakeSequence: 2, consumedSequence: 1, wakeReason: "task_evidence", sourceRefs: ["session:example"] };
}

function locator(paths: RuntimeScopePaths, pid = 1234) {
  return { schemaVersion: 1, scopeKey: paths.scopeKey, ownerId: "runtime-owner-one", pid,
    port: 40123, token: "fixture-runtime-connection-token" };
}

test("scope identity includes both normalized absolute roots and never uses the Board lock", () => {
  const paths = fixture();

  assert.deepEqual(runtimeScopePaths(paths.homeRoot, path.join(paths.workspaceRoot, ".")), paths);
  assert.notEqual(runtimeScopePaths(`${paths.homeRoot}-other`, paths.workspaceRoot).scopeKey, paths.scopeKey);
  assert.notEqual(runtimeScopePaths(paths.homeRoot, `${paths.workspaceRoot}-other`).scopeKey, paths.scopeKey);
  assert.equal(paths.ownerLockPath, path.join(paths.directory, "owner.lock"));
  assert.equal(paths.directory, path.join(paths.homeRoot, "learning", "runtime", paths.scopeKey));
  assert.throws(() => runtimeScopePaths("relative-home", paths.workspaceRoot));

  if (path.sep === "\\") assert.throws(() => runtimeScopePaths("\\drive-relative-home", paths.workspaceRoot));

  assert.deepEqual(readRuntimeIntent(paths), { ok: true, value: undefined });
  assert.deepEqual(readRuntimeLocator(paths), { ok: true, value: undefined });
  assert.equal(existsSync(paths.directory), false);
});

test("one process owner persists complete intent and locator, then releases without a Board writer", () => {
  const paths = fixture(), owner = acquire(paths);

  try {
    assert.equal(owner.owns(), true);
    assert.deepEqual(owner.writeIntent(intent(paths)), { ok: true, value: true });
    assert.deepEqual(owner.writeLocator(locator(paths)), { ok: true, value: true });
    assert.deepEqual(readRuntimeIntent(paths), { ok: true, value: intent(paths) });
    assert.deepEqual(readRuntimeLocator(paths), { ok: true, value: locator(paths) });
    const rival = tryAcquireRuntimeOwner(paths, { ownerPid: 5678, processStatus: () => "alive" });

    assert.equal(!rival.ok && rival.reason, "runtime_owner_busy");
    assert.equal(existsSync(path.join(paths.homeRoot, "learning", "board", "board-writer.lock")), false);
    assert.deepEqual(readdirSync(paths.directory).sort(), ["intent.json", "locator.json", "owner.lock"]);
    assert.deepEqual(owner.clearLocator(), { ok: true, value: true });
    assert.deepEqual(readRuntimeLocator(paths), { ok: true, value: undefined });
  } finally { assert.deepEqual(owner.close(), { ok: true, value: true }); }

  assert.equal(owner.owns(), false);
  assert.deepEqual(owner.close(), { ok: true, value: true });
  assert.equal(existsSync(paths.ownerLockPath), false);
});

test("malformed, oversized, cross-scope and unknown-field records fail closed without repair", () => {
  const paths = fixture();

  mkdirSync(paths.directory, { recursive: true });

  for (const value of ["", "null", "[]", "{", "x".repeat(1_048_577), JSON.stringify({ ...intent(paths), unexpected: true }),
    JSON.stringify({ ...intent(paths), configuration: null }), JSON.stringify({ ...intent(paths), enabled: "true" }),
    JSON.stringify({ ...intent(paths), workspaceRoot: `${paths.workspaceRoot}-other` })]) {
    writeFileSync(paths.intentPath, value);
    assert.equal(readRuntimeIntent(paths).ok, false);
    assert.equal(readFileSync(paths.intentPath, "utf8"), value);
  }

  const owner = acquire(paths);

  try {
    const before = readFileSync(paths.intentPath, "utf8");
    assert.equal(owner.writeIntent(intent(paths)).ok, false);
    assert.equal(readFileSync(paths.intentPath, "utf8"), before);
  } finally { owner.close(); }

  writeFileSync(paths.locatorPath, JSON.stringify({ ...locator(paths), pid: "1234" }));
  assert.equal(readRuntimeLocator(paths).ok, false);
  writeFileSync(paths.locatorPath, JSON.stringify({ ...locator(paths), scopeKey: "0".repeat(64) }));
  assert.equal(readRuntimeLocator(paths).ok, false);
});

test("writes reject invalid sequences, unbounded wake metadata and non-JSON configuration without changing durable intent", () => {
  const paths = fixture(), owner = acquire(paths), good = intent(paths);
  try {
    assert.equal(owner.writeIntent(good).ok, true);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const hiddenSerializer = Object.setPrototypeOf({ ...good }, { toJSON: () => ({ ...good, enabled: false }) });
    const getterRecord = { ...good };

    Object.defineProperty(getterRecord, "enabled", { enumerable: true, get: () => true });
    const invalid = [undefined, { ...good, wakeSequence: -1 }, { ...good, wakeSequence: Number.MAX_SAFE_INTEGER + 1 },
      { ...good, consumedSequence: 3 }, { ...good, consumedSequence: 0.5 }, { ...good, wakeReason: "x".repeat(257) },
      { ...good, sourceRefs: Array.from({ length: 33 }, () => "ref") }, { ...good, sourceRefs: [""] },
      { ...good, sourceRefs: ["x".repeat(513)] }, { ...good, sourceRefs: new Array(1) }, { ...good, configuration: { value: undefined } },
      { ...good, configuration: { value: Infinity } }, { ...good, configuration: { value: () => "not JSON" } },
      { ...good, configuration: { value: new Date(0) } }, { ...good, configuration: cyclic },
      { ...good, homeRoot: `${paths.homeRoot}-other` }, { ...good, unexpected: true }, hiddenSerializer, getterRecord];

    for (const value of invalid) {
      assert.equal(owner.writeIntent(value).ok, false);
      assert.deepEqual(readRuntimeIntent(paths), { ok: true, value: good });
    }

    for (const value of [{ ...locator(paths), pid: 5678 }, { ...locator(paths), port: 0 },
      { ...locator(paths), port: 65536 }, { ...locator(paths), token: "" }, { ...locator(paths), unexpected: true }]) {
      assert.equal(owner.writeLocator(value).ok, false);
      assert.deepEqual(readRuntimeLocator(paths), { ok: true, value: undefined });
    }
  } finally { owner.close(); }
});

test("dead owners recover; stale writes, locator removal and release cannot affect a replacement", () => {
  const paths = fixture();

  mkdirSync(paths.directory, { recursive: true });
  writeFileSync(paths.ownerLockPath, JSON.stringify({ formatVersion: 1, role: "writer", pid: 42, token: "dead-owner-token" }));
  const recovered = tryAcquireRuntimeOwner(paths, { ownerPid: 1234, processStatus: pid => pid === 42 ? "dead" : "alive" });
  if (!recovered.ok) throw new Error(recovered.reason);

  const stale = recovered.value;

  assert.equal(stale.writeIntent(intent(paths)).ok, true);
  unlinkSync(paths.ownerLockPath);
  const replacement = acquire(paths, 5678);

  try {
    assert.equal(replacement.writeLocator(locator(paths, 5678)).ok, true);
    const beforeIntent = readFileSync(paths.intentPath, "utf8"), beforeLocator = readFileSync(paths.locatorPath, "utf8");

    for (const result of [stale.writeIntent({ ...intent(paths), enabled: false }), stale.writeLocator(locator(paths)), stale.clearLocator()]) {
      assert.equal(!result.ok && result.reason, "runtime_owner_lost");
    }

    stale.close();
    assert.equal(readFileSync(paths.intentPath, "utf8"), beforeIntent);
    assert.equal(readFileSync(paths.locatorPath, "utf8"), beforeLocator);
    assert.equal(replacement.owns(), true);
  } finally {
    replacement.close();
    stale.close();
  }
});

test("unknown or corrupt owner identity is preserved rather than reclaimed", () => {
  const paths = fixture();

  mkdirSync(paths.directory, { recursive: true });

  for (const bytes of ["{", JSON.stringify({ formatVersion: 1, role: "writer", pid: 42, token: "unknown-owner-token" })]) {
    writeFileSync(paths.ownerLockPath, bytes);
    const result = tryAcquireRuntimeOwner(paths, { ownerPid: 1234, processStatus: () => "unknown" });
    assert.equal(!result.ok && result.reason, "runtime_owner_busy");
    assert.equal(readFileSync(paths.ownerLockPath, "utf8"), bytes);
  }
});
