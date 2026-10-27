import assert from "node:assert/strict";
import { test } from "node:test";
import type { JsonObject } from "../../../protocol/envelope.js";
import { createProcessSessionTools, type ProcessSessionToolsPort } from "./process-session-tools.js";

test("members see and control only their own background sessions; the parent retains supervision", async () => {
  const row = (id: string, ownerId?: string) => ({ id, ...(ownerId === undefined ? {} : { ownerId }), status: "running" as const, command: "node server",
    cwd: "D:/workspace", tty: false, startedAtMs: 1, bufferedBytes: 0, droppedOutput: false });
  const rows = [row("parent"), row("first", "task-first"), row("second", "task-second")];
  const writes: string[] = [];
  const stops: string[] = [];
  const sessions: ProcessSessionToolsPort = { supportsTty: false, list: () => ({ sessions: rows }),
    write: async request => { writes.push(request.sessionId); return { ok: true, read: {
      id: request.sessionId, status: "running", output: "ready", truncated: false, bufferedBytes: 0 } }; },
    stop: async id => { stops.push(id); return { ok: true, end: { kind: "exited", exitCode: 0 } }; } };
  const tools = createProcessSessionTools(sessions);
  const call = (name: string, args: JsonObject, ownerId?: string) => tools.execute({ name, toolCallId: "call",
    arguments: args, ...(ownerId === undefined ? {} : { ownerId }) });
  const child = await call("list_processes", {}, "task-first");
  assert.equal(child.outcome, "result");
  if (child.outcome !== "result") return;
  assert.deepEqual((child.value.sessions as JsonObject[]).map(session => session.sessionId), ["first"]);
  assert.equal((child.value.sessions as JsonObject[])[0]?.ownerId, undefined);
  for (const target of ["parent", "second", "unknown"]) {
    const stopped = await call("stop_process", { sessionId: target }, "task-first");
    assert.equal(stopped.outcome, "error");
    const written = await call("write_stdin", { sessionId: target, chars: "change state" }, "task-first");
    assert.equal(written.outcome, "error");
  }
  assert.deepEqual(stops, []);
  assert.deepEqual(writes, []);
  assert.equal((await call("write_stdin", { sessionId: "first", chars: "status" }, "task-first")).outcome, "result");
  assert.equal((await call("stop_process", { sessionId: "first" }, "task-first")).outcome, "result");
  const parent = await call("list_processes", {});
  assert.equal(parent.outcome, "result");
  if (parent.outcome === "result") assert.equal((parent.value.sessions as JsonObject[]).length, 3);
  assert.equal((await call("stop_process", { sessionId: "second" })).outcome, "result");
  assert.deepEqual(writes, ["first"]);
  assert.deepEqual(stops, ["first", "second"]);
});
