import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { JsonObject } from "../../protocol/envelope.js";
import type { ToolCallRequest } from "../../ports/tools.js";
import { createWorkspaceSandbox } from "../sandbox/index.js";
import { createWorkspaceTools } from "./index.js";
import { createProcessSessionRegistry } from "../process-session/session-registry.js";
import { createPtySessionRegistry } from "../process-session/pty-session.js";
import { createSessionView } from "../process-session/session-view.js";
import { resolvePtyHelper } from "../process-session/pty-loader.js";

/**
 * `runInBackground`, end to end, against a real process.
 *
 * The four-eye audit's third blocker was that nothing in production ever called
 * `registry.start()`, so all five capabilities were unavailable however many
 * tests passed. These tests go through `createWorkspaceTools` — the object the
 * CLI actually builds — and assert that a background command produces a session
 * that the session tools can then see, poll and stop. A test that started a
 * session by calling the registry directly would pass against exactly the code
 * the audit called unreachable.
 */

/**
 * A `node -e <script>` command, as a model would send it.
 *
 * A bare program name, never `process.execPath`: the sandbox refuses an absolute
 * executable (`allowAbsoluteExecutable: false`, WP05's rule), so a test built on
 * an absolute path would be asserting against a refusal rather than against
 * backgrounding — and would go red for a reason that has nothing to do with the
 * feature under test.
 */
function nodeRunning(script: string): string {
  return `node -e ${JSON.stringify(script)}`;
}

function call(name: string, args: JsonObject): ToolCallRequest {
  return { toolCallId: `t-${name}`, name, arguments: args };
}

const controller = (): AbortController => new AbortController();

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** A child that prints a banner then waits for input, so it outlives the call. */
/**
 * One line, because `run_shell` refuses a multi-line command by design (WP05's
 * rule, and its refusal says so). A multi-line child here would be testing that
 * refusal rather than backgrounding — which is how the first version of this
 * file passed a broken child: node printed a syntax error, the banner assertion
 * never ran, and the failure surfaced three steps later looking like a
 * `write_stdin` problem.
 */
const CHILD =
  'const rl=require("node:readline").createInterface({input:process.stdin});' +
  'let n=0;' +
  'rl.on("line",(l)=>{n+=1;' +
  'if(l.trim()==="quit"){process.stdout.write("BYE"+String.fromCharCode(10));process.exit(5);}' +
  'process.stdout.write("BG-ECHO:"+l+"#"+n+String.fromCharCode(10));});' +
  'process.stdout.write("BG-READY"+String.fromCharCode(10));';

function toolsWithSession() {
  const pipes = createProcessSessionRegistry();
  const ptyResolution = resolvePtyHelper();
  const pty = ptyResolution.ok ? createPtySessionRegistry() : undefined;
  const sessions = createSessionView({ pipes, ...(pty === undefined ? {} : { pty }) });
  const tools = createWorkspaceTools({
    workspaceRoot: process.cwd(),
    sandbox: createWorkspaceSandbox({ workspaceRoot: process.cwd() }),
    sessions,
  });

  return { tools, sessions, ptyAvailable: pty !== undefined };
}

describe("run_shell runInBackground, through the production catalog", () => {
  it("starts a background command and hands back a session id", async () => {
    const { tools, sessions } = toolsWithSession();
    const signal = controller().signal;

    try {
      const started = await tools.execute(
        call("run_shell", {
          command: nodeRunning(CHILD),
          runInBackground: true,
        }),
        signal,
      );

      assert.equal(started.outcome, "result", "a background start is a result, not a wait");

      if (started.outcome !== "result") {
        return;
      }

      const sessionId = started.value["sessionId"] as string;

      assert.equal(typeof sessionId, "string", "the result carries a session id");
      assert.match(String(sessionId), /^ps_[0-9a-f]{24}$/);
      assert.match(started.output, /write_stdin/, "the message says how to continue it");

      // The session is real: the child's own banner arrives through a poll.
      let output = "";

      for (let attempt = 0; attempt < 25 && !output.includes("BG-READY"); attempt += 1) {
        const read = await tools.execute(
          call("write_stdin", { sessionId, chars: "", yieldMs: 300 }),
          signal,
        );

        assert.equal(read.outcome, "result");

        if (read.outcome === "result") {
          output += String(read.value["output"] ?? "");
        }
      }

      assert.match(output, /BG-READY/, "the background process's output reaches the model");

      // And it is listed, which is the difference between "started" and "findable".
      const listed = await tools.execute(call("list_processes", {}), signal);

      assert.equal(listed.outcome, "result");

      if (listed.outcome === "result") {
        const sessions_ = listed.value["sessions"] as Array<Record<string, unknown>>;
        assert.ok(
          sessions_.some((entry) => entry["sessionId"] === sessionId),
          "a background session appears in list_processes",
        );
      }
    } finally {
      await sessions.shutdown();
    }
  });

  it("continues the command with write_stdin and ends it with stop_process", async () => {
    const { tools, sessions } = toolsWithSession();
    const signal = controller().signal;
    let sessionId = "";

    try {
      const started = await tools.execute(
        call("run_shell", {
          command: nodeRunning(CHILD),
          runInBackground: true,
        }),
        signal,
      );

      assert.equal(started.outcome, "result");

      if (started.outcome !== "result") {
        return;
      }

      sessionId = started.value["sessionId"] as string;
      // The child's banner is polled for rather than waited for, so the session
      // is known to have started reading stdin before anything is typed. A fixed
      // sleep would be a race: on a loaded machine it can expire before the
      // interpreter has reached its readline, and the input would arrive before
      // anything was listening.
      //
      // The marker is collected and asserted *after* the loop. Checking it only
      // as a loop condition is how this test passed against a child that had
      // printed nothing: the loop simply ran out of attempts and the failure
      // surfaced later, somewhere else.
      let banner = "";

      for (let attempt = 0; attempt < 25; attempt += 1) {
        const ready = await tools.execute(
          call("write_stdin", { sessionId, chars: "", yieldMs: 300 }),
          signal,
        );

        assert.equal(ready.outcome, "result", "a poll on a live session always answers");

        if (ready.outcome !== "result") {
          return;
        }

        banner += String(ready.value["output"] ?? "");

        if (banner.includes("BG-READY")) {
          break;
        }
      }

      assert.match(banner, /BG-READY/, "the child reached its read loop before anything was typed");

      const typed = await tools.execute(
        call("write_stdin", { sessionId, chars: "ping\n", yieldMs: 1_500 }),
        signal,
      );

      assert.equal(typed.outcome, "result");

      if (typed.outcome === "result") {
        assert.match(String(typed.value["output"] ?? ""), /BG-ECHO:ping#1/);
      }

      const stopped = await tools.execute(call("stop_process", { sessionId }), signal);

      assert.equal(stopped.outcome, "result", "a live session can be stopped");

      if (stopped.outcome === "result") {
        assert.match(String(stopped.output), /stopped/);
      }

      await sleep(300);
      // An empty poll on a finished session still answers; input does not. Both
      // halves matter: the first is how the last words are read, the second is
      // how a caller learns the session is gone.
      const polled = await tools.execute(
        call("write_stdin", { sessionId, chars: "", yieldMs: 300 }),
        signal,
      );

      assert.equal(polled.outcome, "result", "a finished session is still readable");

      if (polled.outcome === "result") {
        assert.notEqual(polled.value["status"], "running", "and no longer claims to run");
      }

      const typedAfter = await tools.execute(
        call("write_stdin", { sessionId, chars: "x", yieldMs: 300 }),
        signal,
      );

      assert.equal(typedAfter.outcome, "error", "a stopped session takes no further input");
    } finally {
      await sessions.shutdown();
    }
  });

  it("refuses to background a chain, naming what it would have to do instead", async () => {
    const { tools, sessions } = toolsWithSession();
    try {
      const outcome = await tools.execute(
        call("run_shell", {
          command: nodeRunning("process.stdout.write('a')"),
          steps: [nodeRunning("process.stdout.write('b')")],
          runInBackground: true,
        }),
        controller().signal,
      );

      assert.equal(outcome.outcome, "error");

      if (outcome.outcome === "error") {
        assert.equal(outcome.code, "background_single_command_only");
        assert.match(outcome.message, /separate calls/);
      }
    } finally {
      await sessions.shutdown();
    }
  });

  it("refuses to background when no registry is wired, rather than running it inline", async () => {
    // No sessions passed, which is what a caller that never starts long-lived
    // commands looks like. The alternative — silently running it in the
    // foreground — would block on a command that was asked not to block.
    const tools = createWorkspaceTools({
      workspaceRoot: process.cwd(),
      sandbox: createWorkspaceSandbox({ workspaceRoot: process.cwd() }),
    });
    const outcome = await tools.execute(
      call("run_shell", {
        command: nodeRunning("process.stdout.write('x')"),
        runInBackground: true,
      }),
      controller().signal,
    );

    assert.equal(outcome.outcome, "error");

    if (outcome.outcome === "error") {
      assert.equal(outcome.code, "background_not_available");
      assert.match(outcome.message, /foreground/, "the message names the alternative");
    }
  });

  it("runs the same command in the foreground when backgrounding was not asked for", async () => {
    // The default path must be untouched: this is the shape every existing
    // run_shell caller has, and a background feature that changed it would break
    // all of them.
    const { tools, sessions } = toolsWithSession();
    try {
      const outcome = await tools.execute(
        call("run_shell", { command: nodeRunning("process.stdout.write('FG-OK')") }),
        controller().signal,
      );

      assert.equal(outcome.outcome, "result");

      if (outcome.outcome === "result") {
        assert.match(String(outcome.value["stdout"] ?? ""), /FG-OK/);
        assert.equal(outcome.value["sessionId"], undefined, "a foreground run has no session");
      }
    } finally {
      await sessions.shutdown();
    }
  });

  it("reports terminal support in the listing only when a sidecar exists", async () => {
    const { tools, sessions, ptyAvailable } = toolsWithSession();
    try {
      const listed = await tools.execute(call("list_processes", {}), controller().signal);

      assert.equal(listed.outcome, "result");

      if (listed.outcome === "result") {
        assert.equal(
          listed.value["supportsTty"],
          ptyAvailable,
          "the claim matches what this platform can actually do",
        );
      }
    } finally {
      await sessions.shutdown();
    }
  });
});
