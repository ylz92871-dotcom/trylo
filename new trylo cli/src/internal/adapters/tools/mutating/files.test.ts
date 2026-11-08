import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createWorkspaceSandbox } from "../../sandbox/index.js";
import { createSandboxPolicy } from "../../sandbox/policy.js";
import { createNodeFileSystemReader } from "../read-only/node-fs.js";
import { createMutatingTools } from "./index.js";
import { EDIT_FILE_TOOL, WRITE_FILE_TOOL } from "./names.js";

/**
 * H3: writes are atomic and refusals leave no trace.
 *
 * Every assertion about refusal also asserts what the disk looks like
 * afterwards, because "we returned an error" and "nothing happened" are two
 * claims and only the second one is what actually matters.
 */

function tempRoot(): string {
  return mkdtempSync(join(os.tmpdir(), "trylo-write-"));
}

function toolsFor(root: string, maxWriteBytes = 1024) {
  const sandbox = createWorkspaceSandbox({ workspaceRoot: root, maxWriteBytes });
  return createMutatingTools({ sandbox });
}

const SIGNAL = new AbortController().signal;

test("write_file creates missing parent directories and writes the nested file", async () => {
  const root = tempRoot();
  try {
    const tools = toolsFor(root);
    const created = await tools.execute(
      { toolCallId: "c2", name: WRITE_FILE_TOOL, arguments: { path: "notes/deep/a.txt", content: "hello" } },
      SIGNAL,
    );

    assert.equal(created.outcome, "result");

    if (created.outcome === "result") {
      assert.equal(created.value.mode, "created");
    }

    assert.equal(readFileSync(join(root, "notes", "deep", "a.txt"), "utf8"), "hello");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("creating parents never follows a symlinked directory out of the workspace", async (t) => {
  const root = tempRoot();
  const outside = tempRoot();

  try {
    try {
      symlinkSync(outside, join(root, "link"), "dir");
    } catch {
      t.skip("the platform refused to create the symlink, so this escape case cannot run here");
      return;
    }

    const outcome = await toolsFor(root).execute(
      { toolCallId: "c", name: WRITE_FILE_TOOL, arguments: { path: "link/sub/x.txt", content: "x" } },
      SIGNAL,
    );

    assert.equal(outcome.outcome, "error");

    if (outcome.outcome === "error") {
      assert.equal(outcome.code, "path_escapes_via_link");
    }

    assert.deepEqual(readdirSync(root), ["link"]);
    assert.deepEqual(readdirSync(outside), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("a second write reports itself as an overwrite rather than a creation", async () => {
  const root = tempRoot();
  try {
    const tools = toolsFor(root);

    writeFileSync(join(root, "a.txt"), "old");
    const outcome = await tools.execute(
      { toolCallId: "c1", name: WRITE_FILE_TOOL, arguments: { path: "a.txt", content: "brand new" } },
      SIGNAL,
    );

    assert.equal(outcome.outcome, "result");

    if (outcome.outcome === "result") {
      assert.equal(outcome.value.mode, "overwritten");
      assert.equal(outcome.value.bytes, 9);
    }

    assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "brand new");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a refused write leaves the filesystem exactly as it was", async () => {
  const root = tempRoot();
  const outside = tempRoot();

  try {
    writeFileSync(join(outside, "target.txt"), "outside content");
    const tools = toolsFor(root);
    const attempts: ReadonlyArray<Record<string, string>> = [
      { path: "../escape.txt", content: "x" },
      { path: "C:/Windows/win.ini", content: "x" },
      { path: "a/../../escape.txt", content: "x" },
      { path: "NUL", content: "x" },
      { path: "has\0inside.txt", content: "x" },
    ];

    for (const args of attempts) {
      const outcome = await tools.execute({ toolCallId: "c", name: WRITE_FILE_TOOL, arguments: args }, SIGNAL);
      assert.equal(outcome.outcome, "error", JSON.stringify(args));
    }

    assert.deepEqual(readdirSync(root), []);
    assert.deepEqual(readdirSync(outside), ["target.txt"]);
    assert.equal(readFileSync(join(outside, "target.txt"), "utf8"), "outside content");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("writing through a link that leaves the workspace never reaches the target", async (t) => {
  const root = tempRoot();
  const outside = tempRoot();

  try {
    writeFileSync(join(outside, "target.txt"), "original");
    let linked = true;

    try {
      symlinkSync(join(outside, "target.txt"), join(root, "alias.txt"), "file");
    } catch {
      linked = false;
    }

    if (linked === false) {
      t.skip("the platform refused to create the symlink, so this escape case cannot run here");
      return;
    }

    const outcome = await toolsFor(root).execute(
      { toolCallId: "c", name: WRITE_FILE_TOOL, arguments: { path: "alias.txt", content: "hijacked" } },
      SIGNAL,
    );

    assert.equal(outcome.outcome, "error");

    if (outcome.outcome === "error") {
      assert.equal(outcome.code, "path_escapes_via_link");
    }

    assert.equal(readFileSync(join(outside, "target.txt"), "utf8"), "original");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("an oversized write is refused, not truncated into a shorter file", async () => {
  const root = tempRoot();
  try {
    const tools = toolsFor(root, 8);
    const outcome = await tools.execute(
      { toolCallId: "c", name: WRITE_FILE_TOOL, arguments: { path: "big.txt", content: "x".repeat(9) } },
      SIGNAL,
    );

    assert.equal(outcome.outcome, "error");

    if (outcome.outcome === "error") {
      assert.equal(outcome.code, "write_too_large");
    }

    assert.deepEqual(readdirSync(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("two writers to one path never interleave half frames", async () => {
  const root = tempRoot();
  try {
    const tools = toolsFor(root, 1_048_576);
    const first = "a".repeat(4096);
    const second = "b".repeat(4096);
    const [left, right] = await Promise.all([
      tools.execute({ toolCallId: "c1", name: WRITE_FILE_TOOL, arguments: { path: "race.txt", content: first } }, SIGNAL),
      tools.execute({ toolCallId: "c2", name: WRITE_FILE_TOOL, arguments: { path: "race.txt", content: second } }, SIGNAL),
    ]);

    assert.equal(left.outcome, "result");
    assert.equal(right.outcome, "result");
    const content = readFileSync(join(root, "race.txt"), "utf8");
    const whole = content === first || content === second;

    assert.equal(whole, true, `content length ${content.length}`);
    assert.deepEqual(readdirSync(root).sort(), ["race.txt"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("edit_file replaces exactly what the hunk describes", async () => {
  const root = tempRoot();
  try {
    writeFileSync(join(root, "poem.txt"), "one\ntwo\nthree\n");
    const tools = toolsFor(root);
    const outcome = await tools.execute(
      {
        toolCallId: "c",
        name: EDIT_FILE_TOOL,
        arguments: {
          path: "poem.txt",
          patch: "--- a/poem.txt\n+++ b/poem.txt\n@@ -1,3 +1,3 @@\n one\n-two\n+deux\n three\n",
        },
      },
      SIGNAL,
    );

    assert.equal(outcome.outcome, "result");

    if (outcome.outcome === "result") {
      assert.equal(outcome.value.hunksApplied, 1);
    }

    assert.equal(readFileSync(join(root, "poem.txt"), "utf8"), "one\ndeux\nthree\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a hunk that does not match restores the file byte for byte", async () => {
  const root = tempRoot();
  try {
    const before = "alpha\nbeta\ngamma\n";

    writeFileSync(join(root, "words.txt"), before);
    const tools = toolsFor(root);
    const outcome = await tools.execute(
      {
        toolCallId: "c",
        name: EDIT_FILE_TOOL,
        arguments: {
          path: "words.txt",
          patch: "--- a/words.txt\n+++ b/words.txt\n@@ -1,3 +1,3 @@\n alpha\n-missing\n+replacement\n gamma\n",
        },
      },
      SIGNAL,
    );

    assert.equal(outcome.outcome, "error");

    if (outcome.outcome === "error") {
      assert.equal(outcome.code, "patch_hunk_mismatch");
      assert.match(outcome.message, /hunk 0/);
    }

    assert.equal(readFileSync(join(root, "words.txt"), "utf8"), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a patch describing a second file is refused before the first is touched", async () => {
  const root = tempRoot();
  try {
    const before = "keep\n";

    writeFileSync(join(root, "stay.txt"), before);
    const tools = toolsFor(root);
    const outcome = await tools.execute(
      {
        toolCallId: "c",
        name: EDIT_FILE_TOOL,
        arguments: {
          path: "stay.txt",
          patch: "--- a/stay.txt\n+++ b/stay.txt\n@@ -1 +1 @@\n-keep\n+changed\n--- a/other.txt\n+++ b/other.txt\n@@ -1 +1 @@\n-a\n+b\n",
        },
      },
      SIGNAL,
    );

    assert.equal(outcome.outcome, "error");

    if (outcome.outcome === "error") {
      assert.equal(outcome.code, "patch_parse_failed");
    }

    assert.equal(readFileSync(join(root, "stay.txt"), "utf8"), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("edit_file refuses a target outside the workspace and does not create it", async () => {
  const root = tempRoot();
  const outside = tempRoot();

  try {
    const outcome = await toolsFor(root).execute(
      {
        toolCallId: "c",
        name: EDIT_FILE_TOOL,
        arguments: { path: "../outside.txt", patch: "@@ -1 +1 @@\n-a\n+b\n" },
      },
      SIGNAL,
    );

    assert.equal(outcome.outcome, "error");

    if (outcome.outcome === "error") {
      assert.equal(outcome.code, "path_outside_workspace");
    }

    assert.deepEqual(readdirSync(outside), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("a successful mutation carries the file_write effect the journal records", async () => {
  const root = tempRoot();
  try {
    const outcome = await toolsFor(root).execute(
      { toolCallId: "c", name: WRITE_FILE_TOOL, arguments: { path: "effect.txt", content: "abc" } },
      SIGNAL,
    );

    assert.equal(outcome.outcome, "result");

    if (outcome.outcome === "result") {
      const effect = outcome.value.fileWrite;
      assert.deepEqual(effect, { kind: "file_write", path: "effect.txt", bytes: 3, mode: "created" });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a tool denied by the permission cache disappears from the catalog", () => {
  const root = tempRoot();
  try {
    const sandbox = createWorkspaceSandbox({ workspaceRoot: root });
    const visible = createMutatingTools({ sandbox });
    assert.equal(visible.snapshot().map((binding) => binding.name).includes(WRITE_FILE_TOOL), true);
    const hidden = createMutatingTools({ sandbox, visibility: { isDenied: (name) => name === WRITE_FILE_TOOL } });
    assert.equal(hidden.snapshot().map((binding) => binding.name).includes(WRITE_FILE_TOOL), false);
    assert.equal(hidden.snapshot().length, visible.snapshot().length - 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("read-only tools still work through the shared workspace resolver", async () => {
  const root = tempRoot();
  try {
    writeFileSync(join(root, "seen.txt"), "still readable");
    const { createReadOnlyTools } = await import("../read-only/index.js");
    const tools = createReadOnlyTools({ workspaceRoot: root, reader: createNodeFileSystemReader() });
    const outcome = await tools.execute(
      { toolCallId: "c", name: "read_file", arguments: { path: "seen.txt" } },
      SIGNAL,
    );

    assert.equal(outcome.outcome, "result");

    if (outcome.outcome === "result") {
      assert.equal(outcome.value.content, "still readable");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the sandbox policy is the single source for the write ceiling", () => {
  const root = tempRoot();
  try {
    assert.equal(createSandboxPolicy({ workspaceRoot: root }).maxWriteBytes, 1_048_576);
    assert.equal(createSandboxPolicy({ workspaceRoot: root, maxWriteBytes: 12 }).maxWriteBytes, 12);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
