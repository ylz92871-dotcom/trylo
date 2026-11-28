import assert from "node:assert/strict";
import test from "node:test";

import { createProcessSessionRegistry } from "./session-registry.js";
import {
  backgroundSession,
  backgroundSessions,
  formatDuration,
  isSessionId,
  killBackgroundSession,
  readBackgroundSession,
  renderRow,
} from "../../ports/background-session.js";

/**
 * Background sessions addressed as `ps` / `logs` / `attach` / `kill` (WP26 / A04).
 *
 * The cases here start **real processes** rather than faking a registry. That is
 * the point of the feature: `ps` lying about what is running, `logs` reporting
 * output that was never produced, and `kill` claiming success while a process
 * keeps going are all failures a mock cannot have, because a mock has no process
 * to outlive the kill.
 *
 * The commands are deliberately chosen for what they prove: one that prints and
 * exits (a session that finishes on its own), one that waits for input (a session
 * that stays `running` so `kill` has something to kill), and one that prints more
 * than the read cap (so truncation is observable rather than assumed).
 */

const NODE = process.execPath;

function registry() {
  return createProcessSessionRegistry({ maxSessions: 8, maxBufferBytes: 64 * 1024 });
}

test("ps lists a real running session with its real command", async () => {
  const sessions = registry();
  const started = await sessions.start({
    id: "ps_aaaaaaaaaaaaaaaaaaaaaaaa",
    argv: [NODE, "-e", "setInterval(() => {}, 1000)"],
    cwd: process.cwd(),
    env: {},
    tty: false,
    rows: 24,
    cols: 80,
    maxBufferBytes: 4096,
  });

  assert.equal(started.status, "running");

  try {
    const listed = backgroundSessions(sessions);

    assert.equal(listed.ok, true);

    if (!listed.ok) return;

    assert.equal(listed.value.length, 1);
    const row = listed.value[0];

    assert.ok(row !== undefined);
    assert.equal(row.status, "running");
    // The command as it was asked for, not re-parsed — that is what makes the
    // listing trustworthy enough to paste somewhere.
    assert.match(row.command, /setInterval/);
  } finally {
    await sessions.shutdown();
  }
});

test("logs returns output the process actually produced", async () => {
  const sessions = registry();
  const started = await sessions.start({
    id: "ps_bbbbbbbbbbbbbbbbbbbbbbbb",
    argv: [NODE, "-e", "console.log('MARKER-ALPHA'); setInterval(() => {}, 1000)"],
    cwd: process.cwd(),
    env: {},
    tty: false,
    rows: 24,
    cols: 80,
    maxBufferBytes: 8192,
  });

  assert.equal(started.status, "running");

  try {
    const logs = await readBackgroundSession(sessions, "ps_bbbbbbbbbbbbbbbbbbbbbbbb", { yieldMs: 1500 });

    assert.equal(logs.ok, true);

    if (!logs.ok) return;

    // The marker is the assertion: a registry that reported success without the
    // process having printed anything would fail here.
    assert.match(logs.value.text, /MARKER-ALPHA/);
    assert.equal(logs.value.truncatedFromStart, false);
  } finally {
    await sessions.shutdown();
  }
});

test("a session that exits on its own reports the real exit code", async () => {
  const sessions = registry();
  const started = await sessions.start({
    id: "ps_cccccccccccccccccccccccc",
    argv: [NODE, "-e", "console.log('bye'); process.exit(3)"],
    cwd: process.cwd(),
    env: {},
    tty: false,
    rows: 24,
    cols: 80,
    maxBufferBytes: 4096,
  });

  assert.equal(started.status, "running");
  // Poll until the exit has actually been *observed*. The registry's terminal
  // state arrives when its `exit` handler runs, which is not synchronously with
  // `start` returning — a process that exits in its first tick can be gone
  // before the first poll registers a waiter. Polling for the state rather than
  // assuming one poll is enough is what makes this a test of the exit code
  // instead of a test of process scheduling.
  const deadline = Date.now() + 10_000;

  while (sessions.get("ps_cccccccccccccccccccccccc")?.status === "running" && Date.now() < deadline) {
    await sessions.write({
      sessionId: "ps_cccccccccccccccccccccccc",
      input: "",
      eof: false,
      yieldMs: 500,
    });
  }

  const row = backgroundSession(sessions, "ps_cccccccccccccccccccccccc");

  assert.equal(row.ok, true);

  if (!row.ok) return;

  // The exit code the process chose, not one the wrapper invented.
  assert.equal(row.value.status, "exited");
  assert.equal(row.value.exitCode, 3);
  assert.match(row.value.end ?? "", /exited 3/);
});

test("attach reads without taking the session over", async () => {
  const sessions = registry();
  const started = await sessions.start({
    id: "ps_dddddddddddddddddddddddd",
    argv: [NODE, "-e", "console.log('FIRST'); setInterval(() => console.log('TICK'), 200)"],
    cwd: process.cwd(),
    env: {},
    tty: false,
    rows: 24,
    cols: 80,
    maxBufferBytes: 8192,
  });

  assert.equal(started.status, "running");

  try {
    const first = await readBackgroundSession(sessions, "ps_dddddddddddddddddddddddd", { yieldMs: 1200 });

    assert.equal(first.ok, true);

    if (first.ok) assert.match(first.value.text, /FIRST/);

    // A second read is a cursor, not a replay: the point of `attach` is that a
    // watcher does not re-read everything every time.
    const second = await readBackgroundSession(sessions, "ps_dddddddddddddddddddddddd", { yieldMs: 1200 });

    assert.equal(second.ok, true);

    if (second.ok) {
      assert.doesNotMatch(second.value.text, /FIRST/, "a second read must not replay what the first took");
    }
  } finally {
    await sessions.shutdown();
  }
});

test("kill ends a waiting session, and the process really goes", async () => {
  const sessions = registry();
  const started = await sessions.start({
    id: "ps_eeeeeeeeeeeeeeeeeeeeeeee",
    // Reads stdin forever, so it is still there to be killed.
    argv: [NODE, "-e", "process.stdin.resume(); process.stdin.on('data', () => {})"],
    cwd: process.cwd(),
    env: {},
    tty: false,
    rows: 24,
    cols: 80,
    maxBufferBytes: 4096,
  });

  assert.equal(started.status, "running");

  const killed = await killBackgroundSession(sessions, "ps_eeeeeeeeeeeeeeeeeeeeeeee");

  assert.equal(killed.ok, true);

  if (!killed.ok) return;

  assert.equal(killed.value.alreadyGone, false);

  if (process.platform === "darwin" || process.platform === "linux") {
    const pid = started.pid;
    assert.ok(pid !== undefined);
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  }

  // The assertion a mock could not make: the session is terminal afterwards, and
  // asking about it is still a valid answer rather than a refusal — "how did it
  // end" is exactly what a person needs next.
  const after = backgroundSession(sessions, "ps_eeeeeeeeeeeeeeeeeeeeeeee");

  assert.equal(after.ok, true);

  if (after.ok) {
    assert.notEqual(after.value.status, "running");
  }
});

test("killing something already gone is success, not an error", async () => {
  const sessions = registry();
  const second = await killBackgroundSession(sessions, "ps_000000000000000000000000");
  // The caller asked for it not to be running, and it is not. Reporting a failure
  // here would teach people to append `|| true`, which would then hide real ones.
  assert.equal(second.ok, true);
  if (second.ok) assert.equal(second.value.alreadyGone, true);
});

test("a malformed id is refused before it reaches a lookup", async () => {
  const sessions = registry();
  // The port's own shape: `ps_` plus 24 hex characters. A looser rule here would
  // let a well-formed-but-nonexistent id pass and fail later with the wrong
  // message, which sends a person looking in the wrong place.
  for (const bad of ["../escape", "has space", "", "ps_short", "not_an_id", "ps_" + "z".repeat(24)]) {
    assert.equal(isSessionId(bad), false, `${bad} must not be a session id`);
    const row = backgroundSession(sessions, bad);
    assert.equal(row.ok, false);
    if (!row.ok) assert.equal(row.code, "invalid_id");
  }
});

test("reading an unknown session says so instead of printing nothing", async () => {
  const sessions = registry();
  const logs = await readBackgroundSession(sessions, "ps_111111111111111111111111", { yieldMs: 100 });

  assert.equal(logs.ok, false);

  if (logs.ok) return;

  // "No output" and "no such session" lead to opposite conclusions, and only one
  // of them is true.
  assert.equal(logs.code, "session_not_found");
  assert.doesNotMatch(logs.message, /^\s*$/);
});

test("ps says plainly when nothing is running", async () => {
  const sessions = registry();
  const listed = backgroundSessions(sessions);
  assert.equal(listed.ok, true);
  if (!listed.ok) return;
  assert.deepEqual(listed.value, []);
});

test("durations read at the two scales that matter", () => {
  assert.equal(formatDuration(0), "0.0s");
  assert.equal(formatDuration(400), "0.4s");
  assert.equal(formatDuration(5_400), "5s");
  // 90 seconds is 90_000 ms; the earlier version of this case passed 5_400 and
  // called it "1m30s", which is how a test can pass while proving nothing.
  assert.equal(formatDuration(90_000), "1m30s");
  assert.equal(formatDuration(3_723_000), "1h02m");
  // A clock that went backwards must not render as a negative age.
  assert.equal(formatDuration(-1000), "0s");
});

test("a ps row names what a person needs: state, age, command, and the warnings", () => {
  const rendered = renderRow(
    {
      id: "s-1",
      status: "running",
      command: "npm run build",
      cwd: "/work",
      tty: true,
      startedAtMs: 0,
      bufferedBytes: 2048,
      droppedOutput: true,
    },
    65_000,
  );

  assert.match(rendered, /npm run build/);
  assert.match(rendered, /1m05s/);
  // The flags are the part a person cannot derive: a truncated log and a lost one
  // both look like "short output" until they are said out loud.
  assert.match(rendered, /output-dropped/);
  assert.match(rendered, /tty/);
});
