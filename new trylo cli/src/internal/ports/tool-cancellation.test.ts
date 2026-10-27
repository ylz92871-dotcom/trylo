import assert from "node:assert/strict";
import { test } from "node:test";
import { cancelToolPorts } from "./tool-cancellation.js";

test("cancellation reaches the active port before waiting on an unrelated acknowledgement", async t => {
  const seen: string[] = [];
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  t.after(() => { release(); });
  const pending = cancelToolPorts([{ cancel: async () => { seen.push("held"); await held; } },
    { cancel: async id => { seen.push(id); } }], "active-command");
  assert.deepEqual(seen, ["held", "active-command"]);
  release();
  await pending;
});

test("a failed cancellation cannot prevent notification of other owners, and all failures remain visible", async () => {
  const failure = new Error("first port failed");
  const otherFailure = new Error("last port failed");
  const seen: string[] = [];
  await assert.rejects(cancelToolPorts([{ cancel: () => { throw failure; } },
    { cancel: async id => { seen.push(id); } }, { cancel: async () => { throw otherFailure; } }], "active-command"),
  error => error instanceof AggregateError && error.errors.length === 2 && error.errors[0] === failure && error.errors[1] === otherFailure);
  assert.deepEqual(seen, ["active-command"]);
});
