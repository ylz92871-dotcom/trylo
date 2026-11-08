import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { JsonObject } from "../../protocol/envelope.js";
import type { ToolCallRequest } from "../../ports/tools.js";
import { createWorkspaceTools } from "./index.js";
import { createProcessSessionRegistry } from "../process-session/session-registry.js";

/**
 * The production path, end to end, against a real process.
 *
 * The point of this file is the word "production". Every other suite in this
 * package tests a component; this one goes through `createWorkspaceTools`, which
 * is what the CLI actually constructs. A component that is complete and
 * unreachable delivers nothing, and reachability is the thing that cannot be
 * asserted by reading the component's own tests.
 */

function call(name: string, args: JsonObject): ToolCallRequest {
  return { toolCallId: `t-${name}-${Object.keys(args).length}`, name, arguments: args };
}

const childScript = `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
let n = 0;
rl.on("line", (line) => {
  n += 1;
  if (line.trim() === "quit") { process.stdout.write("BYE\\n"); process.exit(3); }
  process.stdout.write("ECHO:" + line + "#" + n + "\\n");
});
process.stdout.write("READY\\n");
`;

function startSession(sessions: ReturnType<typeof createProcessSessionRegistry>) {
  return sessions.start({
    id: "",
    argv: [process.execPath, "-e", childScript],
    cwd: process.cwd(),
    env: { PATH: process.env["PATH"] ?? "" },
    tty: false,
    rows: 24,
    cols: 80,
    maxBufferBytes: 65_536,
  });
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

describe("process session tools through the production catalog", () => {
  it("mounts the three tools once a registry is supplied", () => {
    const sessions = createProcessSessionRegistry();
    const tools = createWorkspaceTools({ workspaceRoot: process.cwd(), sessions });
    const names = tools.snapshot().map((binding) => binding.name);
    assert.ok(names.includes("write_stdin"), "write_stdin is reachable from the catalog");
    assert.ok(names.includes("list_processes"), "list_processes is reachable from the catalog");
    assert.ok(names.includes("stop_process"), "stop_process is reachable from the catalog");
  });

  it("mounts nothing session-shaped without a registry", () => {
    // Absent registry means the catalog never had sessions, so it must not
    // advertise tools that would answer "no such session" for everything.
    const tools = createWorkspaceTools({ workspaceRoot: process.cwd() });
    const names = tools.snapshot().map((binding) => binding.name);

    assert.equal(names.includes("write_stdin"), false);
    assert.equal(names.includes("list_processes"), false);
    assert.equal(names.includes("stop_process"), false);
  });

  it("declares that the session tools cannot start anything", () => {
    const sessions = createProcessSessionRegistry();
    const tools = createWorkspaceTools({ workspaceRoot: process.cwd(), sessions });

    for (const name of ["write_stdin", "list_processes"]) {
      const binding = tools.snapshot().find((entry) => entry.name === name);
      assert.equal(binding?.sideEffect, "read_only", `${name} observes rather than acts on the machine`);
      assert.equal(binding?.needsApproval, false, `${name} needs no approval because it starts nothing`);
    }

    // stop_process ends something, and is still read-only: it can only address a
    // session this run started, by an id this run issued. There is no pid, so it
    // cannot reach a process that was not already approved to exist — which is
    // the same reason `write_stdin` needs no prompt.
    const stop = tools.snapshot().find((entry) => entry.name === "stop_process");

    assert.equal(stop?.sideEffect, "read_only");
    assert.equal(stop?.needsApproval, false);
    assert.doesNotMatch(
      stop?.description ?? "",
      /pid/i,
      "the tool must not offer a way to name a process by pid",
    );
  });

  it("carries the terminal capability in the catalog rather than promising one", () => {
    const sessions = createProcessSessionRegistry();
    const tools = createWorkspaceTools({ workspaceRoot: process.cwd(), sessions });
    const binding = tools.snapshot().find((entry) => entry.name === "list_processes");

    assert.match(
      binding?.description ?? "",
      /lost/,
      "the description states that a lost process is not an exit",
    );
  });

  it("reports an empty list honestly rather than inventing sessions", async () => {
    const sessions = createProcessSessionRegistry();
    const tools = createWorkspaceTools({ workspaceRoot: process.cwd(), sessions });
    const outcome = await tools.execute(call("list_processes", {}), new AbortController().signal);

    assert.equal(outcome.outcome, "result");

    if (outcome.outcome === "result") {
      assert.match(outcome.output, /No command sessions/);
      const listed = outcome.value["sessions"];
      assert.deepEqual(listed, []);
    }
  });

  it("carries a real process from the registry through list, poll and stop", async () => {
    const sessions = createProcessSessionRegistry();
    const tools = createWorkspaceTools({ workspaceRoot: process.cwd(), sessions });
    const controller = new AbortController();

    try {
      const session = await startSession(sessions);

      // list_processes sees a real running process
      const listed = await tools.execute(call("list_processes", {}), controller.signal);

      assert.equal(listed.outcome, "result");

      if (listed.outcome === "result") {
        const found = (listed.value["sessions"] as Array<Record<string, unknown>>).find(
          (entry) => entry["sessionId"] === session.id,
        );
        assert.ok(found !== undefined, "the session the registry started is visible to the tool");
        assert.equal(found?.["status"], "running");
        assert.equal(found?.["tty"], false);
      }

      // write_stdin polls until the child's banner arrives
      let output = "";

      for (let attempt = 0; attempt < 20 && !output.includes("READY"); attempt += 1) {
        const read = await tools.execute(
          call("write_stdin", { sessionId: session.id, chars: "", yieldMs: 300 }),
          controller.signal,
        );

        assert.equal(read.outcome, "result");

        if (read.outcome === "result") {
          output += String(read.value["output"] ?? "");
        }
      }

      assert.match(output, /READY/, "a poll returns the child's own output");

      // real input changes the child's behaviour
      const typed = await tools.execute(
        call("write_stdin", { sessionId: session.id, chars: "ping\n", yieldMs: 1_500 }),
        controller.signal,
      );

      assert.equal(typed.outcome, "result");

      if (typed.outcome === "result") {
        assert.match(String(typed.value["output"] ?? ""), /ECHO:ping#1/);
      }

      // stop_process ends it
      const stopped = await tools.execute(
        call("stop_process", { sessionId: session.id }),
        controller.signal,
      );

      assert.equal(stopped.outcome, "result");

      if (stopped.outcome === "result") {
        assert.match(String(stopped.output), /stopped/);
      }

      await sleep(300);
      // A legal yield, and a poll rather than input. The first version of this
      // line used `yieldMs: 200`, which is below the 250 floor — the tool
      // rejected it as `invalid_arguments` before ever reaching the registry, so
      // "not a result" was true no matter what the session was doing. The
      // assertion now reads the state instead of inferring it from an error.
      const afterStop = await tools.execute(
        call("write_stdin", { sessionId: session.id, chars: "", yieldMs: 300 }),
        controller.signal,
      );

      assert.equal(
        afterStop.outcome,
        "result",
        "a finished session is still readable — that is how its last words are read",
      );

      if (afterStop.outcome === "result") {
        assert.notEqual(
          afterStop.value["status"],
          "running",
          "and it reports a state that is no longer running",
        );
      }

      // Input is what actually distinguishes a finished session from a live one.
      const typedAfterStop = await tools.execute(
        call("write_stdin", { sessionId: session.id, chars: "x", yieldMs: 300 }),
        controller.signal,
      );

      assert.equal(
        typedAfterStop.outcome,
        "error",
        "a stopped session takes no further input",
      );
    } finally {
      await sessions.shutdown();
    }
  });

  it("refuses a session id it does not have, naming it", async () => {
    const sessions = createProcessSessionRegistry();
    const tools = createWorkspaceTools({ workspaceRoot: process.cwd(), sessions });
    const outcome = await tools.execute(
      call("write_stdin", { sessionId: "ps_000000000000000000000000", chars: "", yieldMs: 300 }),
      new AbortController().signal,
    );

    assert.equal(outcome.outcome, "error");

    if (outcome.outcome === "error") {
      assert.equal(outcome.code, "session_not_found");
      assert.match(outcome.message, /ps_000000000000000000000000/);
    }
  });

  it("refuses a yield outside the bounds instead of clamping it", async () => {
    const sessions = createProcessSessionRegistry();
    const tools = createWorkspaceTools({ workspaceRoot: process.cwd(), sessions });

    for (const yieldMs of [0, 5, 10 ** 9]) {
      const outcome = await tools.execute(
        call("write_stdin", { sessionId: "ps_000000000000000000000000", chars: "x", yieldMs }),
        new AbortController().signal,
      );

      assert.equal(outcome.outcome, "error", `yieldMs ${yieldMs} must be refused`);

      if (outcome.outcome === "error") {
        assert.equal(outcome.code, "invalid_arguments");
      }
    }
  });

  it("requires a sessionId rather than inventing one", async () => {
    const sessions = createProcessSessionRegistry();
    const tools = createWorkspaceTools({ workspaceRoot: process.cwd(), sessions });

    for (const name of ["write_stdin", "stop_process"]) {
      const outcome = await tools.execute(call(name, {}), new AbortController().signal);
      assert.equal(outcome.outcome, "error");
      if (outcome.outcome === "error") {
        assert.equal(outcome.code, "invalid_arguments");
        assert.match(outcome.message, new RegExp(name));
      }
    }
  });

  it("filters the list to running sessions when asked", async () => {
    const sessions = createProcessSessionRegistry();
    const tools = createWorkspaceTools({ workspaceRoot: process.cwd(), sessions });
    const controller = new AbortController();

    try {
      const finished = await sessions.start({
        id: "",
        argv: [process.execPath, "-e", "process.stdout.write('X')"],
        cwd: process.cwd(),
        env: { PATH: process.env["PATH"] ?? "" },
        tty: false,
        rows: 24,
        cols: 80,
        maxBufferBytes: 1024,
      });
      const running = await startSession(sessions);

      await sleep(900);

      const all = await tools.execute(call("list_processes", {}), controller.signal);
      const onlyRunning = await tools.execute(call("list_processes", { runningOnly: true }), controller.signal);

      assert.equal(all.outcome, "result");
      assert.equal(onlyRunning.outcome, "result");

      if (all.outcome === "result" && onlyRunning.outcome === "result") {
        const everything = all.value["sessions"] as Array<Record<string, unknown>>;
        const live = onlyRunning.value["sessions"] as Array<Record<string, unknown>>;

        assert.ok(everything.length >= 2, "both sessions are listed without a filter");
        assert.ok(
          live.every((entry) => entry["status"] === "running"),
          "a filtered list contains only running sessions",
        );
        assert.ok(
          !live.some((entry) => entry["sessionId"] === finished.id),
          "a finished session is excluded by runningOnly",
        );
        assert.ok(live.some((entry) => entry["sessionId"] === running.id));
      }

      await sessions.stop(running.id);
    } finally {
      await sessions.shutdown();
    }
  });
});
