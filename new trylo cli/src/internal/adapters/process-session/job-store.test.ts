import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createJobStore, readLogTail } from "./job-store.js";
import { jobsDir } from "./job-store.js";
import type { BackgroundJobRecord } from "../../ports/background-job.js";

/**
 * The durable job table, driven through real files.
 *
 * These cases exist because the surveyed implementations each got one of these
 * wrong in public: cline's `background-terminal.ts` overwrites records with a bare
 * `writeFileSync` (two writers swallow each other's fields), gemini names its log
 * after the pid and then loses output when the pid is reused, and gemini's
 * `shellExecutionService.ts:819-822` turns a spawn error into `handleExit(1)` —
 * a exit code nobody observed. Each of those is a test below.
 */

let counter = 0;

function store(nowMs = 1_700_000_000_000) {
  const home = mkdtempSync(join(tmpdir(), "wp26-jobs-"));
  let clock = nowMs;
  const jobs = createJobStore({
    home,
    now: () => clock,
    ownerPid: 4242,
    maxLogBytes: 64,
    readMaxBytes: 32,
    retentionMs: 1_000,
  });
  const id = () => `ps_${(++counter).toString(16).padStart(24, "0")}`;
  const start = (sessionId = id()) => {
    assert.equal(jobs.publish({ id: sessionId, pid: 900 + counter, command: "node -e x", cwd: home, startedAtMs: clock }), true);
    return sessionId;
  };
  const fileOf = (sessionId: string) => join(home, "jobs", sessionId, "job.json");
  const raw = (sessionId: string) => readFileSync(fileOf(sessionId), "utf8");
  const record = (sessionId: string): BackgroundJobRecord => JSON.parse(raw(sessionId)) as BackgroundJobRecord;

  return { home, jobs, id, start, fileOf, raw, record, at: (ms: number) => { clock = ms; } };
}

test("a published job is one complete JSON line, with no invented ending", () => {
  const h = store();
  const sessionId = h.start();
  const found = h.jobs.read(sessionId);

  assert.equal(found.ok, true);

  if (!found.ok) return;

  assert.equal(found.record.status, "running");
  assert.equal("exitCode" in found.record, false, "a running job must not carry an exit code");
  assert.equal("endedAtMs" in found.record, false);
  assert.equal(h.raw(sessionId).split("\n").length - 1, 1, "one record per file, newline terminated");
  h.jobs.settle(sessionId, { kind: "exited", exitCode: 0 });
});

test("the same id is never published twice", () => {
  const h = store();
  const sessionId = h.start();

  assert.equal(
    h.jobs.publish({ id: sessionId, pid: 9999, command: "node -e x", cwd: h.home, startedAtMs: 1_700_000_000_000 }),
    false,
    "a second running record for one id would be two truths about one process",
  );
});

test("output is bounded, and the bound is written into the record instead of silently truncating", () => {
  const h = store();
  const sessionId = h.start();

  h.jobs.append(sessionId, Buffer.from("a".repeat(40)));
  h.jobs.append(sessionId, Buffer.from("b".repeat(40)));
  assert.equal(h.jobs.readOutput(sessionId).ok, true);
  h.jobs.settle(sessionId, { kind: "exited", exitCode: 0 });
  const record = h.record(sessionId);

  assert.equal(record.droppedOutput, true, "the owner must say the log was cut short");
  assert.ok(record.logBytes <= 64, `log bytes ${record.logBytes} exceeded the cap`);
});

test("a log read is capped and reports that it skipped the front", () => {
  const h = store();
  const sessionId = h.start();

  h.jobs.append(sessionId, Buffer.from("head-".padEnd(50, "x")));
  h.jobs.append(sessionId, Buffer.from("|tail"));
  const output = h.jobs.readOutput(sessionId);

  assert.equal(output.ok, true);

  if (!output.ok) return;

  assert.ok(output.text.length <= 32, "the read cap must hold");
  assert.equal(output.truncatedFromStart, true);
});

test("a settle the owner observed carries the code; one it did not must not", () => {
  const h = store();
  const exited = h.start();

  h.jobs.settle(exited, { kind: "exited", exitCode: 3 });
  const record = h.record(exited);

  assert.equal(record.status, "exited");
  assert.equal(record.exitCode, 3);

  const failed = h.start();

  h.jobs.settle(failed, { kind: "failed", code: "process_spawn_failed", message: "no such file" });
  const failure = h.record(failed);

  assert.equal(failure.status, "failed");
  assert.equal("exitCode" in failure, false, "a child that never ran has no exit code to report");
  assert.match(failure.failure ?? "", /no such file/);
});

test("an undecodable record is reported as undecodable, never as absent", () => {
  const h = store();
  const sessionId = h.start();

  writeFileSync(h.fileOf(sessionId), '{"id":"', "utf8");
  const found = h.jobs.read(sessionId);

  assert.equal(found.ok, false);

  if (found.ok) return;

  assert.equal(found.code, "unreadable", "a half-written file must not read as 'no such job'");
});

test("a record that does not match its shape is refused rather than cast", () => {
  const h = store();
  const sessionId = h.start();
  writeFileSync(h.fileOf(sessionId), `${JSON.stringify({ id: sessionId, pid: "not-a-number" })}\n`, "utf8");
  const found = h.jobs.read(sessionId);
  assert.equal(found.ok, false);
});

test("marking a job lost needs the bytes we saw, and never invents an ending", () => {
  const h = store();
  const sessionId = h.start();
  const found = h.jobs.read(sessionId);

  assert.equal(found.ok, true);

  if (!found.ok) return;

  // Someone else wrote first: their answer beats ours.
  assert.equal(h.jobs.markLost(sessionId, '{"stale":true}\n'), false);
  assert.equal(h.record(sessionId).status, "running");

  assert.equal(h.jobs.markLost(sessionId, found.raw), true);
  const lost = h.record(sessionId);

  assert.equal(lost.status, "lost");
  assert.equal("exitCode" in lost, false, "we observed a missing process, not an ending");
  assert.equal("endedAtMs" in lost, false);
});

test("sweep keeps what is running and what it cannot read, and drops what is old", () => {
  const h = store(1_700_000_000_000);
  const running = h.start();
  const finished = h.start();

  h.jobs.settle(finished, { kind: "exited", exitCode: 0 });
  const broken = h.start();

  writeFileSync(h.fileOf(broken), "nonsense\n", "utf8");

  const later = 1_700_000_000_000 + 5_000;

  h.at(later);
  const removed = h.jobs.sweep(later);

  assert.equal(removed, 1, "only the terminal, expired job goes");
  const left = readdirSync(jobsDir(h.home));

  assert.ok(left.includes(running) && left.includes(broken), `sweep took more than it should: ${left.join(",")}`);
  assert.equal(left.includes(finished), false);
});

test("the log is named after the job, not after the pid", () => {
  // gemini's `background-${pid}.log` collides when Windows recycles a pid, and the
  // collision is swallowed by the `wx` create: output vanishes with a warning.
  const h = store();
  const first = h.start();

  h.jobs.append(first, Buffer.from("one\n"));
  const logPath = h.jobs.read(first);

  assert.equal(logPath.ok, true);

  if (!logPath.ok) return;

  assert.match(logPath.record.logPath, /jobs\/ps_[0-9a-f]+\/output\.log$/);
  assert.equal(logPath.record.logPath.includes(String(logPath.record.pid)), false);
});

test("readLogTail refuses a directory instead of throwing", () => {
  const home = mkdtempSync(join(tmpdir(), "wp26-tail-"));
  const nested = join(home, "a-directory");

  mkdirSync(nested);
  const missing = readLogTail(join(home, "not-there.log"));

  assert.equal(missing.ok, false);
  const directory = readLogTail(nested);

  assert.equal(directory.ok, false);

  if (directory.ok) return;

  assert.match(directory.detail, /not a regular file/);
  rmSync(home, { recursive: true, force: true });
});
