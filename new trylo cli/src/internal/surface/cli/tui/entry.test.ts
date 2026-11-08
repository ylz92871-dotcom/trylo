import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EXIT_CODES, type CliStreamEvent } from "../../../protocol/cli-stream.js";
import { PACKAGED_DEFAULTS } from "../../../settings/schema.js";
import type { Transcript } from "../../../protocol/transcript.js";
import type { CliContext } from "../context.js";
import type { TurnOutcome } from "../host.js";
import type { CliSink } from "../render.js";
import { handleRepl } from "../repl.js";
import type { RunScaffold } from "../run-command.js";
import { handleReplEntry, handleTui, type TuiTurnRunner } from "./entry.js";
import { lineIoOf, type TuiIo } from "./io.js";
import { createMidRunInput } from "./mid-run-input.js";

/**
 * The entry contracts.
 *
 * - **The hard gate (contract #2)**: with stdin not a terminal, the entry IS
 *   the line REPL — the same function call — so the outputs match byte for
 *   byte. The test drives both paths over identical scripted sessions,
 *   including a real fixture turn through the real loop.
 * - The TUI shell consumes the surface event stream, renders it through the
 *   pure state, and threads the transcript like the line REPL does.
 * - With an interrupt source wired, the first Ctrl-C requests the turn's
 *   cancellation and the process stays; the second consecutive one exits
 *   (contract #4, machine half — the live source itself is OPEN-T2-2).
 */

type Scripted = {
  readonly ctx: CliContext;
  readonly out: string[];
  readonly err: string[];
  readonly root: string;
};

function scriptedCtx(lines: ReadonlyArray<string>, stdinIsTty: boolean): Scripted {
  const out: string[] = [];
  const err: string[] = [];
  const root = mkdtempSync(join(tmpdir(), "trylo-tui-"));
  const home = join(root, "home");
  const cwd = join(root, "workspace");

  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(home, ".trylo", "sessions"), { recursive: true });
  // Pick the fixture provider explicitly so the TUI startup page does not
  // consume the scripted input intended for the shell loop.
  writeFileSync(join(home, ".trylo", "config.json"), JSON.stringify({ provider: "fixture" }));
  let at = 0;
  let ids = 0;
  const ctx: CliContext = {
    env: {},
    homeDir: home,
    cwd,
    nodeVersion: "v22.0.0",
    stdinIsTty,

    readFile: (absolutePath) => {
      try {
        return readFileSync(absolutePath, "utf8");
      } catch {
        return undefined;
      }
    },

    isDirectory: () => true,
    readDir: () => [],
    writeFile: () => true,
    readStdin: async () => "",

    readLine: async () => {
      if (at >= lines.length) {
        return undefined;
      }
      const line = lines[at];
      at += 1;
      return line;
    },

    readSecret: async () => undefined,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    now: () => 0,
    newId: (prefix) => `${prefix}-${(ids += 1)}`,
  };

  return { ctx, out, err, root };
}

function sinkOf(scripted: Scripted): CliSink {
  return { stdout: scripted.ctx.stdout, stderr: scripted.ctx.stderr };
}

function cleanup(scripted: Scripted): void {
  rmSync(scripted.root, { recursive: true, force: true });
}

test("TUI closes after a durable session failure and cannot dispatch the queued next turn", async () => {
  const fx = scriptedCtx(["first", "second", "/exit"], true);
  let dispatched = 0;
  const failure = { exitCode: EXIT_CODES.CONFIG, message: "write failed", hint: "session closed", continuation: "session_closed" as const };
  const runner: TuiTurnRunner = async () => {
    dispatched++;
    return failure;
  };

  try {
    const result = await handleTui(fx.ctx, lineIoOf(fx.ctx), runner);
    assert.equal(result, EXIT_CODES.CONFIG);
    assert.equal(dispatched, 1);
  } finally {
    cleanup(fx);
  }
});

test("non-TTY entry is the line REPL byte for byte, turns included", async () => {
  const script = ["/help", "/not-a-command", "hello fixture", "/exit"];
  const direct = scriptedCtx(script, false);
  const entered = scriptedCtx(script, false);

  try {
    const codeDirect = await handleRepl(direct.ctx, sinkOf(direct));
    const codeEntered = await handleReplEntry(entered.ctx, sinkOf(entered));

    assert.equal(codeEntered, codeDirect);
    // Each run builds its own temporary workspace, and a failed tool result now
    // names the path it failed on — the D3 fix that makes a failure actionable.
    // That one fact is normalised here, so "byte for byte" still means what it
    // says about everything else.
    const withoutOwnRoot = (lines: ReadonlyArray<string>, root: string): ReadonlyArray<string> =>
      lines.map((line) => line.split(root).join("<root>"));

    assert.deepEqual(withoutOwnRoot(entered.out, entered.root), withoutOwnRoot(direct.out, direct.root));
    assert.deepEqual(withoutOwnRoot(entered.err, entered.root), withoutOwnRoot(direct.err, direct.root));
  } finally {
    cleanup(direct);
    cleanup(entered);
  }
});

/**
 * A deliberately tiny ANSI screen, so a test can assert on the rows a person
 * actually sees instead of on a soup of escape sequences. Supports only what
 * the shell emits: `\n`, `\r`, `ESC[<n>A`, `ESC[<n>G`, `ESC[J`/`ESC[0J`,
 * `ESC[K`, `ESC[2K`; SGR colour runs are dropped.
 */
type Screen = {
  readonly rows: () => string[];
  readonly bottomLineOf: (needle: string) => number;
};

function renderScreen(writes: ReadonlyArray<string>, cols: number, rows: number): Screen {
  const grid: string[][] = Array.from({ length: rows }, () => []);
  let y = 0;
  let x = 0;
  const put = (ch: string): void => {
    const row = grid[y] ?? [];

    grid[y] = row;

    while (row.length < x) row.push(" ");

    row[x] = ch;
    x += 1;

    if (x >= cols) {
      x = 0;
      y = Math.min(y + 1, rows - 1);
    }
  };
  const text = writes.join("");

  for (let i = 0; i < text.length; i += 1) {
    const c = text[i] ?? "";
    if (c === "\x1b") {
      const m = /^\x1b\[([0-9]*)([ABGJK])/.exec(text.slice(i));
      if (m === null) {
        continue;
      }

      i += m[0].length - 1;
      const n = (m[1] ?? "") === "" ? 1 : Number.parseInt(m[1] ?? "1", 10);

      if (m[2] === "A") {
        y = Math.max(0, y - n);
      } else if (m[2] === "B") {
        y = Math.min(rows - 1, y + n);
      } else if (m[2] === "G") {
        x = Math.max(0, n - 1);
      } else if (m[2] === "J") {
        for (let r = y; r < rows; r += 1) {
          grid[r] = [];
        }
        x = 0;
      } else if (m[2] === "K") {
        grid[y] = (grid[y] ?? []).slice(0, x);
      }

      continue;
    }

    if (c === "\r") {
      x = 0;
      continue;
    }

    if (c === "\n") {
      x = 0;
      y = Math.min(y + 1, rows - 1);
      continue;
    }

    put(c);
  }

  const out = grid.map((r) => r.join("").replace(/\s+$/, ""));

  return {
    rows: () => out,

    bottomLineOf: (needle: string) => {
      for (let r = out.length - 1; r >= 0; r -= 1) {
        if ((out[r] ?? "").includes(needle)) {
          return r;
        }
      }
      return -1;
    },
  };
}

type FakeIo = TuiIo & { readonly written: string[]; readonly reads: { count: number }; readonly prompts: string[] };

function fakeIo(lines: ReadonlyArray<string>, handlers?: Array<() => void>): FakeIo {
  const written: string[] = [];
  const reads = { count: 0 };
  const prompts: string[] = [];

  return {
    written,
    reads,
    prompts,

    readLine: async (prompt?: string) => {
      prompts.push(prompt ?? "");
      return reads.count < lines.length ? (lines[reads.count++] ?? "") : undefined;
    },

    write: (text) => written.push(text),
    size: () => ({ columns: 80, rows: 24 }),
    ...(handlers === undefined ? {} : { onInterrupt: (handler: () => void) => handlers.push(handler) }),
  };
}

const THREADING_TRANSCRIPT = [
  { sequence: 0, kind: "user", text: "hi" },
] as unknown as Transcript;

function fakeRunner(
  transcript: Transcript,
): { readonly runner: TuiTurnRunner; readonly scaffolds: RunScaffold[] } {
  const scaffolds: RunScaffold[] = [];
  const runner: TuiTurnRunner = async (scaffold, _text, sink) => {
    scaffolds.push(scaffold);
    const events: ReadonlyArray<CliStreamEvent> = [
      {
        type: "run_start",
        sessionId: scaffold.sessionId,
        turnId: "turn-1",
        providerId: scaffold.providerId,
        model: scaffold.model,
      },
      { type: "message_start" },
      { type: "message_delta", text: "hello from the model" },
      { type: "message_end" },
      { type: "tool_use", toolCallId: "call-1", name: "read_file" },
      {
        type: "run_result",
        status: "completed",
        finishReason: "stop",
        sessionId: scaffold.sessionId,
        turnId: "turn-1",
        iterations: 2,
        usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
        durationMs: 4,
        lastMessage: "hello from the model",
      },
    ];

    for (const event of events) {
      sink.stdout(`${JSON.stringify(event)}\n`);
    }

    const outcome: TurnOutcome = {
      exitCode: 0,
      result: {
        type: "run_result",
        status: "completed",
        finishReason: "stop",
        sessionId: scaffold.sessionId,
        turnId: "turn-1",
        iterations: 2,
        usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
        durationMs: 4,
        lastMessage: "hello from the model",
      },
      transcript,
      view: undefined,
      warnings: [],
    };

    return outcome;
  };

  return { runner, scaffolds };
}

test("multiple question answers reuse the fallback pump's single reader", async () => {
  const fx = scriptedCtx([], true);
  const lines = ["ask", "蓝色", "红色", "/exit"];
  const io = fakeIo([]);
  let reading = false;
  const singleReader: TuiIo = { ...io, readLine: async () => {
    assert.equal(reading, false, "terminal_reader_busy");
    reading = true;
    await new Promise<void>(resolve => setImmediate(resolve));
    reading = false;
    return lines.shift();
  } };
  const received: string[] = [];
  const runner: TuiTurnRunner = async (scaffold, text, sink, signal) => {
    received.push(text);

    if (text === "ask") {
      assert(scaffold.questions);
      await scaffold.questions.execute({ name: "ask_user_question", toolCallId: "ask", arguments: { questions: [
        { id: "first", header: "一", question: "第一种颜色？", options: [{ label: "蓝色", description: "蓝" }, { label: "红色", description: "红" }] },
        { id: "second", header: "二", question: "第二种颜色？", options: [{ label: "蓝色", description: "蓝" }, { label: "红色", description: "红" }] },
      ] } }, new AbortController().signal);
    }

    return fakeRunner([]).runner(scaffold, text, sink, signal);
  };

  try {
    assert.equal(await handleTui(fx.ctx, singleReader, runner, undefined, {}, () => createMidRunInput({ io: singleReader })), 0);
    assert.equal(received.length, 2);
    assert.match(received[1] ?? "", /"first":"蓝色","second":"红色"/);
  } finally { cleanup(fx); }
});

test("the TUI shell consumes the event stream and threads the transcript", async () => {
  const scripted = scriptedCtx([], true);
  const { runner, scaffolds } = fakeRunner(THREADING_TRANSCRIPT);
  const io = fakeIo(["hi", "again", "/exit"]);

  try {
    const code = await handleTui(scripted.ctx, io, runner);

    assert.equal(code, 0);
    const flat = io.written.join("");

    assert.match(flat, /hello from the model/);
    assert.match(flat, /-> read_file/);
    // The status line shows the budget the run actually resolved, which is the
    // packaged default — read from it rather than pinned a second time here.
    assert.equal(scaffolds[0]?.maxIterations, PACKAGED_DEFAULTS.maxIterations);
    assert.match(flat, /fixture\/default/);
    assert.match(flat, /last completed/);
    assert.equal(scaffolds.length, 2);
    assert.deepEqual(scaffolds[1]?.resumeTranscript, THREADING_TRANSCRIPT);
  } finally {
    cleanup(scripted);
  }
});

test("the idle prompt is handed to the line reader, not written by the shell", async () => {
  // `rl.question("")` refreshes its own line, which erased a hand-written
  // "> " before it was ever seen on a real terminal.
  const scripted = scriptedCtx([], true);
  const { runner } = fakeRunner(THREADING_TRANSCRIPT);
  const io = fakeIo(["", "/exit"]);

  try {
    await handleTui(scripted.ctx, io, runner);
    assert.equal(io.prompts[0], "> ", "the first read must carry the prompt");
    assert.equal(
      io.written.some((chunk) => chunk.endsWith("\n> ")),
      false,
      "the shell must not write the prompt itself; readline owns drawing it",
    );
  } finally {
    cleanup(scripted);
  }
});

test("empty input at the idle prompt does not stack another status bar", async () => {
  // Each loop pass used to write the bar again instead of redrawing it, so
  // three plain Enters left three idle bars on screen.
  const scripted = scriptedCtx([], true);
  const { runner } = fakeRunner(THREADING_TRANSCRIPT);
  const io = fakeIo(["", "", "", "/exit"]);

  try {
    await handleTui(scripted.ctx, io, runner);
    const bars = io.written.filter((chunk) => chunk.includes("| idle")).length;
    assert.equal(bars, 1, `three empty Enters drew ${bars} idle status bars; expected 1`);
  } finally {
    cleanup(scripted);
  }
});

/**
 * The order of the start page, read off a simulated 80x24 screen rather than
 * off the write calls: what is at the top is the first thing a person sees, and
 * a status bar or a hint that landed above the mark would only show up here.
 */
test("the start page is compact and puts project and model before commands", async () => {
  const scripted = scriptedCtx([], true);
  const { runner } = fakeRunner(THREADING_TRANSCRIPT);
  const io = fakeIo(["hi", "/exit"]);

  try {
    await handleTui(scripted.ctx, io, runner);
    const screen = renderScreen(io.written, 80, 24).rows();

    assert.match(screen[0] ?? "", /Trylo.*workspace.*fixture\/default/);
    assert.match(screen[1] ?? "", /\/settings/);
    const hint = screen.findIndex((r) => r.includes("/exit"));
    const bar = screen.findIndex((r) => r.includes("idle"));

    assert.ok(hint <= 3, "startup instructions must fit within four rows");
    assert.equal(screen.some(row => row.includes("█")), false);
    assert.ok(bar > hint, `status bar at ${bar} is drawn above the hint at ${hint}`);
  } finally {
    cleanup(scripted);
  }
});

/** The two turn shapes an interrupt can produce, in the host's own vocabulary. */
function outcomeWith(scaffold: RunScaffold, status: "completed" | "cancelled"): TurnOutcome {
  return {
    exitCode: status === "cancelled" ? EXIT_CODES.CANCELLED : EXIT_CODES.OK,
    result: {
      type: "run_result",
      status,
      finishReason: status === "cancelled" ? "cancelled" : "stop",
      sessionId: scaffold.sessionId,
      turnId: "turn-1",
      iterations: 1,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      durationMs: 0,
      lastMessage: "",
    },
    transcript: [],
    view: undefined,
    warnings: [],
  };
}

test("TUI threads raw records after cancellation even without a compact window, preserving durable ordinals", async () => {
  const fx = scriptedCtx(["first", "second", "/exit"], true);
  let turns = 0;
  const runner: TuiTurnRunner = async scaffold => {
    turns++;

    if (turns === 1) {
      const session = scaffold.session!;

      for (const payload of [
        { kind: "user", sequence: 0, text: "first" },
        { kind: "tool_call", sequence: 1, toolCallId: "not-issued", name: "read_file", arguments: {} },
      ]) {
        await session.append({ type: "transcript_item", sessionId: scaffold.sessionId, turnId: "t", at: "1970-01-01T00:00:00Z", payload });
      }

      return { ...outcomeWith(scaffold, "cancelled"), transcript: [
        { kind: "user", sequence: 0, text: "first" },
        { kind: "tool_call", sequence: 1, toolCallId: "not-issued", name: "read_file", arguments: {} },
      ] };
    }

    assert.ok(scaffold.resumeRecords?.some(record => record.type === "transcript_item" && record.payload.sequence === 1));
    assert.equal(scaffold.resumeTranscript?.some(item => item.kind === "tool_call"), false, "an unanswered request must not reach the next provider prompt");

    return outcomeWith(scaffold, "completed");
  };

  try {
    assert.equal(await handleTui(fx.ctx, lineIoOf(fx.ctx), runner), 0);
    assert.equal(turns, 2);
  } finally { cleanup(fx); }
});

test("TUI stops when the settled journal cannot be read for the next turn", async () => {
  const fx = scriptedCtx(["first", "second", "/exit"], true);
  let turns = 0;
  const runner: TuiTurnRunner = async scaffold => {
    turns++;
    scaffold.session!.readRecords = async () => ({ ok: false, code: "checksum_mismatch", detail: "injected" });
    return outcomeWith(scaffold, "completed");
  };

  try {
    assert.equal(await handleTui(fx.ctx, lineIoOf(fx.ctx), runner), EXIT_CODES.CONFIG);
    assert.equal(turns, 1);
  } finally { cleanup(fx); }
});

/** Emits the run host's terminal fact and returns the same turn. */
function finishTurn(scaffold: RunScaffold, sink: CliSink, status: "completed" | "cancelled"): TurnOutcome {
  const outcome = outcomeWith(scaffold, status);
  sink.stdout(`${JSON.stringify(outcome.result)}\n`);
  return outcome;
}

test("a wired interrupt hub cancels in place once and exits on the second press", async () => {
  const scripted = scriptedCtx([], true);
  const handlers: Array<() => void> = [];
  const io = fakeIo(["hi", "hi", "/exit"], handlers);
  let turns = 0;
  const signals: AbortSignal[] = [];
  const runner: TuiTurnRunner = async (scaffold, _text, sink, cancel) => {
    turns += 1;
    signals.push(cancel);

    if (handlers[0] !== undefined) {
      handlers[0]();
    }

    sink.stdout(`${JSON.stringify({
      type: "run_result",
      status: "completed",
      finishReason: "stop",
      sessionId: scaffold.sessionId,
      turnId: "turn-1",
      iterations: 1,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      durationMs: 0,
      lastMessage: "",
    })}\n`);

    return {
      exitCode: 0,
      result: {
        type: "run_result",
        status: "completed",
        finishReason: "stop",
        sessionId: scaffold.sessionId,
        turnId: "turn-1",
        iterations: 1,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        durationMs: 0,
        lastMessage: "",
      },
      transcript: [],
      view: undefined,
      warnings: [],
    };
  };

  try {
    const code = await handleTui(scripted.ctx, io, runner);

    assert.equal(code, EXIT_CODES.CANCELLED);
    assert.equal(turns, 2);
    const flat = io.written.join("");

    // Turn 1: cancel requested, process alive. Turn 2: second press exits,
    // so the trailing "/exit" line is never read.
    assert.match(flat, /cancel was requested during the turn/);
    assert.equal(flat.split("cancel was requested").length - 1, 1);
    assert.equal(io.reads.count, 2);
    // Both turns were handed a cancel signal and the shell cut the one that was
    // open. This runner ignores it on purpose: an unresponsive runner is
    // reported as unresponsive, never dressed up as a turn that was stopped.
    assert.equal(signals.length, 2);
    assert.equal(signals[0]?.aborted, true);
    assert.equal(signals[1]?.aborted, true);
  } finally {
    cleanup(scripted);
  }
});

test("a TTY session runs a real fixture turn through the one run host", async () => {
  const scripted = scriptedCtx(["hi fixture", "n", "/exit"], true);
  try {
    const code = await handleReplEntry(scripted.ctx, sinkOf(scripted));
    assert.equal(code, 0);
    const flat = [...scripted.out, ...scripted.err].join("");
    assert.match(flat, /-> read_file/);
    assert.match(flat, /The package name is unknown\./);
    assert.match(flat, /last completed/);
  } finally {
    cleanup(scripted);
  }
});

test("the first interrupt cancels the turn in flight and the session keeps going", async () => {
  const scripted = scriptedCtx([], true);
  const handlers: Array<() => void> = [];
  const io = fakeIo(["first", "second", "/exit"], handlers);
  const signals: AbortSignal[] = [];
  let turns = 0;
  const runner: TuiTurnRunner = async (scaffold, _text, sink, cancel) => {
    turns += 1;
    signals.push(cancel);

    if (turns === 1) {
      handlers[0]?.();
      // What the real host does with an aborted cancel signal: the turn ends
      // `cancelled`. Waited for here so the shell's message is checked against
      // the status the host reported, not against the request it was sent.
      await new Promise<void>((resolve) => {
        if (cancel.aborted) {
          resolve();
          return;
        }
        cancel.addEventListener("abort", () => resolve(), { once: true });
      });
    }

    return finishTurn(scaffold, sink, cancel.aborted ? "cancelled" : "completed");
  };

  try {
    const code = await handleTui(scripted.ctx, io, runner);

    assert.equal(code, EXIT_CODES.OK);
    assert.equal(turns, 2);
    assert.equal(io.reads.count, 3);
    const flat = io.written.join("");

    assert.match(flat, /turn cancelled/);
    assert.equal(flat.includes("finished before it could be stopped"), false);
    assert.equal(signals[0]?.aborted, true);
    assert.equal(signals[1]?.aborted, false);
  } finally {
    cleanup(scripted);
  }
});

test("with the root's interrupt surface wired the second press leaves with 130", async () => {
  const scripted = scriptedCtx(["first", "second", "/exit"], true);
  const handled: Array<() => void> = [];
  const exits: number[] = [];
  const ctx: CliContext = {
    ...scripted.ctx,
    interrupts: {
      observe: (handler) => handled.push(handler),
      exit: (code) => exits.push(code),
    },
  };
  let turns = 0;
  const runner: TuiTurnRunner = async (scaffold, _text, sink) => {
    turns += 1;
    handled[0]?.();
    return finishTurn(scaffold, sink, "completed");
  };

  try {
    // The production path: `lineIoOf` is what `handleReplEntry` builds, and the
    // capability it passes through is the root's, not the test's.
    const code = await handleTui(ctx, lineIoOf(ctx), runner);
    assert.equal(turns, 2, "the second press must end the loop instead of taking another turn");
    assert.deepEqual(exits, [EXIT_CODES.CANCELLED]);
    assert.equal(code, EXIT_CODES.CANCELLED);
  } finally {
    cleanup(scripted);
  }
});
