import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createReadOnlyTools } from "./index.js";
import { createNodeFileSystemReader } from "./node-fs.js";
import { resolveInsideWorkspace } from "./workspace.js";

/**
 * Workspace containment is the boundary that keeps a read-only tool read-only.
 * These cases are adversarial on purpose: each one is a way a lexical check
 * alone would pass while the real path escapes.
 */

function tempRoot(): string {
  return mkdtempSync(join(os.tmpdir(), "trylo-workspace-"));
}

test("absolute paths, parent escapes and device paths are refused", () => {
  const root = tempRoot();
  try {
    const cases: ReadonlyArray<[string, string]> = [
      ["C:/Windows/win.ini", "path_outside_workspace"],
      ["/etc/passwd", "path_outside_workspace"],
      ["../../secret.txt", "path_outside_workspace"],
      ["a/../../secret.txt", "path_outside_workspace"],
      ["\\\\.\\PhysicalDrive0", "path_outside_workspace"],
      ["CON", "path_outside_workspace"],
      ["nul", "path_outside_workspace"],
      ["", "invalid_path"],
    ];
    for (const [candidate, code] of cases) {
      const verdict = resolveInsideWorkspace(root, candidate);
      assert.equal(verdict.ok, false, candidate);
      if (!verdict.ok) {
        assert.equal(verdict.code, code, candidate);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an in-workspace path stays accepted", () => {
  const root = tempRoot();
  try {
    writeFileSync(join(root, "note.txt"), "hello");
    const verdict = resolveInsideWorkspace(root, "note.txt");
    assert.equal(verdict.ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * A link inside the workspace that points outside it must be refused by the
 * real-path check. Junctions are used on Windows because they do not require
 * elevation; POSIX uses a plain directory symlink.
 */
test("a link that escapes the workspace is refused", (t) => {
  const root = tempRoot();
  const outside = tempRoot();

  try {
    writeFileSync(join(outside, "secret.txt"), "should not be readable");
    const link = join(root, "escape-link");

    try {
      symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
    } catch {
      // The platform refused to create any link: containment of the lexical
      // path is still asserted elsewhere, and inventing a pass would be worse.
      t.skip("the platform refused to create the symlink, so this escape case cannot run here");
      return;
    }

    const verdict = resolveInsideWorkspace(root, "escape-link/secret.txt");

    assert.equal(verdict.ok, false);

    if (!verdict.ok) {
      assert.equal(verdict.code, "path_escapes_via_link");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("a missing file inside the workspace is a read error, not a link refusal", async () => {
  // The real-path check falls back to the lexical path only when the target is
  // absent. A missing file must still surface as an honest read failure, never
  // as a containment breach, or the fallback would have hidden a real escape.
  const root = tempRoot();
  try {
    const verdict = resolveInsideWorkspace(root, "absent.txt");

    assert.equal(verdict.ok, true);
    const tools = createReadOnlyTools({ workspaceRoot: root, reader: createNodeFileSystemReader() });
    const outcome = await tools.execute(
      { toolCallId: "c1", name: "read_file", arguments: { path: "absent.txt" } },
      new AbortController().signal,
    );

    assert.equal(outcome.outcome, "error");

    if (outcome.outcome === "error") {
      assert.equal(outcome.code, "read_failed");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a link that cannot be resolved is refused rather than trusted lexically", (t) => {
  // A self-referential link makes realpath fail for a reason other than
  // "missing". Containment is then unproven, so the verdict must be a refusal.
  const root = tempRoot();
  try {
    const link = join(root, "loop");

    try {
      symlinkSync("loop", link, process.platform === "win32" ? "file" : undefined);
    } catch {
      // The platform refused to create the link; nothing to assert here.
      t.skip("the platform refused to create the symlink, so this escape case cannot run here");
      return;
    }

    const verdict = resolveInsideWorkspace(root, "loop");

    assert.equal(verdict.ok, false);

    if (!verdict.ok) {
      assert.equal(verdict.code, "path_unverifiable");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("read_file refuses an escaping link instead of following it", async (t) => {
  const root = tempRoot();
  const outside = tempRoot();

  try {
    mkdirSync(join(root, "sub"), { recursive: true });
    writeFileSync(join(outside, "secret.txt"), "should not be readable");
    const link = join(root, "sub", "escape");

    try {
      symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
    } catch {
      t.skip("the platform refused to create the symlink, so this escape case cannot run here");
      return;
    }

    const tools = createReadOnlyTools({ workspaceRoot: root, reader: createNodeFileSystemReader() });
    const outcome = await tools.execute(
      { toolCallId: "c1", name: "read_file", arguments: { path: "sub/escape/secret.txt" } },
      new AbortController().signal,
    );

    assert.equal(outcome.outcome, "error");

    if (outcome.outcome === "error") {
      assert.equal(outcome.code, "path_escapes_via_link");
      assert.equal(outcome.message.includes("should not be readable"), false);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("an aborted signal is a cancellation, never a tool failure", async () => {
  const root = tempRoot();
  try {
    writeFileSync(join(root, "big.txt"), "x".repeat(1024));
    const tools = createReadOnlyTools({ workspaceRoot: root, reader: createNodeFileSystemReader() });
    const controller = new AbortController();

    controller.abort();
    const outcome = await tools.execute(
      { toolCallId: "c1", name: "read_file", arguments: { path: "big.txt" } },
      controller.signal,
    );

    assert.equal(outcome.outcome, "cancelled");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("oversized output is truncated with metadata, not reported as a failure", async () => {
  const root = tempRoot();
  try {
    writeFileSync(join(root, "huge.txt"), "line\n".repeat(60_000));
    const tools = createReadOnlyTools({ workspaceRoot: root, reader: createNodeFileSystemReader() });
    const outcome = await tools.execute(
      { toolCallId: "c1", name: "read_file", arguments: { path: "huge.txt" } },
      new AbortController().signal,
    );

    assert.equal(outcome.outcome, "result");

    if (outcome.outcome === "result") {
      assert.equal(outcome.truncated, true);
      assert.equal(Buffer.byteLength(outcome.output, "utf8") <= 65_536, true);
      assert.equal(outcome.value.truncated, true);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("search_text never descends into excluded vendored directories", async () => {
  const root = tempRoot();
  try {
    mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(root, "node_modules", "pkg", "index.js"), "NEEDLE");
    writeFileSync(join(root, "app.ts"), "NEEDLE");
    const tools = createReadOnlyTools({ workspaceRoot: root, reader: createNodeFileSystemReader() });
    const outcome = await tools.execute(
      { toolCallId: "c1", name: "search_text", arguments: { pattern: "NEEDLE" } },
      new AbortController().signal,
    );

    assert.equal(outcome.outcome, "result");

    if (outcome.outcome === "result") {
      const matches = outcome.value["matches"];
      assert.equal(Array.isArray(matches), true);
      assert.equal((matches as unknown[]).length, 1);
      assert.match(String((matches as string[])[0]), /app\.ts:1:NEEDLE$/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
