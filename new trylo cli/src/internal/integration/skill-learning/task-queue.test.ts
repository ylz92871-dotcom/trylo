import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { createSkillTaskQueue, skillTaskQueueKey, SKILL_TASK_QUEUE_FILE, SKILL_TASK_QUEUE_LOCK, type SkillTaskQueueInput } from "./task-queue.js";

function metadata(turnId = "turn-1"): SkillTaskQueueInput {
  return { workspaceId: "workspace-a", sessionId: "session-a", turnId, fromSequence: 10, sourceSequence: 25,
    qualification: { kind: "external_check", ref: `execution:check:${turnId}`, outcome: "success", checks: [{ label: "existing exact report assertions", eventId: "check-call" }] },
    expectedFamily: { id: "json-report", intentClass: "normalize_report", checkKind: "acceptance", language: "json", checkSchema: "rows-v1" },
    checker: { id: "report-check", command: "node check.mjs", verifierFiles: { "check.mjs": contentHashOf("existing independent checker") } },
    usedSkill: { versionId: "skill-v1", variantId: "variant-v1", contentHash: contentHashOf("immutable method") },
    derivationKey: contentHashOf("journal-bound-input") };
}

function fixture(t: { after(fn: () => void): void }, maxAttempts = 3) {
  const root = mkdtempSync(path.join(os.tmpdir(), "trylo-task-intake-"));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("trylo-task-intake-"));
    rmSync(root, { recursive: true, force: true });
  });
  const options = { root, workspaceId: "workspace-a", collection: () => "enabled" as const, maxAttempts };
  return { root, file: path.join(root, SKILL_TASK_QUEUE_FILE), options, queue: createSkillTaskQueue(options) };
}

function enqueue(queue: ReturnType<typeof createSkillTaskQueue>, task = metadata()): string {
  const result = queue.enqueue(task);
  assert.ok(result.ok, JSON.stringify(result));
  assert.ok(result.key);
  return result.key;
}

test("intake stores only frozen recovery metadata and preserves exact usage attribution across restart", t => {
  const fx = fixture(t), task = metadata(), key = enqueue(fx.queue, task);

  assert.equal(key, skillTaskQueueKey(task));
  const replay = fx.queue.enqueue(task);
  assert.ok(replay.ok);
  assert.equal(replay.status, "duplicate");
  const recovered = createSkillTaskQueue(fx.options).pending({ limit: 1 });
  assert.ok(recovered.ok);
  assert.deepEqual(recovered.entries[0]?.task, task);
  assert.equal(recovered.entries[0]?.attempt, 0);
  const line = JSON.parse(readFileSync(fx.file, "utf8"));

  assert.equal(line.schemaVersion, 1);
  assert.equal(line.sequence, 1);
  assert.equal(readFileSync(fx.file, "utf8").includes("taskText"), false);
  assert.equal(readFileSync(fx.file, "utf8").includes("transcript"), false);
  const conflict = fx.queue.enqueue({ ...task, fromSequence: 11 });
  assert.equal(conflict.ok, false);

  if (!conflict.ok) assert.equal(conflict.code, "task_intake_conflict");

  assert.equal(readFileSync(fx.file, "utf8").trim().split("\n").length, 1);
});

test("pending is bounded and read-only; a grant can claim an item exactly once", t => {
  const fx = fixture(t), key = enqueue(fx.queue);

  enqueue(fx.queue, metadata("turn-2"));
  enqueue(fx.queue, metadata("turn-3"));
  const before = readFileSync(fx.file, "utf8");
  const pending = fx.queue.pending({ limit: 2 });
  assert.ok(pending.ok);
  assert.equal(pending.entries.length, 2);
  assert.equal(pending.totalPending, 3);
  assert.equal(readFileSync(fx.file, "utf8"), before);
  const tiny = fx.queue.pending({ limit: 2, maxBytes: 1 });
  assert.ok(tiny.ok);
  assert.equal(tiny.entries.length, 0);
  const claimed = fx.queue.claim(key, { retryRevision: "grant-1" });
  assert.ok(claimed.ok);
  assert.equal(claimed.status, "claimed");
  const replay = createSkillTaskQueue(fx.options).claim(key, { retryRevision: "grant-1" });
  assert.ok(replay.ok);
  assert.equal(replay.status, "already_claimed");
  const eligible = fx.queue.pending({ limit: 3, retryRevision: "grant-1" });
  assert.ok(eligible.ok);
  assert.equal(eligible.entries.some(entry => entry.key === key), false);
});

test("extraction failure and cancellation require a new grant revision and have a persistent attempt cap", t => {
  const fx = fixture(t), key = enqueue(fx.queue);

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const retryRevision = `grant-${attempt}`;
    const claim = createSkillTaskQueue(fx.options).claim(key, { retryRevision });
    assert.ok(claim.ok);
    assert.equal(claim.status, "claimed");
    assert.equal(claim.entry?.attempt, attempt);
    const result = { kind: attempt === 2 ? "cancelled" as const : "extraction_failure" as const, reason: "provider_usage_unknown" };
    assert.ok(fx.queue.ack(key, { attempt, retryRevision, result }).ok);
    const same = fx.queue.pending({ limit: 1, retryRevision });
    assert.ok(same.ok);
    assert.equal(same.entries.length, 0);
  }

  const restarted = createSkillTaskQueue({ ...fx.options, maxAttempts: 8 });
  const stopped = restarted.claim(key, { retryRevision: "grant-4" });
  assert.ok(stopped.ok);
  assert.equal(stopped.status, "waiting");
  const pending = restarted.pending({ limit: 1, retryRevision: "grant-4" });
  assert.ok(pending.ok);
  assert.equal(pending.entries.length, 0);
  assert.equal(pending.blocked, 1);
  assert.equal(stopped.entry?.lastFailure, "provider_usage_unknown");
});

test("a fact written before process exit can be acknowledged after restart without another model claim", t => {
  const fx = fixture(t), key = enqueue(fx.queue);
  const claim = fx.queue.claim(key, { retryRevision: "grant-1" });
  assert.ok(claim.ok);
  const restored = createSkillTaskQueue(fx.options), pending = restored.pending({ limit: 1, retryRevision: "grant-2" });
  assert.ok(pending.ok);
  assert.equal(pending.entries[0]?.state, "running");
  assert.equal(pending.entries[0]?.lastRevision, "grant-1");
  const result = { kind: "processed" as const, experienceId: "existing-qualified-episode", experienceHash: contentHashOf("persisted fact") };

  assert.ok(restored.ack(key, { attempt: 1, retryRevision: "grant-1", result }).ok);
  const duplicate = restored.ack(key, { attempt: 1, retryRevision: "grant-1", result });
  assert.ok(duplicate.ok);
  assert.equal(duplicate.status, "duplicate");
  const again = restored.pending({ limit: 1, retryRevision: "grant-3" });
  assert.ok(again.ok);
  assert.equal(again.entries.length, 0);
  const conflicting = restored.ack(key, { attempt: 1, retryRevision: "grant-1", result: { ...result, experienceId: "different-fact" } });
  assert.equal(conflicting.ok, false);
});

test("late extraction acknowledgements cannot settle a later attempt", t => {
  const fx = fixture(t), key = enqueue(fx.queue);
  fx.queue.claim(key, { retryRevision: "grant-1" });
  const restarted = fx.queue.claim(key, { retryRevision: "grant-2" });
  assert.ok(restarted.ok);
  assert.equal(restarted.entry?.attempt, 2);
  const late = fx.queue.ack(key, { attempt: 1, retryRevision: "grant-1", result: { kind: "processed", experienceId: "late-old-fact" } });
  assert.equal(late.ok, false);
  if (!late.ok) assert.equal(late.code, "task_intake_stale_ack");
});

test("the final running attempt remains inspectable for fact-written-before-ack recovery without another claim", t => {
  const fx = fixture(t, 1), key = enqueue(fx.queue);
  const claimed = fx.queue.claim(key, { retryRevision: "last-allowed-grant" });
  assert.ok(claimed.ok);
  assert.equal(claimed.status, "claimed");
  const defaultView = fx.queue.pending({ limit: 1, retryRevision: "new-grant" });
  assert.ok(defaultView.ok);
  assert.equal(defaultView.entries.length, 0);
  const recovered = createSkillTaskQueue(fx.options).pending({ limit: 1, retryRevision: "new-grant", includeRecovery: true });

  assert.ok(recovered.ok);
  assert.equal(recovered.entries.length, 1);
  assert.equal(recovered.entries[0]?.state, "running");
  assert.equal(recovered.entries[0]?.attempt, 1);
  const noRetry = fx.queue.claim(key, { retryRevision: "new-grant" });
  assert.ok(noRetry.ok);
  assert.equal(noRetry.status, "waiting");
  const ack = fx.queue.ack(key, { attempt: 1, retryRevision: "last-allowed-grant", result: { kind: "processed", experienceId: "already-persisted-fact" } });

  assert.ok(ack.ok);
  const finished = fx.queue.pending({ limit: 1, retryRevision: "new-grant", includeRecovery: true });
  assert.ok(finished.ok);
  assert.equal(finished.totalPending, 0);
});

test("recovery-only exhausted entries cannot starve a later claimable task", t => {
  const fx = fixture(t, 1), old = enqueue(fx.queue);
  fx.queue.claim(old, { retryRevision: "old-grant" });
  const fresh = enqueue(fx.queue, metadata("fresh-turn"));
  const pending = fx.queue.pending({ limit: 1, retryRevision: "fresh-grant", includeRecovery: true });
  assert.ok(pending.ok);
  assert.equal(pending.entries[0]?.key, fresh);
});

test("disabled collection performs no filesystem reads, creation or writes", t => {
  const fx = fixture(t), root = path.join(fx.root, "must-not-exist");
  const queue = createSkillTaskQueue({ ...fx.options, root, collection: () => "disabled" });

  assert.deepEqual(queue.enqueue({ taskText: "must not be inspected" }), { ok: true, status: "disabled" });
  assert.deepEqual(queue.pending({ limit: 1 }), { ok: true, entries: [], totalPending: 0, blocked: 0 });
  assert.deepEqual(queue.claim("irrelevant", { retryRevision: "grant" }), { ok: true, status: "disabled" });
  assert.deepEqual(queue.ack("irrelevant", { attempt: 1, retryRevision: "grant", result: { kind: "cancelled", reason: "cancelled" } }), { ok: true, status: "disabled" });
  assert.equal(existsSync(root), false);
  writeFileSync(fx.file, "corrupt-private-input", "utf8");
  assert.equal(createSkillTaskQueue({ ...fx.options, collection: () => "disabled" }).pending({ limit: 1 }).ok, true);
});

test("unknown or private payload fields and forged checker attribution are rejected before storage", t => {
  const fx = fixture(t), task = metadata();
  const invalid = [
    { ...task, taskText: "private task body" }, { ...task, transcript: [] }, { ...task, workspaceId: "other-workspace" },
    { ...task, sourceSequence: 1 }, { ...task, checker: { ...task.checker, permissionGranted: true } },
    { ...task, checker: { ...task.checker, verifierFiles: { "../outside": "a".repeat(64) } } },
    { ...task, checker: { ...task.checker, verifierFiles: { "checker.mjs": "not-a-hash" } } },
    { ...task, usedSkill: { versionId: "v1", variantId: "variant" } },
  ];

  for (const value of invalid) assert.equal(fx.queue.enqueue(value).ok, false);

  assert.equal(existsSync(fx.file), false);
});

test("schema, checksum, sequence, torn tail and event transitions fail closed", t => {
  const fx = fixture(t);
  enqueue(fx.queue);
  const original = readFileSync(fx.file, "utf8"), event = JSON.parse(original);
  const corruptions = [original.trimEnd(), original.replace("node check.mjs", "node changed.mjs"),
    `${canonicalJson({ ...event, schemaVersion: 2 })}\n`, `${canonicalJson({ ...event, sequence: 2 })}\n`, "{broken}\n"];

  for (const corrupted of corruptions) {
    writeFileSync(fx.file, corrupted, "utf8");
    assert.equal(fx.queue.pending({ limit: 1 }).ok, false);
    assert.equal(fx.queue.enqueue(metadata("other-turn")).ok, false);
    assert.equal(readFileSync(fx.file, "utf8"), corrupted);
    assert.equal(existsSync(path.join(fx.root, SKILL_TASK_QUEUE_LOCK)), false);
  }
});

test("queue capacity and another writer never silently discard recovery metadata", t => {
  const fx = fixture(t), queue = createSkillTaskQueue({ ...fx.options, limits: { maxRecords: 1 } });

  enqueue(queue);
  assert.equal(queue.enqueue(metadata("overflow-turn")).ok, false);
  assert.equal(queue.enqueue(metadata()).ok, true);
  const before = readFileSync(fx.file, "utf8");

  writeFileSync(path.join(fx.root, SKILL_TASK_QUEUE_LOCK), "other-writer", "utf8");
  const blocked = fx.queue.claim(skillTaskQueueKey(metadata()), { retryRevision: "new-grant" });

  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.equal(blocked.code, "task_intake_locked");

  assert.equal(readFileSync(fx.file, "utf8"), before);
  assert.equal(readFileSync(path.join(fx.root, SKILL_TASK_QUEUE_LOCK), "utf8"), "other-writer");
});
