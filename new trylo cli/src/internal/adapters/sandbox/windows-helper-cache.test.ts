import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cacheWindowsBytes, cacheWindowsHelper } from "./windows-helper-cache.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "trylo-native-cache-"));
  const path = join(root, "shipped.exe");
  const bytes = "public pinned helper fixture";
  writeFileSync(path, bytes);
  return { root, bytes, source: { path, sha256: createHash("sha256").update(bytes).digest("hex") }, directory: join(root, "private") };
}

test("a protected cache uses pinned bytes outside the source and validates reuse", () => {
  const fx = fixture();
  const events: string[] = [];
  try {
    const protect = (target: { kind: string; state: string }) => { events.push(`${target.kind}:${target.state}`); };
    const first = cacheWindowsHelper(fx.source, fx.directory, protect);
    assert.equal(readFileSync(first, "utf8"), fx.bytes);
    assert.notEqual(first, fx.source.path);
    assert.equal(cacheWindowsHelper(fx.source, fx.directory, protect), first);
    assert.deepEqual(events, ["directory:new", "executable:new", "directory:existing", "executable:existing"]);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test("modified source bytes fail before creating or protecting a cache", () => {
  const fx = fixture();
  try {
    writeFileSync(fx.source.path, "changed");
    assert.throws(() => cacheWindowsHelper(fx.source, fx.directory, () => assert.fail("must not protect")), /differs from provenance/);
    assert.equal(existsSync(fx.directory), false);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test("modified cache bytes are refused rather than overwritten or executed", () => {
  const fx = fixture();
  try {
    const cached = cacheWindowsHelper(fx.source, fx.directory, () => undefined);
    writeFileSync(cached, "modified");
    assert.throws(() => cacheWindowsHelper(fx.source, fx.directory, () => undefined), /modified/);
    assert.equal(readFileSync(cached, "utf8"), "modified");
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test("a redirected cache directory is refused before protection or writes", () => {
  const fx = fixture();
  try {
    const target = join(fx.root, "foreign");
    mkdirSync(target);
    symlinkSync(target, fx.directory, process.platform === "win32" ? "junction" : "dir");
    assert.throws(() => cacheWindowsHelper(fx.source, fx.directory, () => assert.fail("must not protect")), /redirected/);
    assert.equal(existsSync(join(target, `srt-win-${fx.source.sha256}.exe`)), false);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test("a hard-linked executable cannot change protection on a file outside the cache", () => {
  const fx = fixture();
  try {
    mkdirSync(fx.directory);
    linkSync(fx.source.path, join(fx.directory, `srt-win-${fx.source.sha256}.exe`));
    assert.throws(() => cacheWindowsHelper(fx.source, fx.directory, target => {
      if (target.kind === "executable") assert.fail("must not relabel a hard link");
    }), /linked|redirected/);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test("the host helper cannot be provisioned inside a granted write root", () => {
  const fx = fixture();
  try {
    assert.throws(() => Reflect.apply(cacheWindowsHelper, undefined, [fx.source, fx.directory, () => undefined, [fx.root]]), /write root|workspace/);
    assert.equal(existsSync(fx.directory), false);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test("captured bridge bytes do not re-read a source changed after admission", () => {
  const fx = fixture();
  try {
    const captured = readFileSync(fx.source.path);
    writeFileSync(fx.source.path, "untrusted replacement after admission");
    const cached = cacheWindowsBytes(captured, fx.source.sha256, fx.directory, "bridge.js", () => undefined);
    assert.equal(readFileSync(cached, "utf8"), fx.bytes);
    assert.throws(() => cacheWindowsBytes(Buffer.from("changed"), fx.source.sha256, fx.directory, "bridge.js", () => assert.fail("no protection on invalid input")), /invalid captured/);
    assert.throws(() => cacheWindowsBytes(captured, fx.source.sha256, fx.directory, "../outside.js", () => assert.fail("no traversal")), /invalid captured/);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});
