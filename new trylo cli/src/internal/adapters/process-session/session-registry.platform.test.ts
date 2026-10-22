import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ProcessSessionStart } from "../../ports/process-session.js";
import { createProcessSessionRegistry } from "./session-registry.js";

/**
 * The pipes path, against real child processes.
 *
 * These assertions are about behaviour a caller can observe — a process that is
 * still running, output that arrives, an exit code that is reported honestly.
 * Nothing here is mocked: a fake would pass identically whether the code spawned
 * anything or not, which is precisely the failure this package exists to avoid.
 *
 * The harness runs `process.execPath` with a short inline script rather than a
 * shell builtin, because the point under test is the session contract, not
 * whether a particular interpreter is installed.
 */

/** A child that prints a banner, echoes lines, and exits on a keyword. */
const ECHO_CHILD = `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
let seen = 0;
rl.on("line", (line) => {
  seen += 1;
  if (line.trim() === "quit") {
    process.stdout.write("BYE\\n");
    process.exit(7);
  }
  process.stdout.write("ECHO:" + line + "#" + seen + "\\n");
});
process.stdout.write("READY\\n");
`;

/**
 * A registry whose stop does not spend two seconds finding out.
 *
 * `stop` waits up to `STOP_GRACE_MS` for the process to report its own exit, and
 * it reads the clock through the injected `now`. Handing it a clock that jumps a
 * second per reading means the wait ends on its first comparison: the loop's
 * condition is already false, so no real time passes. The alternative — no seam
 * at all — cost three tests two seconds each, which is 6 seconds of a suite
 * waiting to learn something a clock can answer instantly.
 *
 * The clock is a function rather than a constant on purpose: a constant would
 * make `now() < deadline` false forever *and* make any session's `startedAtMs`
 * meaningless, so a test asserting on timings would pass for the wrong reason.
 */
function fastClockRegistry(overrides: { readonly maxSessions?: number } = {}) {
  let tick = 1_000_000;
  return createProcessSessionRegistry({
    now: () => {
      tick += 1_000;
      return tick;
    },
    ...overrides,
  });
}

function startOf(overrides: Partial<ProcessSessionStart> = {}): ProcessSessionStart {
  return {
    id: "",
    argv: [process.execPath, "-e", ECHO_CHILD],
    cwd: process.cwd(),
    env: { PATH: process.env["PATH"] ?? "" },
    tty: false,
    rows: 24,
    cols: 80,
    maxBufferBytes: 65_536,
    ...overrides,
  };
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

describe("process sessions over pipes", () => {
  it("returns a running session while the process is alive, then its real exit code", async () => {
    const registry = createProcessSessionRegistry();
    const session = await registry.start(startOf());
    assert.equal(session.status, "running");
    assert.equal(session.tty, false);

    // Poll until the child's banner arrives; the first read may legitimately be
    // empty because the process has not been scheduled yet.
    let output = "";
    for (let attempt = 0; attempt < 20 && !output.includes("READY"); attempt += 1) {
      const read = await registry.write({ sessionId: session.id, input: "", eof: false, yieldMs: 200 });
      assert.equal(read.ok, true);
      if (read.ok) {
        output += read.read.output;
      }
    }
    assert.match(output, /READY/, "the child's own output comes back through the session");

    const closed = await registry.write({ sessionId: session.id, input: "quit\n", eof: false, yieldMs: 2_000 });
    assert.equal(closed.ok, true);
    await sleep(300);
    const final = registry.get(session.id);
    assert.equal(final?.status, "exited");
    assert.equal(final?.end?.kind, "exited");
    assert.equal(
      final?.exitCode,
      7,
      "the exit code is the child's own, not a normalised 0 or 1",
    );
    await registry.shutdown();
  });

  it("keeps an empty write distinct from real input", async () => {
    const registry = createProcessSessionRegistry();
    const session = await registry.start(startOf());
    await sleep(600);

    const first = await registry.write({ sessionId: session.id, input: "", eof: false, yieldMs: 300 });
    assert.equal(first.ok, true);
    const beforeLength = first.ok ? first.read.output.length : -1;

    // A poll changes nothing about the child's own state: no new line appears.
    const second = await registry.write({ sessionId: session.id, input: "", eof: false, yieldMs: 400 });
    assert.equal(second.ok, true);
    if (second.ok) {
      assert.equal(
        second.read.output,
        "",
        "polling twice must not echo the first read's output again",
      );
    }

    // Real input does change it.
    const typed = await registry.write({ sessionId: session.id, input: "hello\n", eof: false, yieldMs: 1_000 });
    assert.equal(typed.ok, true);
    if (typed.ok) {
      assert.match(typed.read.output, /ECHO:hello#1/);
    }
    assert.ok(beforeLength >= 0);
    await registry.stop(session.id);
    await registry.shutdown();
  });

  it("stops a running process and says what it could observe", async () => {
    // The fast clock matters here: this test's subject is the *outcome* of a stop,
    // and the outcome does not depend on waiting two seconds to hear it.
    const registry = fastClockRegistry();
    const session = await registry.start(startOf({ argv: [process.execPath, "-e", "setInterval(()=>{},1000)"] }));
    await sleep(400);
    assert.equal(registry.get(session.id)?.status, "running");

    const stopped = await registry.stop(session.id);
    assert.equal(stopped.ok, true);
    if (stopped.ok) {
      // Windows kills the direct child and a surviving grandchild can keep the
      // inherited stdio open, so `lost` is a real outcome and must not be
      // dressed up as an exit code nobody saw.
      assert.ok(
        stopped.end.kind === "lost" || stopped.end.kind === "exited",
        `unexpected end kind ${stopped.end.kind}`,
      );
      assert.notEqual(stopped.end.kind, "running");
    }
    assert.notEqual(registry.get(session.id)?.status, "running");
    await registry.shutdown();
  });

  it("reports a missing session rather than inventing an empty result", async () => {
    const registry = createProcessSessionRegistry();
    const read = await registry.write({
      sessionId: "ps_000000000000000000000000",
      input: "",
      eof: false,
      yieldMs: 100,
    });
    assert.equal(read.ok, false);
    if (!read.ok) {
      assert.equal(read.code, "session_not_found");
      assert.match(read.message, /ps_000000000000000000000000/);
    }
    const stopped = await registry.stop("ps_000000000000000000000000");
    assert.equal(stopped.ok, false);
  });

  it("still answers a poll on a finished session, but refuses input to it", async () => {
    const registry = createProcessSessionRegistry();
    const session = await registry.start(startOf({ argv: [process.execPath, "-e", "process.stdout.write('DONE')"] }));
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (registry.get(session.id)?.status !== "running") {
        break;
      }
      await sleep(100);
    }
    const final = registry.get(session.id);
    assert.equal(final?.status, "exited", "a child that exits on its own reaches a terminal state");

    const polled = await registry.write({ sessionId: session.id, input: "", eof: false, yieldMs: 100 });
    assert.equal(polled.ok, true, "polling a finished session is how its last words are read");
    if (polled.ok) {
      assert.match(polled.read.output, /DONE/);
      assert.equal(polled.read.status, "exited");
    }

    const typed = await registry.write({ sessionId: session.id, input: "x", eof: false, yieldMs: 100 });
    assert.equal(typed.ok, false);
    if (!typed.ok) {
      assert.equal(typed.code, "session_finished");
      assert.equal(typed.end?.kind, "exited", "the refusal carries the terminal state");
    }
    await registry.shutdown();
  });

  it("lists live sessions and stops reporting them once reaped", async () => {
    const registry = fastClockRegistry();
    assert.deepEqual(registry.list().sessions, [], "an unused registry lists nothing");

    const session = await registry.start(startOf({ argv: [process.execPath, "-e", "setInterval(()=>{},1000)"] }));
    const listed = registry.list().sessions;
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.id, session.id);
    assert.equal(listed[0]?.tty, false);
    assert.match(listed[0]?.command ?? "", /node/, "the command is shown as it was asked for");

    await registry.stop(session.id);
    await registry.shutdown();
    assert.notEqual(registry.list().sessions[0]?.status, "running");
  });

  it("refuses to start more live sessions than the ceiling allows", async () => {
    const registry = fastClockRegistry({ maxSessions: 1 });
    const first = await registry.start(startOf({ argv: [process.execPath, "-e", "setInterval(()=>{},1000)"] }));
    await assert.rejects(
      () => registry.start(startOf({ argv: [process.execPath, "-e", "setInterval(()=>{},1000)"] })),
      /limit reached \(1\)/,
      "the ceiling is a refusal, not an eviction of a session someone is using",
    );
    await registry.stop(first.id);
    await registry.shutdown();
  });

  it("hands out ids that are unguessable and carry a recognisable prefix", async () => {
    const registry = createProcessSessionRegistry();
    const ids: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const session = await registry.start(startOf({ argv: [process.execPath, "-e", "setInterval(()=>{},1000)"] }));
      ids.push(session.id);
    }
    for (const id of ids) {
      assert.match(id, /^ps_[0-9a-f]{24}$/);
    }
    assert.equal(new Set(ids).size, 3, "ids do not repeat and do not encode a counter");
    await registry.shutdown();
  });

  it("owner teardown preserves an observed exit or explicitly reports an unobserved ending", async () => {
    const registry = createProcessSessionRegistry();
    const session = await registry.start(startOf({ argv: [process.execPath, "-e", "setInterval(()=>{},1000)"] }));
    await sleep(300);
    await registry.shutdown();
    const after = registry.get(session.id);
    assert.ok(after);
    assert.ok(after.end?.kind === "exited" || after.end?.kind === "lost", "shutdown must report an observed exit or a truthful observation loss");
    assert.equal(after.status, after.end.kind);
    if (after.end.kind === "exited") {
      assert.equal(after.exitCode, after.end.exitCode);
      assert.ok(Number.isInteger(after.exitCode));
    } else {
      assert.equal(after.exitCode, undefined, "an unobserved exit must not invent a code");
      assert.match(after.end.reason, /owner teardown/);
    }
  });
});
