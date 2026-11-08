import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import type { ProcessSessionStart } from "../../ports/process-session.js";
import { resolvePtyHelper } from "./pty-loader.js";
import { createPtySessionRegistry } from "./pty-session.js";

/**
 * Regressions for the two blocking defects the four-eye audit found.
 *
 * Both are invisible to a single-session suite, which is why they survived the
 * first round: with one terminal open, "broadcast to every session" and
 * "deliver to the session that produced it" are the same code path. These tests
 * are built so that reverting either fix turns them red.
 */

const resolution = resolvePtyHelper();
const canRun = resolution.ok;

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

/**
 * The helper's own pid, from the OS.
 *
 * Simulating the helper's death means killing that process, and nothing in this
 * package holds it: the registry exposes sessions, and a session's `pid` is the
 * terminal's — a *child* of the helper, so killing it would close one session
 * rather than the helper. The packaged artifact has a distinctive image name,
 * so the honest way to find it is to ask the OS. A miss fails the test loudly
 * rather than skipping it, so green always means the kill actually happened.
 */
function locateHelperPid(): number | undefined {
  const systemRoot = process.env["SystemRoot"];
  if (systemRoot === undefined) {
    return undefined;
  }

  try {
    const listing = execFileSync(
      path.join(systemRoot, "System32", "tasklist.exe"),
      ["/FI", "IMAGENAME eq trylo-pty.exe", "/FO", "CSV", "/NH"],
      { encoding: "utf8" },
    );
    const match = /"(\d+)"/.exec(listing);

    return match === null || match[1] === undefined ? undefined : Number(match[1]);
  } catch {
    return undefined;
  }
}

/** Kills the helper, failing the test if it could not be found. */
function killHelper(): void {
  const pid = locateHelperPid();
  assert.notEqual(pid, undefined, "the helper process must be findable to simulate its death");
  process.kill(pid as number, "SIGKILL");
}

function startOf(argv: ReadonlyArray<string>, id: string): ProcessSessionStart {
  return {
    id,
    argv,
    cwd: process.cwd(),
    env: {
      PATH: (process.env["PATH"] ?? "").split(path.delimiter).filter((e) => e.length > 0).join(path.delimiter),
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

/**
 * Reads everything currently buffered and returns it, without waiting for a
 * marker. Used to clear a console's start-up banner so it cannot be mistaken for
 * something the test typed.
 */
async function drain(
  registry: ReturnType<typeof createPtySessionRegistry>,
  sessionId: string,
  attempts = 6,
): Promise<string> {
  let output = "";

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const read = await registry.write({ sessionId, input: "", eof: false, yieldMs: 250 });
    if (!read.ok) {
      return output;
    }
    output += read.read.output;
  }

  return output;
}

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

describe(
  "pty regressions from the four-eye audit",
  { skip: canRun ? false : `no helper: ${resolution.ok ? "" : resolution.message}` },
  () => {
    it("keeps two live terminals' output in the session that produced it", async () => {
      assert.ok(interpreter !== undefined);
      const registry = createPtySessionRegistry();

      try {
        // Both interpreters stay at their prompts and the marker is typed into
        // one of them. Both must be *running* for this bug to be visible: a
        // session that already exited is dropped from the sidecar's table, so a
        // broadcast finds nobody to broadcast to and the test passes against
        // broken code. Two `echo` pairs that exit immediately were tried first
        // and hid it exactly this way.
        const listener = await registry.start(startOf([interpreter], `ps_listen0024`));
        const talker = await registry.start(startOf([interpreter], `ps_talker0024`));

        await sleep(1_200);
        assert.equal(registry.get(listener.id)?.status, "running", "the listener stays open");
        assert.equal(registry.get(talker.id)?.status, "running", "the talker stays open");

        // Drain both, so what the talker prints next cannot be mistaken for
        // either session's start-up banner.
        await drain(registry, listener.id);
        await drain(registry, talker.id);

        const typed = await registry.write({
          sessionId: talker.id,
          input: "echo ZETA-FROM-TALKER\r\n",
          eof: false,
          yieldMs: 1_500,
        });

        assert.equal(typed.ok, true);

        if (typed.ok) {
          assert.match(
            typed.read.output,
            /ZETA-FROM-TALKER/,
            "the session that was typed into receives its own output",
          );
        }

        // The other session is where contamination would show.
        const other = await registry.write({
          sessionId: listener.id,
          input: "",
          eof: false,
          yieldMs: 600,
        });

        assert.equal(other.ok, true);

        if (other.ok) {
          assert.doesNotMatch(
            other.read.output,
            /ZETA-FROM-TALKER/,
            "a second live terminal must not receive the first one's output",
          );
        }
      } finally {
        registry.shutdown();
      }
    });

    it("gives two live terminals separate buffers, read back independently", async () => {
      assert.ok(interpreter !== undefined);
      const registry = createPtySessionRegistry();

      try {
        // The same fact from the other side: instead of checking that one
        // session lacks the other's marker, this checks that each session's own
        // output arrives whole. A broadcast splits every message across both
        // buffers, so each ends up holding half of two conversations and neither
        // marker appears intact.
        const one = await registry.start(startOf([interpreter], `ps_one00000024`));
        const two = await registry.start(startOf([interpreter], `ps_two00000024`));

        await sleep(1_200);
        await drain(registry, one.id);
        await drain(registry, two.id);

        await registry.write({
          sessionId: one.id,
          input: "echo ONE-SIDE\r\n",
          eof: false,
          yieldMs: 1_500,
        });
        await registry.write({
          sessionId: two.id,
          input: "echo TWO-SIDE\r\n",
          eof: false,
          yieldMs: 1_500,
        });

        const oneOut = await readUntil(registry, one.id, "ONE-SIDE");
        const twoOut = await readUntil(registry, two.id, "TWO-SIDE");

        assert.match(oneOut, /ONE-SIDE/, "the first reads back its own complete output");
        assert.match(twoOut, /TWO-SIDE/, "the second reads back its own complete output");
        assert.doesNotMatch(oneOut, /TWO-SIDE/, "and not the other's");
        assert.doesNotMatch(twoOut, /ONE-SIDE/, "in either direction");
      } finally {
        registry.shutdown();
      }
    });

    it("attributes output while both sessions are still running, not after they end", async () => {
      assert.ok(interpreter !== undefined);
      const registry = createPtySessionRegistry();

      try {
        // A session left open at its prompt produces nothing, so anything that
        // shows up in its buffer came from elsewhere. This is the shape of the
        // bug as a user would hit it: one terminal idles while another works.
        const idle = await registry.start(startOf([interpreter], "ps_idle0000000024"));
        const busy = await registry.start(
          startOf([interpreter, "/d", "/c", "echo GAMMA-ONLY-MARKER"], "ps_busy0000000024"),
        );
        const busyOut = await readUntil(registry, busy.id, "GAMMA-ONLY-MARKER");

        assert.match(busyOut, /GAMMA-ONLY-MARKER/);

        // Read the idle session directly from its snapshot-free path.
        const idleRead = await registry.write({
          sessionId: idle.id,
          input: "",
          eof: false,
          yieldMs: 300,
        });

        assert.equal(idleRead.ok, true);

        if (idleRead.ok) {
          assert.doesNotMatch(
            idleRead.read.output,
            /GAMMA-ONLY-MARKER/,
            "an idle terminal must not collect another session's output",
          );
        }

        assert.equal(registry.get(idle.id)?.status, "running", "the idle session is still running");
      } finally {
        registry.shutdown();
      }
    });

    it("still reports a lost session after the helper is gone", async () => {
      assert.ok(interpreter !== undefined);
      const registry = createPtySessionRegistry();
      // A command interpreter left at its prompt, still running when the helper
      // dies. A session that had already exited would report `exited` — which is
      // correct, and would test nothing about `lost`. The state under test is
      // the one where the helper vanished while the program was still alive.
      const session = await registry.start(startOf([interpreter], "ps_delta00000024"));

      await sleep(900);
      assert.equal(registry.get(session.id)?.status, "running", "the session is alive before the kill");

      // Kill the helper out from under the registry, the way a crash or an
      // external `taskkill` would. Before the fix this made every later lookup
      // answer session_not_found, so the `lost` state existed and could not be
      // observed — which is the opposite of what it is for.
      killHelper();
      await sleep(1_200);

      const after = registry.get(session.id);

      assert.notEqual(after, undefined, "a lost session must still be readable after the helper dies");
      assert.equal(after?.status, "lost", "and its state must be lost, not unknown");
      assert.equal(after?.end?.kind, "lost");
      assert.match(
        String(after?.end && "reason" in after.end ? after.end.reason : ""),
        /helper/i,
        "the reason names the helper rather than the process",
      );

      // A poll on it still answers, which is how a caller reads what the
      // program said before the helper went away.
      const polled = await registry.write({
        sessionId: session.id,
        input: "",
        eof: false,
        yieldMs: 300,
      });

      assert.equal(polled.ok, true, "a lost session is readable, not missing");

      if (polled.ok) {
        // Whatever it managed to print before the helper went — the console
        // banner is enough. What is asserted is the state, not the content.
        assert.equal(polled.read.status, "lost");
        assert.equal(polled.read.end?.kind, "lost");
      }

      // And it appears in the listing, or a user cannot discover that it ended.
      const listed = registry.list().sessions;

      assert.ok(
        listed.some((entry) => entry.id === session.id),
        "a lost session is still listed",
      );
      registry.shutdown();
    });

    it("refuses input to a lost session while still answering a poll", async () => {
      assert.ok(interpreter !== undefined);
      const registry = createPtySessionRegistry();
      const session = await registry.start(startOf([interpreter], "ps_epsilon0000024"));

      await sleep(600);
      killHelper();
      await sleep(1_200);

      const typed = await registry.write({
        sessionId: session.id,
        input: "x",
        eof: false,
        yieldMs: 300,
      });

      assert.equal(typed.ok, false, "there is no terminal left to type into");

      if (!typed.ok) {
        assert.equal(typed.code, "session_finished");
        assert.equal(typed.end?.kind, "lost", "and the refusal carries the lost state");
      }

      registry.shutdown();
    });
  },
);
