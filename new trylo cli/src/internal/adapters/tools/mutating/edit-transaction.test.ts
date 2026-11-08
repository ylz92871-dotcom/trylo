import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createWorkspaceSandbox } from "../../sandbox/index.js";
import { createWriteQueue } from "./atomic-write.js";
import { createMutatingTools } from "./index.js";

test("concurrent exact edits to one file retain both successful changes", async () => {
  const root = mkdtempSync(join(tmpdir(), "trylo-edit-transaction-"));
  try {
    writeFileSync(join(root, "source.txt"), "one\ntwo\n");
    const tools = createMutatingTools({ sandbox: createWorkspaceSandbox({ workspaceRoot: root }) });
    const outcomes = await Promise.all(([["one", "first"], ["two", "second"]] as const).map(([old_string, new_string], index) => tools.execute({
      toolCallId: String(index), name: "edit_file", arguments: { path: "source.txt", old_string, new_string },
    }, new AbortController().signal)));

    assert.ok(outcomes.every(outcome => outcome.outcome === "result"));
    assert.equal(readFileSync(join(root, "source.txt"), "utf8"), "first\nsecond\n");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an edit cancelled while waiting for a preceding write never commits", async () => {
  const root = mkdtempSync(join(tmpdir(), "trylo-edit-cancel-"));
  try {
    writeFileSync(join(root, "source.txt"), "one\n");
    const queue = createWriteQueue();
    let release: () => void = () => undefined;
    const held = new Promise<void>(resolve => { release = resolve; });
    const preceding = queue.exclusive(join(root, "source.txt"), () => held);
    const controller = new AbortController();
    const tools = createMutatingTools({ sandbox: createWorkspaceSandbox({ workspaceRoot: root }), writeQueue: queue });
    const editing = tools.execute({toolCallId:"edit",name:"edit_file",arguments:{path:"source.txt",old_string:"one",new_string:"two"}},controller.signal);

    controller.abort();
    release();
    await preceding;
    assert.equal((await editing).outcome, "cancelled");
    assert.equal(readFileSync(join(root, "source.txt"), "utf8"), "one\n");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a whole-file write cancelled while queued never commits", async () => {
  const root = mkdtempSync(join(tmpdir(), "trylo-write-cancel-"));
  try {
    writeFileSync(join(root, "source.txt"), "one\n");
    const queue = createWriteQueue();
    let release: () => void = () => undefined;
    const held = new Promise<void>(resolve => { release = resolve; });
    const preceding = queue.exclusive(join(root, "source.txt"), () => held);
    const controller = new AbortController();
    const tools = createMutatingTools({ sandbox: createWorkspaceSandbox({ workspaceRoot: root }), writeQueue: queue });
    const writing = tools.execute({toolCallId:"write",name:"write_file",arguments:{path:"source.txt",content:"two\n"}},controller.signal);

    controller.abort();
    release();
    await preceding;
    assert.equal((await writing).outcome, "cancelled");
    assert.equal(readFileSync(join(root, "source.txt"), "utf8"), "one\n");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
