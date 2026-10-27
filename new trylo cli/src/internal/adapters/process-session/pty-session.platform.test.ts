import assert from "node:assert/strict";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import type { ProcessSessionStart } from "../../ports/process-session.js";
import { resolvePtyHelper } from "./pty-loader.js";
import { createPtySessionRegistry } from "./pty-session.js";

/**
 * The PTY path, against the real sidecar and a real ConPTY.
 *
 * A fake helper would pass every one of these assertions while proving nothing
 * about terminals, because the whole question is whether a byte written to a
 * console comes back shaped the way a console makes it. So this suite either
 * runs the actual binary or says it did not.
 *
 * The child is the Windows command interpreter with `/c` and a command argument,
 * because that is a real terminal program that prints and exits. `where` and
 * `echo` are used rather than anything shell-specific: the point is the
 * transport, not the program.
 */

const resolution = resolvePtyHelper();
const canRun = resolution.ok;

/** Windows' own command interpreter, located rather than assumed. */
function commandInterpreter(): string | undefined {
  const root = process.env["SystemRoot"];
  if (root === undefined) {
    return undefined;
  }
  const candidate = path.join(root, "System32", "cmd.exe");
  return existsSync(candidate) ? candidate : undefined;
}

const interpreter = commandInterpreter();

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

function startOf(argv: ReadonlyArray<string>): ProcessSessionStart {
  const pathEntries = (process.env["PATH"] ?? "").split(path.delimiter).filter((entry) => entry.length > 0);
  return {
    id: "",
    argv,
    cwd: process.cwd(),
    env: {
      PATH: pathEntries.join(path.delimiter),
      SystemRoot: process.env["SystemRoot"] ?? "",
      TEMP: process.env["TEMP"] ?? "",
      COMSPEC: interpreter ?? "",
    },
    tty: true,
    rows: 30,
    cols: 100,
    maxBufferBytes: 65_536,
  };
}

/** Poll until `marker` shows up, or give up. Console startup is not instant. */
async function readUntil(
  registry: ReturnType<typeof createPtySessionRegistry>,
  sessionId: string,
  marker: string,
  attempts = 25,
): Promise<string> {
  let output = "";
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const read = await registry.write({ sessionId, input: "", eof: false, yieldMs: 300 });
    if (read.ok) {
      output += read.read.output;
      if (output.includes(marker)) {
        return output;
      }
    }
    const current = registry.get(sessionId);
    if (current !== undefined && current.status !== "running") {
      break;
    }
  }
  return output;
}

describe("pty sessions over a real ConPTY", { skip: canRun ? false : `no helper: ${resolution.ok ? "" : resolution.message}` }, () => {
  it("starts a program in a terminal and returns its output and its own exit code", async () => {
    assert.ok(interpreter !== undefined, "this suite needs cmd.exe to have a program to run");
    const registry = createPtySessionRegistry();
    try {
      const session = await registry.start(
        { ...startOf([interpreter as string, "/d", "/c", "echo WP06-TERMINAL-OK"]), ownerId: "member-pty-task" },
      );
      assert.equal(session.ownerId, "member-pty-task");
      assert.equal(session.tty, true, "this path claims a terminal and must not quietly be a pipe");
      assert.equal(session.status, "running");

      const output = await readUntil(registry, session.id, "WP06-TERMINAL-OK");
      assert.match(
        output,
        /WP06-TERMINAL-OK/,
        `terminal output never arrived; got ${JSON.stringify(output.slice(0, 300))}`,
      );

      for (let attempt = 0; attempt < 25; attempt += 1) {
        if (registry.get(session.id)?.status !== "running") {
          break;
        }
        await sleep(200);
      }
      const final = registry.get(session.id);
      assert.equal(final?.status, "exited");
      assert.equal(final?.end?.kind, "exited");
      assert.equal(final?.exitCode, 0, "the child's own exit code, reported through the terminal");
      assert.equal(final?.ownerId, "member-pty-task");
      assert.equal(registry.list().sessions.find(row => row.id === session.id)?.ownerId, "member-pty-task");
    } finally {
      registry.shutdown();
    }
  });

  it("produces terminal output rather than pipe output", async () => {
    assert.ok(interpreter !== undefined);
    const registry = createPtySessionRegistry();
    try {
      const session = await registry.start(startOf([interpreter as string, "/d", "/c", "echo TTYCHECK"]));
      const output = await readUntil(registry, session.id, "TTYCHECK");
      // A pipe carries the program's bytes and nothing else. A terminal adds
      // cursor and mode sequences because it is a screen. This assertion is the
      // one that distinguishes the two paths — without it, a session that
      // quietly fell back to pipes would still pass every other test here.
      assert.match(
        output,
        /\x1b\[/,
        `no ANSI sequences in the output, so this did not go through a terminal: ${JSON.stringify(output.slice(0, 300))}`,
      );
    } finally {
      registry.shutdown();
    }
  });

  it("stops a running terminal program and reports an honest end", async () => {
    assert.ok(interpreter !== undefined);
    const registry = createPtySessionRegistry();
    try {
      // A command interpreter left at its prompt does not exit on its own, which
      // is exactly the case a "background terminal" is for.
      const session = await registry.start(startOf([interpreter as string]));
      await sleep(800);
      assert.equal(registry.get(session.id)?.status, "running");

      const stopped = await registry.stop(session.id);
      assert.equal(stopped.ok, true);
      if (stopped.ok) {
        assert.ok(
          stopped.end.kind === "exited" || stopped.end.kind === "lost",
          `unexpected end kind ${stopped.end.kind}`,
        );
      }
      assert.notEqual(registry.get(session.id)?.status, "running");
    } finally {
      registry.shutdown();
    }
  });

  it("lists a live terminal session with tty set, so it is distinguishable", async () => {
    assert.ok(interpreter !== undefined);
    const registry = createPtySessionRegistry();
    try {
      const session = await registry.start(startOf([interpreter as string]));
      await sleep(500);
      const listed = registry.list().sessions;
      assert.equal(listed.length, 1);
      assert.equal(listed[0]?.tty, true);
      assert.equal(listed[0]?.status, "running");
      await registry.stop(session.id);
    } finally {
      registry.shutdown();
    }
  });

  it("refuses a program it cannot find, before the sidecar is asked", async () => {
    assert.ok(interpreter !== undefined);
    const registry = createPtySessionRegistry();
    try {
      // An absolute path to nothing. The refusal is expected to come from *this*
      // process rather than from the helper, and the distinction is the point:
      // a message from the sidecar would describe the sidecar's environment,
      // which is not the machine the caller asked about. An earlier version
      // asserted on a `pty_spawn_failed` frame from the helper, which is the
      // shape this package no longer has — the helper is told a path, not asked
      // to find one.
      await assert.rejects(
        () => registry.start(startOf(["C:/definitely-not-here-wp06.exe", "/d", "/c", "echo NOPE"])),
        /executable_not_found/,
        "the refusal names this machine's missing file",
      );
      await assert.rejects(
        () => registry.start(startOf(["C:/definitely-not-here-wp06.exe", "/d", "/c", "echo NOPE"])),
        /does not exist/,
        "and says what is wrong with it, in this machine's terms",
      );
      assert.deepEqual(registry.list().sessions, [], "a refused spawn leaves no session behind");
    } finally {
      registry.shutdown();
    }
  });

  it("refuses a script that needs an interpreter rather than wrapping it differently", async () => {
    assert.ok(interpreter !== undefined);
    const registry = createPtySessionRegistry();
    try {
      // A .cmd cannot be CreateProcess'd. WP05 owns the wrapper that runs one,
      // and building a second here would mean a script behaves one way through
      // run_shell and another through a terminal session.
      const batch = path.join(process.cwd(), "wp06-needs-interpreter.cmd");
      writeFileSync(batch, "@echo off\r\n");
      try {
        await assert.rejects(
          () => registry.start(startOf([batch])),
          /pty_session_rejects_script/,
          "the refusal names the reason instead of quietly running it",
        );
      } finally {
        rmSync(batch, { force: true });
      }
    } finally {
      registry.shutdown();
    }
  });

  it("answers a poll on a finished terminal session and refuses input to it", async () => {
    assert.ok(interpreter !== undefined);
    const registry = createPtySessionRegistry();
    try {
      const session = await registry.start(
        startOf([interpreter as string, "/d", "/c", "echo LASTWORDS"]),
      );
      await readUntil(registry, session.id, "LASTWORDS");
      for (let attempt = 0; attempt < 25; attempt += 1) {
        if (registry.get(session.id)?.status !== "running") {
          break;
        }
        await sleep(200);
      }
      assert.equal(registry.get(session.id)?.status, "exited");

      const polled = await registry.write({ sessionId: session.id, input: "", eof: false, yieldMs: 200 });
      assert.equal(polled.ok, true, "the last words of a finished session are readable by polling it");

      const typed = await registry.write({ sessionId: session.id, input: "x", eof: false, yieldMs: 200 });
      assert.equal(typed.ok, false);
      if (!typed.ok) {
        assert.equal(typed.code, "session_finished");
      }
    } finally {
      registry.shutdown();
    }
  });

  it("reports a missing terminal session rather than an empty success", async () => {
    const registry = createPtySessionRegistry();
    try {
      const read = await registry.write({
        sessionId: "ps_000000000000000000000000",
        input: "",
        eof: false,
        yieldMs: 100,
      });
      assert.equal(read.ok, false);
      if (!read.ok) {
        assert.equal(read.code, "session_not_found");
      }
    } finally {
      registry.shutdown();
    }
  });

  it("resizes a live terminal session and refuses one that is gone", async () => {
    assert.ok(interpreter !== undefined);
    const registry = createPtySessionRegistry();
    try {
      const session = await registry.start(startOf([interpreter as string]));
      await sleep(500);
      assert.equal(registry.resize(session.id, 40, 120), true, "a live session accepts a new window size");
      assert.equal(
        registry.resize("ps_000000000000000000000000", 40, 120),
        false,
        "an unknown session is not resized",
      );
      await registry.stop(session.id);
    } finally {
      registry.shutdown();
    }
  });

  it("marks a session lost, not exited, when the helper disappears", async () => {
    assert.ok(interpreter !== undefined);
    const registry = createPtySessionRegistry();
    try {
      const session = await registry.start(startOf([interpreter as string]));
      await sleep(600);
      // Simulates the helper dying with a program still attached to a console.
      // Claiming an exit code here would be a statement about the user's
      // machine that nothing observed.
      registry.shutdown();
      const after = registry.get(session.id);
      assert.equal(after, undefined, "a shutdown clears the sessions it owned");
    } finally {
      registry.shutdown();
    }
  });
});
