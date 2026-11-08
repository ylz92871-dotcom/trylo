import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createWorkspaceSandbox } from "../../sandbox/index.js";
import { createWriteQueue, type WriteQueue } from "./atomic-write.js";
import { createMutatingTools } from "./index.js";
import { APPLY_PATCH_TOOL } from "./names.js";

/**
 * WP10 end-to-end at the tool boundary: one patch, many files, sequential
 * commits with an explicit partial delta on failure. Every refusal also
 * asserts the disk afterwards — "returned an error" is not "nothing happened".
 */

function tempRoot(): string {
  return mkdtempSync(join(os.tmpdir(), "trylo-apply-patch-"));
}

function toolsFor(root: string) {
  const sandbox = createWorkspaceSandbox({ workspaceRoot: root });
  return createMutatingTools({ sandbox });
}

const SIGNAL = new AbortController().signal;

function applyPatch(tools: ReturnType<typeof toolsFor>, patch: string, signal: AbortSignal = SIGNAL) {
  return tools.execute({ toolCallId: "c-apply", name: APPLY_PATCH_TOOL, arguments: { patch } }, signal);
}

test("one patch adds, updates, deletes and moves, and every file fact is reported", async () => {
  const root = tempRoot();
  try {
    writeFileSync(join(root, "keep.ts"), "old\n");
    writeFileSync(join(root, "gone.txt"), "bye\n");
    writeFileSync(join(root, "src.txt"), "line\n");
    const patch = [
      "*** Begin Patch",
      "*** Add File: new.txt",
      "+hello",
      "*** Update File: keep.ts",
      "@@",
      "-old",
      "+new",
      "*** Delete File: gone.txt",
      "*** Update File: src.txt",
      "*** Move to: dst.txt",
      "@@",
      "-line",
      "+line2",
      "*** End Patch",
    ].join("\n");
    const outcome = await applyPatch(toolsFor(root), patch);

    assert.equal(outcome.outcome, "result");

    if (outcome.outcome !== "result") {
      return;
    }

    assert.equal(readFileSync(join(root, "new.txt"), "utf8"), "hello\n");
    assert.equal(readFileSync(join(root, "keep.ts"), "utf8"), "new\n");
    assert.equal(readFileSync(join(root, "dst.txt"), "utf8"), "line2\n");
    const value = outcome.value as { applied: Array<{ op: string; path: string }>; exact: boolean };

    assert.equal(value.exact, true);
    assert.deepEqual(
      value.applied.map((entry) => `${entry.op}:${entry.path}`),
      ["added:new.txt", "updated:keep.ts", "deleted:gone.txt", "moved:dst.txt"],
    );
    const facts = outcome.value["fileWrites"];

    assert.ok(Array.isArray(facts));
    assert.equal(facts.length, 4);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a later mismatch keeps the earlier file and names both sides", async () => {
  const root = tempRoot();
  try {
    writeFileSync(join(root, "first.txt"), "one\n");
    writeFileSync(join(root, "second.txt"), "two\n");
    const patch = [
      "*** Begin Patch",
      "*** Update File: first.txt",
      "@@",
      "-one",
      "+ONE",
      "*** Update File: second.txt",
      "@@",
      "-absent",
      "+TWO",
      "*** End Patch",
    ].join("\n");
    const outcome = await applyPatch(toolsFor(root), patch);

    assert.equal(outcome.outcome, "error");

    if (outcome.outcome !== "error") {
      return;
    }

    assert.equal(outcome.code, "patch_hunk_mismatch");
    assert.match(outcome.message, /first\.txt/);
    assert.match(outcome.message, /second\.txt/);
    assert.equal(readFileSync(join(root, "first.txt"), "utf8"), "ONE\n");
    assert.equal(readFileSync(join(root, "second.txt"), "utf8"), "two\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a path escape is refused before the first file is touched", async () => {
  const root = tempRoot();
  try {
    writeFileSync(join(root, "stay.txt"), "keep\n");
    const patch = [
      "*** Begin Patch",
      "*** Update File: stay.txt",
      "@@",
      "-keep",
      "+changed",
      "*** Add File: ../escape.txt",
      "+x",
      "*** End Patch",
    ].join("\n");
    const outcome = await applyPatch(toolsFor(root), patch);

    assert.equal(outcome.outcome, "error");

    if (outcome.outcome !== "error") {
      return;
    }

    assert.match(outcome.code, /path_outside_workspace|invalid_path/);
    assert.equal(readFileSync(join(root, "stay.txt"), "utf8"), "keep\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an empty patch is refused as empty, not applied as nothing", async () => {
  const root = tempRoot();
  try {
    const outcome = await applyPatch(toolsFor(root), "*** Begin Patch\n*** End Patch");
    assert.equal(outcome.outcome, "error");
    if (outcome.outcome !== "error") {
      return;
    }
    assert.equal(outcome.code, "empty_patch");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a cancel after the first commit keeps the delta instead of dropping it", async () => {
  const root = tempRoot();
  try {
    writeFileSync(join(root, "a.txt"), "a\n");
    writeFileSync(join(root, "b.txt"), "b\n");
    const controller = new AbortController();
    const inner = createWriteQueue();
    let commits = 0;
    const aborting: WriteQueue = {
      exclusive: (absolutePath, job) =>
        inner.exclusive(absolutePath, async () => {
          const out = await job();
          commits += 1;
          if (commits === 1) {
            controller.abort();
          }
          return out;
        }),
    };
    const sandbox = createWorkspaceSandbox({ workspaceRoot: root });
    const tools = createMutatingTools({ sandbox, writeQueue: aborting });
    const patch = [
      "*** Begin Patch",
      "*** Update File: a.txt",
      "@@",
      "-a",
      "+A",
      "*** Update File: b.txt",
      "@@",
      "-b",
      "+B",
      "*** End Patch",
    ].join("\n");
    const outcome = await tools.execute(
      { toolCallId: "c-apply", name: APPLY_PATCH_TOOL, arguments: { patch } },
      controller.signal,
    );

    // Not cancelled-silently: the landed file must be named in the record.
    assert.equal(outcome.outcome, "error");

    if (outcome.outcome !== "error") {
      return;
    }

    assert.equal(outcome.code, "apply_cancelled");
    assert.match(outcome.message, /a\.txt/);
    assert.match(outcome.message, /b\.txt/);
    assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "A\n");
    assert.equal(readFileSync(join(root, "b.txt"), "utf8"), "b\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an aborted call reports cancelled and leaves the disk untouched", async () => {
  const root = tempRoot();
  try {
    writeFileSync(join(root, "a.txt"), "a\n");
    const controller = new AbortController();
    controller.abort();
    const outcome = await applyPatch(toolsFor(root), "*** Begin Patch\n*** End Patch", controller.signal);
    assert.equal(outcome.outcome, "cancelled");
    assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "a\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("read_only and deny_all refuse the patch before anything is parsed", async () => {
  const root = tempRoot();
  try {
    writeFileSync(join(root, "a.txt"), "a\n");
    const patch = ["*** Begin Patch", "*** Add File: new.txt", "+x", "*** End Patch"].join("\n");

    for (const mode of ["read_only", "deny_all"] as const) {
      const sandbox = createWorkspaceSandbox({ workspaceRoot: root, mode });
      const tools = createMutatingTools({ sandbox });
      const outcome = await applyPatch(tools, patch);

      assert.equal(outcome.outcome, "error");

      if (outcome.outcome !== "error") {
        continue;
      }

      assert.ok(outcome.code === "sandbox_read_only" || outcome.code === "sandbox_deny_all", outcome.code);
    }

    assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "a\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a CRLF file keeps CRLF through an update", async () => {
  const root = tempRoot();
  try {
    writeFileSync(join(root, "dos.txt"), "one\r\ntwo\r\n");
    const patch = ["*** Begin Patch", "*** Update File: dos.txt", "@@", "-two", "+deux", "*** End Patch"].join("\n");
    const outcome = await applyPatch(toolsFor(root), patch);
    assert.equal(outcome.outcome, "result");
    assert.equal(readFileSync(join(root, "dos.txt"), "utf8"), "one\r\ndeux\r\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("concurrent patches to one file never lose an update silently", async () => {
  const root = tempRoot();
  try {
    writeFileSync(join(root, "race.txt"), "base\n");
    const tools = toolsFor(root);
    const first = ["*** Begin Patch", "*** Update File: race.txt", "@@", "-base", "+first", "*** End Patch"].join("\n");
    const second = ["*** Begin Patch", "*** Update File: race.txt", "@@", "-base", "+second", "*** End Patch"].join("\n");
    // Deterministic by construction: both prepares read synchronously before
    // either queued commit runs, so the loser always trips the compare in
    // commitText rather than the prepare-time match.
    const [left, right] = await Promise.all([applyPatch(tools, first), applyPatch(tools, second)]);
    const content = readFileSync(join(root, "race.txt"), "utf8");

    assert.ok(content === "first\n" || content === "second\n");
    const loser = content === "first\n" ? right : left;
    const winner = content === "first\n" ? left : right;

    assert.equal(winner.outcome, "result");
    assert.equal(loser.outcome, "error");

    if (loser.outcome !== "error") {
      return;
    }

    assert.equal(loser.code, "file_changed_since_read");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
