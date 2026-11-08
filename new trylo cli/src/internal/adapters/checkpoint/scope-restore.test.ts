import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyScopedPlan,
  diffSnapshot,
  planScopedRestore,
  type CurrentRow,
  type ScopedPlan,
  type SnapshotRow,
} from "./scope-restore.js";

/**
 * WP11.2 (L37): scoped comparison and rewind.
 *
 * Red evidence: new module (import fails pre-WP11). Behavioural red was
 * shown by making `planScopedRestore` fall back to full-tree removal of
 * unknown files: `user files outside scope are kept` goes red.
 */

const SNAPSHOT: ReadonlyArray<SnapshotRow> = [
  { path: "a.ts", sha256: "aaa", bytes: 10 },
  { path: "b.ts", sha256: "bbb", bytes: 20 },
  { path: "gone.ts", sha256: "ggg", bytes: 5 },
];

const CURRENT: ReadonlyArray<CurrentRow> = [
  { path: "a.ts", sha256: "aaa", bytes: 10 },
  { path: "b.ts", sha256: "b2b2", bytes: 22 },
  { path: "mine.ts", sha256: "mmm", bytes: 7 },
];

test("diffSnapshot splits added, removed, modified and unchanged", () => {
  const diff = diffSnapshot(SNAPSHOT, CURRENT);
  assert.deepEqual(diff.added, [{ path: "mine.ts", bytes: 7 }]);
  assert.deepEqual(diff.removed, [{ path: "gone.ts", bytes: 5 }]);
  assert.deepEqual(diff.modified, [{ path: "b.ts", beforeBytes: 20, afterBytes: 22 }]);
  assert.equal(diff.unchangedCount, 1);
});

test("scoped plan only touches the scope", () => {
  const outcome = planScopedRestore({ snapshot: SNAPSHOT, current: CURRENT, scope: ["b.ts"] });

  assert.equal(outcome.ok, true);

  if (!outcome.ok) {
    return;
  }

  assert.deepEqual(outcome.plan.writes, [{ action: "overwrite", path: "b.ts", bytes: 20 }]);
  assert.deepEqual(outcome.plan.removals, []);
  assert.deepEqual(outcome.plan.alreadyCurrent, []);
  assert.ok(outcome.plan.keptOutsideScope.includes("mine.ts"));
  assert.ok(outcome.plan.keptOutsideScope.includes("a.ts"));
});

test("user files outside scope are kept, never removed", () => {
  const outcome = planScopedRestore({ snapshot: SNAPSHOT, current: CURRENT, scope: ["a.ts", "b.ts"] });

  assert.equal(outcome.ok, true);

  if (!outcome.ok) {
    return;
  }

  const touched = [...outcome.plan.writes.map((write) => write.path), ...outcome.plan.removals.map((removal) => removal.path)];

  assert.ok(!touched.includes("mine.ts"));
  assert.ok(outcome.plan.keptOutsideScope.includes("mine.ts"));
});

test("recreate and explicit-scope removal", () => {
  const outcome = planScopedRestore({ snapshot: SNAPSHOT, current: CURRENT, scope: ["gone.ts", "mine.ts"] });

  assert.equal(outcome.ok, true);

  if (!outcome.ok) {
    return;
  }

  assert.deepEqual(outcome.plan.writes, [{ action: "recreate", path: "gone.ts", bytes: 5 }]);
  assert.deepEqual(outcome.plan.removals, [{ action: "remove", path: "mine.ts" }]);
});

test("identical scope paths are reported current, unknown paths refused", () => {
  const same = planScopedRestore({ snapshot: SNAPSHOT, current: CURRENT, scope: ["a.ts"] });

  assert.equal(same.ok, true);

  if (same.ok) {
    assert.deepEqual(same.plan.alreadyCurrent, ["a.ts"]);
    assert.deepEqual(same.plan.writes, []);
  }

  const unknown = planScopedRestore({ snapshot: SNAPSHOT, current: CURRENT, scope: ["nope.ts"] });

  assert.equal(unknown.ok, false);
  const empty = planScopedRestore({ snapshot: SNAPSHOT, current: CURRENT, scope: [] });

  assert.equal(empty.ok, false);
});

test("applyScopedPlan replaces before removing and reports partial progress", async () => {
  const plan: ScopedPlan = {
    writes: [{ action: "overwrite", path: "b.ts", bytes: 20 }],
    removals: [{ action: "remove", path: "mine.ts" }],
    alreadyCurrent: [],
    keptOutsideScope: ["a.ts"],
  };
  const order: string[] = [];
  const outcome = await applyScopedPlan(plan, {
    async readSnapshot(path): Promise<Uint8Array> {
      order.push(`read:${path}`);
      return new TextEncoder().encode("old");
    },
    async writeFile(path): Promise<void> {
      order.push(`write:${path}`);
    },
    async removeFile(path): Promise<void> {
      order.push(`remove:${path}`);
    },
  });

  assert.deepEqual(outcome, { ok: true, value: { restoredFiles: 1, removedFiles: 1 } });
  assert.deepEqual(order, ["read:b.ts", "write:b.ts", "remove:mine.ts"]);
});

test("a write failure stops the plan and reports what landed", async () => {
  const plan: ScopedPlan = {
    writes: [
      { action: "overwrite", path: "b.ts", bytes: 20 },
      { action: "recreate", path: "gone.ts", bytes: 5 },
    ],
    removals: [{ action: "remove", path: "mine.ts" }],
    alreadyCurrent: [],
    keptOutsideScope: [],
  };
  const outcome = await applyScopedPlan(plan, {
    async readSnapshot(path): Promise<Uint8Array> {
      if (path === "gone.ts") {
        throw new Error("snapshot block unreadable");
      }
      return new TextEncoder().encode("old");
    },
    async writeFile(): Promise<void> {
    },
    async removeFile(): Promise<void> {
      assert.fail("removals must not run after a write failure");
    },
  });

  assert.equal(outcome.ok, false);

  if (!outcome.ok) {
    assert.equal(outcome.code, "restore_interrupted");
    assert.deepEqual(outcome.completed, { restoredFiles: 1, removedFiles: 0 });
  }
});
