import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createWorkspaceSandbox } from "../../sandbox/index.js";
import { createWriteQueue, type WriteQueue } from "./atomic-write.js";
import { createMutatingTools } from "./index.js";

for (const kind of ["write_file", "edit_file", "apply_patch"] as const) {
  test(`queued ${kind} refuses a parent replaced by an outside junction`, async t => {
    const base = mkdtempSync(join(tmpdir(), "trylo-path-race-"));
    t.after(() => rmSync(base, { recursive: true, force: true }));
    const root = join(base, "workspace"); const outside = join(base, "outside"); const parent = join(root, "folder");
    mkdirSync(parent, { recursive: true }); mkdirSync(outside);
    writeFileSync(join(parent, "target.txt"), "old\n");
    writeFileSync(join(outside, "target.txt"), "old\n");
    const queue = createWriteQueue();
    let swapped = false;
    const racing: WriteQueue = { exclusive: (absolute, job) => queue.exclusive(absolute, async () => {
      if (!swapped) {
        swapped = true;
        renameSync(parent, join(root, "original"));
        symlinkSync(outside, parent, process.platform === "win32" ? "junction" : "dir");
      }
      return job();
    }) };
    const tools = createMutatingTools({ sandbox: createWorkspaceSandbox({ workspaceRoot: root }), writeQueue: racing });
    const args = kind === "write_file" ? { path: "folder/target.txt", content: "new\n" }
      : kind === "edit_file" ? { path: "folder/target.txt", old_string: "old", new_string: "new" }
      : { patch: "*** Begin Patch\n*** Delete File: folder/target.txt\n*** End Patch" };
    const result = await tools.execute({ name: kind, toolCallId: kind, arguments: args }, new AbortController().signal);
    assert.equal(result.outcome, "error", JSON.stringify(result));
    assert.equal(existsSync(join(outside, "target.txt")), true);
    assert.equal(readFileSync(join(outside, "target.txt"), "utf8"), "old\n");
    assert.equal(readFileSync(join(root, "original/target.txt"), "utf8"), "old\n");
  });
}
