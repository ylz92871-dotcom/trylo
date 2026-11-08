import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import * as files from "./files.js";
import type { RuntimeScopePaths } from "./files.js";

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(path.join(os.tmpdir(), "trylo-runtime-recovery-discovery-"));

  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.match(path.basename(root), /^trylo-runtime-recovery-discovery-/u);
    rmSync(root, { recursive: true, force: true });
  });

  return { root, home: path.join(root, "home"), foreignHome: path.join(root, "foreign-home") };
}

function scope(home: string, workspace: string, enabled = true, withLocator = false): RuntimeScopePaths {
  const paths = files.runtimeScopePaths(home, workspace);

  mkdirSync(paths.directory, { recursive: true });
  writeFileSync(paths.intentPath, JSON.stringify({ schemaVersion: 1, homeRoot: paths.homeRoot, workspaceRoot: paths.workspaceRoot,
    enabled, configuration: { privateFixture: "private-configuration-not-in-reply" }, wakeSequence: 1, consumedSequence: 1,
    wakeReason: "fixture", sourceRefs: [] }));

  if (withLocator) writeFileSync(paths.locatorPath, JSON.stringify({ schemaVersion: 1, scopeKey: paths.scopeKey,
    ownerId: "owner:fixture", pid: 1234, port: 40123, token: "private-transport-token-not-in-reply" }));

  return paths;
}

const discover: typeof files.readRecoverableRuntimeScopes = (...args) => {
  assert.equal(typeof files.readRecoverableRuntimeScopes, "function", "cold recovery needs an enabled-scope discovery entrypoint");
  return files.readRecoverableRuntimeScopes(...args);
};

test("cold discovery includes enabled legacy scopes without a locator while existing-owner discovery preserves its filter", t => {
  const f = fixture(t), cold = scope(f.home, path.join(f.root, "cold")), live = scope(f.home, path.join(f.root, "live"), true, true);

  scope(f.home, path.join(f.root, "disabled"), false);
  scope(f.foreignHome, path.join(f.root, "foreign"));
  const before = readFileSync(cold.intentPath, "utf8"), names = readdirSync(cold.directory).sort();
  const result = discover(f.home);
  assert.ok(result.ok);
  assert.deepEqual(result.value.scopes, [cold, live].sort((left, right) => left.scopeKey.localeCompare(right.scopeKey)));
  assert.deepEqual(result.value.issues, []);
  assert.equal(result.value.nextCursor, undefined);
  const existing = files.readExistingEnabledRuntimeScopes(f.home);
  assert.ok(existing.ok);
  assert.deepEqual(existing.value.scopes, [live]);
  assert.equal(JSON.stringify(result).includes("private-configuration"), false);
  assert.equal(JSON.stringify(result).includes("private-transport-token"), false);
  assert.equal(readFileSync(cold.intentPath, "utf8"), before);
  assert.deepEqual(readdirSync(cold.directory).sort(), names);
  assert.equal(existsSync(path.join(f.home, "learning", "board")), false);
});

test("cold discovery leaves an enabled paused registration for the recovery owner to classify", t => {
  const f = fixture(t), paused = scope(f.home, path.join(f.root, "paused"));
  const original = JSON.parse(readFileSync(paused.intentPath, "utf8"));
  writeFileSync(paused.intentPath, JSON.stringify({ ...original, recoveryPolicy: "paused" }));
  const result = discover(f.home);
  assert.ok(result.ok);
  assert.deepEqual(result.value.scopes, [paused]);
  assert.deepEqual(result.value.issues, []);
  assert.equal(JSON.parse(readFileSync(paused.intentPath, "utf8")).recoveryPolicy, "paused");
});

test("each cursor page counts disabled and malformed registry entries rather than only returned enabled scopes", t => {
  const f = fixture(t), rows = Array.from({ length: 7 }, (_, index) => scope(f.home, path.join(f.root, `workspace-${index}`)))
    .sort((left, right) => left.scopeKey.localeCompare(right.scopeKey));
  const disabled = rows[0]!, malformed = rows[1]!;
  const intent = JSON.parse(readFileSync(disabled.intentPath, "utf8"));
  writeFileSync(disabled.intentPath, JSON.stringify({ ...intent, enabled: false }));
  writeFileSync(malformed.intentPath, "{");
  const first = discover(f.home, { limit: 2 });
  assert.ok(first.ok);
  assert.deepEqual(first.value.scopes, []);
  assert.equal(first.value.nextCursor, malformed.scopeKey);
  assert.deepEqual(first.value.issues.map(item => item.scopeKey), [malformed.scopeKey]);
  assert.ok(first.value.nextCursor);
  const second = discover(f.home, { limit: 2, afterScopeKey: first.value.nextCursor });
  assert.ok(second.ok);
  assert.deepEqual(second.value.scopes, rows.slice(2, 4));
  assert.equal(second.value.nextCursor, rows[3]!.scopeKey);
  assert.ok(second.value.nextCursor);
  const last = discover(f.home, { limit: 3, afterScopeKey: second.value.nextCursor });
  assert.ok(last.ok);
  assert.deepEqual(last.value.scopes, rows.slice(4));
  assert.equal(last.value.nextCursor, undefined);
  assert.equal(readFileSync(malformed.intentPath, "utf8"), "{");
});

test("default and maximum page sizes are bounded and a cursor need not name an extant entry", t => {
  const f = fixture(t), rows = Array.from({ length: 66 }, (_, index) => scope(f.home, path.join(f.root, `workspace-${index}`)))
    .sort((left, right) => left.scopeKey.localeCompare(right.scopeKey));
  const first = discover(f.home);
  assert.ok(first.ok);
  assert.deepEqual(first.value.scopes, rows.slice(0, 32));
  assert.equal(first.value.nextCursor, rows[31]!.scopeKey);
  const maximum = discover(f.home, { limit: 64 });
  assert.ok(maximum.ok);
  assert.deepEqual(maximum.value.scopes, rows.slice(0, 64));
  assert.equal(maximum.value.nextCursor, rows[63]!.scopeKey);
  const empty = discover(f.home, { afterScopeKey: "f".repeat(64) });
  assert.ok(empty.ok);
  assert.deepEqual(empty.value, { scopes: [], issues: [] });
});

test("cold discovery rejects foreign identities and linked entries but ignores stale locator state", t => {
  const f = fixture(t), good = scope(f.home, path.join(f.root, "good")), foreign = scope(f.foreignHome, path.join(f.root, "foreign"));

  writeFileSync(good.locatorPath, "{");
  const wrongHome = scope(f.home, path.join(f.root, "wrong-home"));
  const changed = JSON.parse(readFileSync(wrongHome.intentPath, "utf8"));
  changed.homeRoot = f.foreignHome;
  writeFileSync(wrongHome.intentPath, JSON.stringify(changed));
  const linkedKey = "e".repeat(64);

  symlinkSync(foreign.directory, path.join(f.home, "learning", "runtime", linkedKey), process.platform === "win32" ? "junction" : "dir");
  const result = discover(f.home);
  assert.ok(result.ok);
  assert.deepEqual(result.value.scopes, [good]);
  assert.deepEqual(result.value.issues.map(item => item.scopeKey).sort(), [wrongHome.scopeKey, linkedKey].sort());
  assert.equal(readFileSync(good.locatorPath, "utf8"), "{");
});

test("a missing registry stays absent and invalid page requests fail before creating data", t => {
  const f = fixture(t);
  assert.deepEqual(discover(f.home), { ok: true, value: { scopes: [], issues: [] } });
  const invalidPages: NonNullable<Parameters<typeof discover>[1]>[] = [{ limit: 0 }, { limit: 65 }, { limit: 1.5 }, { afterScopeKey: "invalid" }];
  for (const options of invalidPages) {
    const invalid = discover(f.home, options);
    assert.equal(!invalid.ok && invalid.reason, "runtime_record_invalid");
  }
  assert.equal(discover("relative-home").ok, false);
  assert.equal(existsSync(f.home), false);
});
