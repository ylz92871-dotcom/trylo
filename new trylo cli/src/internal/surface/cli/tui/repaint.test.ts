import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { CliStreamEvent } from "../../../protocol/cli-stream.js";
import type { CliContext } from "../context.js";
import type { TurnOutcome } from "../host.js";
import type { CliSink } from "../render.js";
import { handleReplEntry, handleTui, type TuiTurnRunner } from "./entry.js";
import type { TuiIo } from "./io.js";
import { createPainter } from "./painter.js";
import { emptyTuiState, pushSystemLine, type TuiFacts } from "./state.js";

/**
 * A6: repainting happens only in a terminal, and every repaint is a move the
 * terminal can actually perform.
 *
 * The rule has two halves, and both are checked here rather than argued for.
 * In a terminal the shell must redraw the turn as it runs — at least one paint,
 * and every paint after the first must move the cursor back over exactly the
 * lines the previous one wrote. Out of a terminal it must emit no cursor
 * movement at all, because a piped `trylo` is somebody's output file.
 *
 * Nothing here waits on a clock. The shell's repaint schedule is an injected
 * capability, so a test can drive it by hand and still exercise the real
 * painter — the alternative, sleeping 33ms and hoping, would be a flaky test
 * about a deterministic rule.
 */

const FACTS: TuiFacts = {
  sessionId: "repl-1",
  providerId: "fixture",
  model: "default",
  contextTokenLimit: undefined,
  maxIterations: 8,
};

function recordIo(overrides: Partial<TuiIo> = {}): TuiIo & { readonly written: string[] } {
  const written: string[] = [];
  return {
    written,
    readLine: async () => undefined,
    write: (text) => written.push(text),
    size: () => ({ columns: 80, rows: 24 }),
    // Synchronous by default, so a paint is observable the moment it is asked
    // for; the cases about deferral inject their own schedule.
    schedule: (flush) => flush(),
    ...overrides,
  };
}

test("A6: a paint moves up exactly the lines the previous paint wrote", () => {
  const io = recordIo();
  const painter = createPainter(io, 0);

  const first = pushSystemLine(emptyTuiState(FACTS), "one");

  painter.request(first);
  const second = pushSystemLine(first, "two");

  painter.request(second);

  // Paint 1 clears from the cursor down and writes "one" plus the status bar:
  // two lines, so paint 2 must move up two.
  assert.equal(io.written[0], "\x1b[J");
  assert.equal(io.written[1]?.split("\n").length, 3, "one content line, the bar, and the trailing newline");
  assert.equal(io.written[2], "\x1b[2A");
  assert.equal(io.written[3], "\x1b[J");
  assert.equal(io.written[4]?.split("\n").length, 4);
});

test("A6: settling leaves the content without a status bar and stops painting", () => {
  const io = recordIo();
  const painter = createPainter(io, 0);

  const first = pushSystemLine(emptyTuiState(FACTS), "one");

  painter.request(first);
  const settled = pushSystemLine(first, "two");

  painter.settle(settled);

  const lastBody = io.written[io.written.length - 1] ?? "";

  assert.equal(lastBody, "one\ntwo\n", "the settled paint must be the content alone");
  assert.equal(lastBody.includes("\x1b[2m"), false, "the status bar belongs to the prompt below, not to the turn");

  const before = io.written.length;

  painter.request(pushSystemLine(settled, "three"));
  assert.equal(io.written.length, before, "a settled painter must not draw again");
});

test("A6: a deferred paint that never runs still loses no text", () => {
  const io = recordIo();
  const pending: Array<() => void> = [];
  const painter = createPainter({ ...io, schedule: (flush) => pending.push(flush) }, 0);

  const first = pushSystemLine(emptyTuiState(FACTS), "one");

  painter.request(first);
  const second = pushSystemLine(first, "two");

  painter.request(second);

  assert.equal(io.written.length, 0, "the paint is deferred, not skipped");
  assert.equal(pending.length, 1, "and a pending paint coalesces rather than queueing");
  painter.settle(second);

  assert.deepEqual(io.written, ["\x1b[J", "one\ntwo\n"]);

  // The stale flush firing after settle must not draw over the settled screen.
  for (const flush of pending) {
    flush();
  }

  assert.deepEqual(io.written, ["\x1b[J", "one\ntwo\n"]);
});

type Scripted = {
  readonly ctx: CliContext;
  readonly out: string[];
  readonly err: string[];
  readonly root: string;
};

function scriptedCtx(stdinIsTty: boolean, lines: ReadonlyArray<string>): Scripted {
  const out: string[] = [];
  const err: string[] = [];
  const root = mkdtempSync(join(tmpdir(), "trylo-paint-"));
  const home = join(root, "home");
  const cwd = join(root, "workspace");

  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(home, ".trylo", "sessions"), { recursive: true });
  writeFileSync(join(home, ".trylo", "config.json"), JSON.stringify({ provider: "fixture" }));
  let at = 0;
  let ids = 0;
  const ctx: CliContext = {
    env: {},
    homeDir: home,
    cwd,
    nodeVersion: "v22.0.0",
    stdinIsTty,
    readFile: (file) => { try { return readFileSync(file, "utf8"); } catch { return undefined; } },
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

const TURN_EVENTS: ReadonlyArray<(scaffold: { sessionId: string; providerId: string; model: string }) => CliStreamEvent> = [
  (scaffold) => ({
    type: "run_start",
    sessionId: scaffold.sessionId,
    turnId: "turn-1",
    providerId: scaffold.providerId,
    model: scaffold.model,
  }),
  () => ({ type: "message_start" }),
  () => ({ type: "message_delta", text: "hello " }),
  () => ({ type: "message_delta", text: "from the model" }),
  () => ({ type: "message_end" }),
];

/** Emits a whole turn through the sink, one event at a time. */
function paintingRunner(): TuiTurnRunner {
  return async (scaffold, _text, sink: CliSink): Promise<TurnOutcome | never> => {
    for (const make of TURN_EVENTS) {
      sink.stdout(`${JSON.stringify(make(scaffold))}\n`);
    }

    const result = {
      type: "run_result" as const,
      status: "completed" as const,
      finishReason: "stop",
      sessionId: scaffold.sessionId,
      turnId: "turn-1",
      iterations: 1,
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      durationMs: 4,
      lastMessage: "hello from the model",
    };

    sink.stdout(`${JSON.stringify(result)}\n`);

    return { exitCode: 0, result, transcript: [], view: undefined, warnings: [] };
  };
}

test("A6: a turn in a terminal repaints in place, at least once", async () => {
  const scripted = scriptedCtx(true, []);
  let served = 0;
  const io = recordIo({
    readLine: async () => {
      served += 1;
      return served === 1 ? "hi" : undefined;
    },

    // Driven by hand: the paint runs the moment it is asked for, so the whole
    // turn is one deterministic sequence of writes.
    schedule: (flush) => flush(),
  });

  try {
    const code = await handleTui(scripted.ctx, io, paintingRunner());

    assert.equal(code, 0);

    const flat = io.written.join("");
    const ups = flat.match(/\x1b\[\d+A/g) ?? [];

    assert.equal(ups.length >= 1, true, "the turn was never repainted: this is not a live region");
    assert.equal((flat.match(/\x1b\[J/g) ?? []).length >= 2, true);

    // Every move is immediately followed by the clear that makes it safe.
    for (let at = 0; at < ups.length; at += 1) {
      const index = flat.indexOf(ups[at] ?? "");
      assert.equal(flat.slice(index + (ups[at] ?? "").length).startsWith("\x1b[J"), true);
    }

    assert.match(flat, /hello from the model/);
  } finally {
    rmSync(scripted.root, { recursive: true, force: true });
  }
});

test("A6: a piped session emits no cursor movement at all", async () => {
  const scripted = scriptedCtx(false, ["hi fixture", "/exit"]);
  try {
    const code = await handleReplEntry(scripted.ctx, {
      stdout: scripted.ctx.stdout,
      stderr: scripted.ctx.stderr,
    });

    assert.equal(code, 0);
    const flat = [...scripted.out, ...scripted.err].join("");

    assert.equal(flat.includes("\x1b["), false, "a piped run must not carry terminal escapes");
    assert.match(flat, /-> read_file/);
  } finally {
    rmSync(scripted.root, { recursive: true, force: true });
  }
});
