import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createWorkspaceSandbox } from "../../sandbox/index.js";
import { createWriteQueue, type WriteQueue } from "./atomic-write.js";
import { createMutatingTools } from "./index.js";

for (const kind of ["add", "update", "delete", "move"] as const) {
  test(`patch ${kind} cancelled while waiting for its first commit leaves files intact`, async t => {
    const root = mkdtempSync(join(tmpdir(), "trylo-patch-cancel-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    writeFileSync(join(root, "source.txt"), "old\n");
    const controller = new AbortController();
    const queue = createWriteQueue();
    const delayed: WriteQueue = { exclusive: (absolute, job) => queue.exclusive(absolute, async () => {
      controller.abort();
      return job();
    }) };
    const body = kind === "add" ? "*** Add File: nested/new.txt\n+new" : kind === "delete" ? "*** Delete File: source.txt"
      : `*** Update File: source.txt\n${kind === "move" ? "*** Move to: nested/dest.txt\n" : ""}@@\n-old\n+new`;
    const tools = createMutatingTools({ sandbox: createWorkspaceSandbox({ workspaceRoot: root }), writeQueue: delayed });
    const result = await tools.execute({ name: "apply_patch", toolCallId: kind, arguments: { patch: `*** Begin Patch\n${body}\n*** End Patch` } }, controller.signal);
    assert.equal(result.outcome, "cancelled", JSON.stringify(result));
    assert.equal(readFileSync(join(root, "source.txt"), "utf8"), "old\n");
    assert.equal(existsSync(join(root, "nested")), false, "a cancelled queued commit must not even create its parent directory");
  });
}

test("a move cancelled while waiting to delete the source retains both files and reports the landed destination", async t => {
  const root = mkdtempSync(join(tmpdir(), "trylo-move-cancel-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "source.txt"), "old\n");
  const controller = new AbortController();
  const queue = createWriteQueue();
  let commits = 0;
  const delayed: WriteQueue = { exclusive: (absolute, job) => queue.exclusive(absolute, async () => {
    commits += 1;
    if (commits === 2) controller.abort();
    return job();
  }) };
  const tools = createMutatingTools({ sandbox: createWorkspaceSandbox({ workspaceRoot: root }), writeQueue: delayed });
  const result = await tools.execute({ name: "apply_patch", toolCallId: "move", arguments: {
    patch: "*** Begin Patch\n*** Update File: source.txt\n*** Move to: dest.txt\n@@\n-old\n+new\n*** End Patch",
  } }, controller.signal);
  assert.equal(result.outcome, "error", JSON.stringify(result));
  if (result.outcome === "error") { assert.equal(result.code, "apply_cancelled"); assert.match(result.message, /dest\.txt/); }
  assert.equal(readFileSync(join(root, "source.txt"), "utf8"), "old\n");
  assert.equal(readFileSync(join(root, "dest.txt"), "utf8"), "new\n");
});
