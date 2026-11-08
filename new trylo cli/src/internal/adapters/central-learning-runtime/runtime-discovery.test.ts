import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readExistingEnabledRuntimeScopes as discover, runtimeScopePaths, tryAcquireRuntimeOwner, type RuntimeScopePaths } from "./files.js";

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(path.join(os.tmpdir(), "trylo-runtime-discovery-"));
  t.after(() => {
    assert.ok(root.startsWith(path.join(os.tmpdir(), "trylo-runtime-discovery-")));
    rmSync(root, { recursive: true, force: true });
  });
  return { root, home: path.join(root, "home"), foreignHome: path.join(root, "foreign-home") };
}

function scope(home: string, workspace: string, enabled = true, withLocator = true): RuntimeScopePaths {
  const paths = runtimeScopePaths(home, workspace), owner = tryAcquireRuntimeOwner(paths, { ownerPid: 1234,
    createToken: () => "owned-discovery-fixture", processStatus: () => "alive" });
  assert.ok(owner.ok);

  try {
    assert.ok(owner.value.writeIntent({ schemaVersion: 1, homeRoot: paths.homeRoot, workspaceRoot: paths.workspaceRoot,
      enabled, configuration: { privateFixture: "not-in-discovery-reply" }, wakeSequence: 1, consumedSequence: 1,
      wakeReason: "fixture", sourceRefs: [] }).ok);
    if (withLocator) assert.ok(owner.value.writeLocator({ schemaVersion: 1, scopeKey: paths.scopeKey, ownerId: "owner:fixture",
      pid: 1234, port: 40123, token: "private-transport-token-not-in-reply" }).ok);
  } finally { owner.value.close(); }

  return paths;
}

test("a missing runtime registry returns empty without creating a profile or runtime directory", t => {
  const f = fixture(t), result = discover(f.home);
  assert.deepEqual(result, { ok: true, value: { scopes: [], issues: [] } });
  assert.equal(existsSync(f.home), false);
});

test("discovery returns only enabled same-home scopes with an original matching locator and no private body", t => {
  const f = fixture(t);
  const first = scope(f.home, path.join(f.root, "workspace-a")), second = scope(f.home, path.join(f.root, "workspace-b"));

  scope(f.home, path.join(f.root, "disabled"), false);
  scope(f.home, path.join(f.root, "no-locator"), true, false);
  scope(f.foreignHome, path.join(f.root, "workspace-a"));
  const before = readFileSync(first.intentPath, "utf8"), names = readdirSync(first.directory).sort();
  const result = discover(f.home);
  assert.ok(result.ok);
  assert.deepEqual(result.value.scopes, [first, second].sort((left, right) => left.scopeKey.localeCompare(right.scopeKey)));
  assert.deepEqual(result.value.issues, []);
  assert.equal(JSON.stringify(result).includes("private-transport-token"), false);
  assert.equal(JSON.stringify(result).includes("not-in-discovery-reply"), false);
  assert.equal(JSON.stringify(result).includes("configuration"), false);
  assert.equal(readFileSync(first.intentPath, "utf8"), before);
  assert.deepEqual(readdirSync(first.directory).sort(), names);
  assert.equal(existsSync(path.join(f.home, "learning", "board")), false);
});

test("corrupt, oversized, foreign-home, wrong-key and mismatched locator entries report issues without hiding good scopes", t => {
  const f = fixture(t), good = scope(f.home, path.join(f.root, "good"));
  const malformed = scope(f.home, path.join(f.root, "malformed"));
  writeFileSync(malformed.intentPath, "{");
  const oversized = scope(f.home, path.join(f.root, "oversized"));
  writeFileSync(oversized.intentPath, "x".repeat(1_048_577));
  const foreign = scope(f.home, path.join(f.root, "foreign"));
  const foreignIntent = JSON.parse(readFileSync(foreign.intentPath, "utf8"));
  foreignIntent.homeRoot = f.foreignHome;
  writeFileSync(foreign.intentPath, JSON.stringify(foreignIntent));
  const mismatch = scope(f.home, path.join(f.root, "mismatch"));
  const mismatchedLocator = JSON.parse(readFileSync(mismatch.locatorPath, "utf8"));
  mismatchedLocator.scopeKey = "0".repeat(64);
  writeFileSync(mismatch.locatorPath, JSON.stringify(mismatchedLocator));
  const fakeKey = "f".repeat(64), fake = path.join(f.home, "learning", "runtime", fakeKey);
  mkdirSync(fake);
  writeFileSync(path.join(fake, "intent.json"), readFileSync(good.intentPath));
  writeFileSync(path.join(fake, "locator.json"), readFileSync(good.locatorPath));
  const result = discover(f.home);
  assert.ok(result.ok);
  assert.deepEqual(result.value.scopes, [good]);
  assert.deepEqual(result.value.issues.map((item: { scopeKey: string }) => item.scopeKey).sort(),
    [malformed.scopeKey, oversized.scopeKey, foreign.scopeKey, mismatch.scopeKey, fakeKey].sort());
  assert.equal(readFileSync(malformed.intentPath, "utf8"), "{", "discovery does not repair corrupt source records");
});

test("a direct junction or symlink entry cannot disclose another profile and does not prevent good entries", t => {
  const f = fixture(t), good = scope(f.home, path.join(f.root, "good")), foreign = scope(f.foreignHome, path.join(f.root, "foreign"));
  const linkedKey = "e".repeat(64), linked = path.join(f.home, "learning", "runtime", linkedKey);
  symlinkSync(foreign.directory, linked, process.platform === "win32" ? "junction" : "dir");
  const result = discover(f.home);
  assert.ok(result.ok);
  assert.deepEqual(result.value.scopes, [good]);
  assert.equal(result.value.issues.some((item: { scopeKey: string }) => item.scopeKey === linkedKey), true);
});

test("a linked registry root or linked ancestor cannot escape the original physical home", t => {
  const f = fixture(t), foreign = scope(f.foreignHome, path.join(f.root, "foreign"));

  mkdirSync(path.join(f.home, "learning"), { recursive: true });
  symlinkSync(path.dirname(foreign.directory), path.join(f.home, "learning", "runtime"), process.platform === "win32" ? "junction" : "dir");
  assert.equal(discover(f.home).ok, false);
  const otherHome = path.join(f.root, "ancestor-linked-home");
  mkdirSync(otherHome);
  symlinkSync(path.join(f.foreignHome, "learning"), path.join(otherHome, "learning"), process.platform === "win32" ? "junction" : "dir");
  assert.equal(discover(otherHome).ok, false);
});

test("invalid relative home is a typed failure and unrelated directory names are not traversed", t => {
  const f = fixture(t), good = scope(f.home, path.join(f.root, "good"));
  mkdirSync(path.join(f.home, "learning", "runtime", "unrelated-directory"));
  const result = discover(f.home);
  assert.ok(result.ok);
  assert.deepEqual(result.value.scopes, [good]);
  assert.deepEqual(result.value.issues, []);
  assert.equal(discover("relative-profile").ok, false);
});
