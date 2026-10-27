import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProcessSessionRegistry } from "../../adapters/process-session/session-registry.js";
import type { ProcessSessionSnapshot, ProcessSessionStopResult } from "../../ports/process-session.js";
import { createSubagentTaskResources } from "./subagent-task-resources.js";

function session(id: string, ownerId?: string): ProcessSessionSnapshot {
  return { id, ...(ownerId === undefined ? {} : { ownerId }), status: "running", command: "test", cwd: ".", tty: false,
    bufferedBytes: 0, droppedOutput: false, startedAtMs: 0 };
}
function registry(rows: ProcessSessionSnapshot[], stop: ProcessSessionRegistry["stop"]): ProcessSessionRegistry {
  return { stop, list: () => ({ sessions: rows }), get: id => rows.find(row => row.id === id), maxSessions: 8,
    start: async () => { throw new Error("unexpected start"); }, shutdown: async () => {},
    write: async () => { throw new Error("unexpected input"); } };
}

test("member cleanup stops every matching owner, excluding root and siblings", async () => {
  const stopped: string[] = [];
  const resources = createSubagentTaskResources(registry([session("root"), session("sibling", "other"),
    session("first", "task"), session("second", "task")], async id => {
    stopped.push(id); return { ok: true, end: { kind: "exited", exitCode: 1 } };
  }));
  await resources.stop("task");
  assert.deepEqual(stopped.sort(), ["first", "second"]);
});

test("a lost or refused native receipt never becomes a successful task stop", async () => {
  for (const answer of [{ ok: true, end: { kind: "lost", reason: "helper disappeared" } },
    { ok: false, code: "session_stop_failed", message: "native stop refused" }] satisfies ProcessSessionStopResult[]) {
    const attempts: string[] = [];
    const resources = createSubagentTaskResources(registry([session("first", "task"), session("second", "task")], async id => {
      attempts.push(id); return answer;
    }));
    await assert.rejects(resources.stop("task"), /2 owned process stop\(s\) remain unconfirmed/);
    assert.deepEqual(attempts.sort(), ["first", "second"], "one failure must not suppress other stop attempts");
  }
});

test("an assigned PID or terminal failure cannot masquerade as a command that never started", async () => {
  const end = { kind: "failed", code: "process_spawn_failed", message: "failure" } as const;
  const rows: ProcessSessionSnapshot[] = [
    { ...session("has-pid", "task"), status: "failed", pid: 123, end },
    { ...session("terminal", "task"), status: "failed", tty: true, end },
  ];
  const attempts: string[] = [];
  const resources = createSubagentTaskResources(registry(rows, async id => {
    attempts.push(id); return { ok: true, end };
  }));
  await assert.rejects(resources.stop("task"), /2 owned process stop\(s\) remain unconfirmed/);
  assert.deepEqual(attempts.sort(), ["has-pid", "terminal"]);
});
