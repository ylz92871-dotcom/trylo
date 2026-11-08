import assert from "node:assert/strict";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { command, userRuleDraft } from "../../learning/control/fixtures.js";
import { createFileBoardStore } from "./file-event-store.js";
import { ownsLock, releaseLock, tryAcquireLock, type BoardLockOptions, type LockHandle } from "./lock.js";

function fixture(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "trylo-board-lock-"));
  return path.join(directory, "board-writer.lock");
}

function acquire(file: string, options: BoardLockOptions = {}): LockHandle {
  const result = tryAcquireLock(file, options);
  assert.equal("ok" in result, false, JSON.stringify(result));
  if ("ok" in result) throw new Error(result.detail);
  return result;
}

function stamp(file: string, pid: number, token = "old-owner-token"): void {
  writeFileSync(file, JSON.stringify({ formatVersion: 1, role: "writer", pid, token }));
}

function assertBusy(file: string, options: BoardLockOptions = {}, expected = "multi_writer"): void {
  const result = tryAcquireLock(file, options);
  assert.equal("ok" in result && result.reason, expected);
}

test("published lock has complete bounded identity before the writer becomes usable", () => {
  const file = fixture();
  let observed = false;
  const handle = acquire(file, { onStage(stage) {
    if (stage !== "writer_published") return;
    const value = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(value.role, "writer");
    assert.equal(value.pid, process.pid);
    assert.match(value.token, /^[a-zA-Z0-9-]{8,128}$/);
    observed = true;
  } });

  assert.equal(observed, true);
  assert.equal(ownsLock(handle), true);
  releaseLock(handle);
  releaseLock(handle);
  assert.equal(existsSync(file), false);
});

test("live, unknown and failed probes never reclaim the owner or change lock bytes", () => {
  for (const status of ["alive", "unknown"] as const) {
    const file = fixture();

    stamp(file, 42);
    const before = readFileSync(file, "utf8");

    assertBusy(file, { processStatus: () => status });
    assert.equal(readFileSync(file, "utf8"), before);
    assertBusy(file, { probe: () => { throw Object.assign(new Error("denied"), { code: "EPERM" }); } });
    assert.equal(readFileSync(file, "utf8"), before);
  }
});

test("only ESRCH automatically recovers a stamped owner; unsupported hardlinks fail closed", () => {
  const file = fixture();

  stamp(file, 42);
  const handle = acquire(file, { probe: (pid) => { if (pid === 42) throw Object.assign(new Error("gone"), { code: "ESRCH" }); } });

  assert.equal(ownsLock(handle), true);
  releaseLock(handle);
  assertBusy(file, { link: () => { throw Object.assign(new Error("unsupported"), { code: "ENOTSUP" }); } }, "board_unavailable");
  assert.equal(existsSync(file), false);
});

test("legacy empty, malformed, oversized and invalid identity require explicit manual recovery", () => {
  for (const value of ["", "17", "not-json", "x".repeat(2_049), JSON.stringify({ formatVersion: 1, role: "writer", pid: -1, token: "owner-token" })]) {
    const file = fixture();
    writeFileSync(file, value);
    const result = tryAcquireLock(file, { processStatus: () => "dead" });
    assert.equal("ok" in result && result.detail.includes("manual_recovery_required"), true);
    assert.equal(readFileSync(file, "utf8"), value);
  }
});

test("late stale release cannot remove a replacement owner and stale append never invokes IO", async () => {
  const file = fixture();
  const stale = acquire(file);

  unlinkSync(file);
  const replacement = acquire(file);
  const bytes = readFileSync(file, "utf8");

  releaseLock(stale);
  assert.equal(readFileSync(file, "utf8"), bytes);
  assert.equal(ownsLock(replacement), true);
  releaseLock(replacement);
  let appends = 0;
  const store = createFileBoardStore(path.dirname(file), { logAppender: () => { appends += 1; } });

  assert.equal("apply" in store, true);

  if (!("apply" in store)) return;

  unlinkSync(file);
  const next = acquire(file);
  const result = await store.apply(command("submit_proposal", { proposal: userRuleDraft({ proposalId: "p-fenced" }), commandId: "c-fenced" }));

  assert.equal(!result.ok && result.reason, "multi_writer");
  assert.equal(appends, 0);
  await store.close();
  assert.equal(ownsLock(next), true);
  releaseLock(next);
});

test("publication racing with a live recovery intent is unusable and cleanup cannot erase a later owner", () => {
  const file = fixture();
  const intent = `${file}.intent-live-intent-token`;
  const result = tryAcquireLock(file, { onStage(stage) {
    if (stage === "writer_published") writeFileSync(intent, JSON.stringify({ formatVersion: 1, role: "intent", pid: process.pid, token: "live-intent-token" }));
  } });

  assert.equal("ok" in result && result.reason, "multi_writer");
  assert.equal(existsSync(file), false);
  unlinkSync(intent);
  const next = acquire(file);

  releaseLock(next);
});

test("dead unique intents recover, alive or malformed intents block, prepared artifacts do not fence", () => {
  const file = fixture();
  const intent = `${file}.intent-dead-intent-token`;

  writeFileSync(intent, JSON.stringify({ formatVersion: 1, role: "intent", pid: 42, token: "dead-intent-token" }));
  assertBusy(file, { processStatus: () => "unknown" });
  const handle = acquire(file, { processStatus: (pid) => pid === 42 ? "dead" : "alive" });

  assert.equal(existsSync(intent), false);
  releaseLock(handle);
  writeFileSync(intent, "");
  assertBusy(file, { processStatus: () => "dead" });
  unlinkSync(intent);
  writeFileSync(path.join(path.dirname(file), ".board-writer.lock.intent-prepared.prepared-token"), "partial");
  const recovered = acquire(file);

  releaseLock(recovered);
});

test("all main deletion paths are enclosed by their actor's unique intent", () => {
  const file = fixture();

  stamp(file, 42);
  const stages: string[] = [];
  const handle = acquire(file, { processStatus: (pid) => pid === 42 ? "dead" : "alive", onStage(stage) {
    stages.push(stage);
    if (stage !== "writer_published") assert.equal(readdirSync(path.dirname(file)).some(name => name.startsWith("board-writer.lock.intent-")), true);
  } });

  releaseLock(handle);
  assert.deepEqual(stages, ["recovery_intent_published", "stale_lock_removed", "writer_published", "release_intent_published"]);
});

test("atomic publication uses a complete prepared file in the same directory", () => {
  const file = fixture();

  mkdirSync(path.dirname(file), { recursive: true });
  const handle = acquire(file, { link(source, target) {
    assert.equal(path.dirname(source), path.dirname(target));
    assert.equal(JSON.parse(readFileSync(source, "utf8")).formatVersion, 1);
    assert.equal(existsSync(target), false);
    linkSync(source, target);
  } });

  releaseLock(handle);
});
