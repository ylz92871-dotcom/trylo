import assert from "node:assert/strict";
import { test } from "node:test";
import { ARTWORK_ASPECT, banner, CELL_ASPECT, TRYLO_MARK } from "./banner.js";
import type { CliContext } from "../context.js";
import { DEFAULT_WIDTH, displayWidth, renderFrame } from "./frame.js";
import { lineIoOf } from "./io.js";
import { emptyTuiState, pushUserLine, reduceTuiEvent, type TuiFacts } from "./state.js";
import { colorDepthOf, colorPaint, markPainterFor, noPaint, stripAnsi } from "./theme.js";

/**
 * Visibility: the screen must carry what the turn already knows.
 *
 * Every case here is about information the event stream *already holds* and
 * the frame *already throws away*. Nothing in this file asks for a new event
 * field or a new protocol shape: `tool_result` carries `output` and `message`,
 * `usage` carries the counts, `TuiLine` carries a `tone` — and until this
 * work-package none of the three reached the screen. These are the tests that
 * were red before the fix, which is what makes them worth keeping.
 */

const FACTS: TuiFacts = {
  sessionId: "repl-1",
  providerId: "fixture",
  model: "default",
  maxIterations: 8,
  contextTokenLimit: undefined,
};

/** Strip SGR sequences: what a person reads, not what the terminal parses. */
function plain(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function after(events: ReadonlyArray<Parameters<typeof reduceTuiEvent>[1]>): string {
  let state = emptyTuiState(FACTS);
  for (const event of events) {
    state = reduceTuiEvent(state, event);
  }
  return renderFrame(state, 80);
}

test("a tool's own output reaches the screen", () => {
  const frame = after([
    { type: "tool_use", toolCallId: "c1", name: "read_file" },
    { type: "tool_result", toolCallId: "c1", status: "ok", output: "148 lines", truncated: false },
  ]);
  assert.match(plain(frame), /148 lines/, "the tool's output was not rendered");
});

test("a failed tool says why, on the screen", () => {
  const frame = after([
    { type: "tool_use", toolCallId: "c1", name: "run_shell" },
    {
      type: "tool_result",
      toolCallId: "c1",
      status: "error",
      output: "",
      truncated: false,
      message: "npm test exited 1: 2 tests failed",
    },
  ]);
  assert.match(plain(frame), /npm test exited 1/, "the failure reason was not rendered");
});

test("a truncated result is marked as truncated", () => {
  const frame = after([
    { type: "tool_use", toolCallId: "c1", name: "run_shell" },
    { type: "tool_result", toolCallId: "c1", status: "ok", output: "many lines", truncated: true },
  ]);
  assert.match(plain(frame), /truncat/i);
});

test("a long tool output is folded to a few lines instead of flooding the screen", () => {
  const output = Array.from({ length: 60 }, (_, at) => `line ${at}`).join("\n");
  const frame = after([
    { type: "tool_use", toolCallId: "c1", name: "run_shell" },
    { type: "tool_result", toolCallId: "c1", status: "ok", output, truncated: false },
  ]);
  const shown = plain(frame).split("\n").filter((line) => line.includes("line "));

  assert.equal(shown.length <= 6, true, `${shown.length} output lines were rendered`);
  assert.match(plain(frame), /more/i, "a folded output says how much is hidden");
});

test("different tones render as different bytes", () => {
  // Colour is a parameter, so a tone is only distinguishable when the terminal
  // asked for it; the uncoloured frame is pinned by the case below instead.
  const drawn = (tone: "user" | "assistant" | "reasoning" | "tool" | "warning"): string => {
    const state = { ...emptyTuiState(FACTS), lines: [{ tone, text: "same text" }] };
    return renderFrame(state, 80, colorPaint());
  };
  const assistant = drawn("assistant");

  assert.notEqual(drawn("user"), assistant, "a user line looks like an assistant line");
  assert.notEqual(drawn("reasoning"), assistant, "reasoning looks like an assistant line");
  assert.notEqual(drawn("tool"), assistant, "a tool line looks like an assistant line");
  assert.notEqual(drawn("warning"), assistant, "a warning looks like an assistant line");
});

test("a frame drawn without colour is exactly what it always was", () => {
  const state = {
    ...emptyTuiState(FACTS),
    lines: [
      { tone: "warning" as const, text: "disk almost full" },
      { tone: "tool" as const, text: "-> run_shell" },
    ],
  };

  assert.equal(renderFrame(state, 80), renderFrame(state, 80, noPaint));

  for (const line of renderFrame(state, 80).split("\n").slice(0, 2)) {
    assert.equal(line.includes("\x1b["), false, "a content line carries a sequence");
  }
});

test("a tone's colour never swallows the text", () => {
  const state = {
    ...emptyTuiState(FACTS),
    lines: [{ tone: "warning" as const, text: "disk almost full" }],
  };
  assert.match(plain(renderFrame(state, 80)), /disk almost full/);
});

test("usage reaches the status bar", () => {
  const frame = after([
    {
      type: "usage",
      usage: { inputTokens: 18422, outputTokens: 913, totalTokens: 19335 },
    },
  ]);

  assert.match(plain(frame), /18\.4k|18422/, "input tokens are not on the screen");
  assert.match(plain(frame), /913/, "output tokens are not on the screen");
});

test("the turn's duration reaches the status bar", () => {
  const frame = after([
    {
      type: "run_result",
      status: "completed",
      finishReason: "stop",
      sessionId: "repl-1",
      turnId: "t-1",
      iterations: 3,
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      durationMs: 41_300,
      lastMessage: "",
    },
  ]);
  assert.match(plain(frame), /41\.3s|41s/, "the turn's duration is not on the screen");
});

test("a narrow terminal keeps the highest-value fields and drops the rest", () => {
  const state = pushUserLine(emptyTuiState({ ...FACTS, sessionId: "repl-with-a-very-long-id" }), "hi");
  const bar = plain(renderFrame(state, 30)).split("\n").filter((line) => line.length > 0).at(-1) ?? "";
  assert.equal(bar.length <= 30, true, `${bar.length} columns in a 30-column terminal`);
  assert.match(bar, /fixture\/default/, "the current model must survive before diagnostics");
});

/** A context that either can measure its terminal or cannot. */
function contextMeasuring(columns: number | undefined): CliContext {
  return {
    env: {},
    homeDir: "/home",
    cwd: "/cwd",
    nodeVersion: "v22.0.0",
    stdinIsTty: true,
    readFile: () => undefined,
    isDirectory: () => true,
    readDir: () => [],
    writeFile: () => true,
    readStdin: async () => "",
    readLine: async () => undefined,
    readSecret: async () => undefined,
    stdout: () => undefined,
    stderr: () => undefined,
    now: () => 0,
    newId: (prefix) => `${prefix}-1`,
    ...(columns === undefined ? {} : { terminalSize: () => ({ columns, rows: 40 }) }),
  };
}

test("the shell measures the real terminal when the root supplies one", () => {
  assert.equal(lineIoOf(contextMeasuring(132)).size().columns, 132);
});

test("and falls back to the fixed width when there is no terminal to measure", () => {
  assert.equal(lineIoOf(contextMeasuring(undefined)).size().columns, DEFAULT_WIDTH);
});

test("the startup mark carries the captions beside it when there is room", () => {
  const lines = banner(["trylo", "learning agent CLI"], 80).lines;

  assert.equal(lines.length, TRYLO_MARK.length);
  assert.match(lines[0] ?? "", /trylo/);
  assert.match(lines[1] ?? "", /learning agent CLI/);

  for (const line of lines) {
    assert.equal(displayWidth(line) <= 80, true, `${displayWidth(line)} columns`);
  }
});

test("and drops the mark rather than crowding a narrow terminal", () => {
  assert.deepEqual(banner(["trylo"], 20).lines, ["trylo"]);
});

test("colour depth is only claimed when the terminal says so", () => {
  assert.equal(colorDepthOf({ COLORTERM: "truecolor" }, true), "truecolor");
  assert.equal(colorDepthOf({ COLORTERM: "24bit" }, true), "truecolor");
  assert.equal(colorDepthOf({}, true), "ansi16");
  assert.equal(colorDepthOf({ COLORTERM: "truecolor" }, false), "none");
  assert.equal(colorDepthOf({ COLORTERM: "truecolor", NO_COLOR: "1" }, true), "none");
  assert.equal(colorDepthOf({ COLORTERM: "truecolor", TERM: "dumb" }, true), "none");
});

test("the mark is painted in the brand's own ramp, bone down to accent gold", () => {
  const paint = markPainterFor("truecolor", 3);
  assert.equal(paint("███", 0), "\x1b[38;2;242;237;225m███\x1b[0m");
  assert.equal(paint("███", 1), "\x1b[38;2;231;219;176m███\x1b[0m");
  assert.equal(paint("███", 2), "\x1b[38;2;220;201;126m███\x1b[0m");
  // Nothing a width measurement has to know about survives the strip.
  for (const at of [0, 1, 2]) assert.equal(stripAnsi(paint("███", at)), "███");
});

test("and a terminal that cannot do colour gets the rows untouched", () => {
  assert.equal(markPainterFor("none", 16)("█", 3), "█");
  assert.equal(markPainterFor("ansi16", 16)("█", 3), "\x1b[97m█\x1b[0m");
});

test("the mark's colour stops at the mark: the caption stays its own tone", () => {
  const lines = banner(["trylo", "learning agent CLI"], 80, (row, at) => `<${at}>${row}</>`).lines;
  assert.equal(lines[0], `<0>${TRYLO_MARK[0]}</>   trylo`);
  assert.equal(lines[1], `<1>${TRYLO_MARK[1]}</>   learning agent CLI`);
  assert.equal(lines[2], `<2>${TRYLO_MARK[2]}</>`);
});

/**
 * The mark's ratio is measured against a real terminal cell, not an assumed
 * one. The previous version of this test asserted 40 columns on the strength of
 * "Cascadia Mono is about 0.55em x 1.35em" — a 1:2.45 cell. A screenshot of the
 * running CLI says otherwise: the mark's solid stem measured 70px across 5
 * columns and 16 rows measured 448px tall, so the cell is 14 x 28 px, exactly
 * 1:2, and a 40x16 grid rendered 22% too wide. What is asserted here is the
 * consequence rather than the grid: whatever the grid is, the picture it makes
 * has to have the artwork's proportions.
 */
test("the mark keeps the artwork's proportions at a measured terminal cell", () => {
  assert.equal(TRYLO_MARK.length, 16);
  const widest = Math.max(...TRYLO_MARK.map((row) => displayWidth(row)));

  // The stroke weight is the part most easily lost: the artwork's stroke is
  // 13% of its width, and the grid has to carry it at 4-5 cells wide.
  assert.equal(widest >= 28, true, `only ${widest} columns — the mark would render thin`);
  const rendered = (widest * CELL_ASPECT) / TRYLO_MARK.length;

  assert.equal(
    Math.abs(rendered / ARTWORK_ASPECT - 1) < 0.03,
    true,
    `${rendered.toFixed(4)} against the artwork's ${ARTWORK_ASPECT.toFixed(4)} — off by ${(
      (rendered / ARTWORK_ASPECT - 1) *
      100
    ).toFixed(1)}%`,
  );

  // Every row must be printable without wrapping in the width the mark claims.
  for (const row of TRYLO_MARK) {
    assert.equal(row.includes("\n"), false);
  }
});

test("a running turn shows it is alive", () => {
  const running = { ...emptyTuiState(FACTS), running: true };
  const bar = (tick: number): string => {
    const frame = renderFrame(running, 80, noPaint, tick);
    return plain(frame).split("\n").filter((line) => line.length > 0).at(-1) ?? "";
  };

  assert.match(bar(0), /running/);
  // The glyph must change: a screen that never changes reads as a hung
  // process, which is why people press ctrl-c on turns that are still working.
  assert.notEqual(bar(0), bar(1), "the spinner does not move");
  assert.notEqual(bar(1), bar(2), "the spinner does not move");
  // And it must come back around, rather than growing a new glyph forever.
  assert.equal(bar(0), bar(10), "the spinner does not cycle");
});

test("a long reasoning block is folded once it is finished", () => {
  let state = reduceTuiEvent(emptyTuiState(FACTS), { type: "reasoning_start", redacted: false });

  for (const at of [0, 1, 2, 3, 4, 5, 6]) {
    state = reduceTuiEvent(state, { type: "reasoning_delta", text: `思考第 ${at} 步` });
  }

  assert.equal(state.lines.length, 7, "thinking still streams while it happens");
  state = reduceTuiEvent(state, { type: "reasoning_end" });
  const texts = state.lines.map((line) => line.text);

  assert.equal(texts.length, 3, `folded to ${texts.length} lines`);
  assert.match(texts.at(-1) ?? "", /5 more lines/, "the hidden reasoning is counted, not dropped");
  assert.match(texts[0] ?? "", /思考第 0 步/);
});

test("a short reasoning block is left alone", () => {
  let state = reduceTuiEvent(emptyTuiState(FACTS), { type: "reasoning_start", redacted: false });
  state = reduceTuiEvent(state, { type: "reasoning_delta", text: "只两步" });
  state = reduceTuiEvent(state, { type: "reasoning_delta", text: "够了" });
  state = reduceTuiEvent(state, { type: "reasoning_end" });
  assert.equal(state.lines.length, 2, "short thinking must not be folded");
});

test("a turn that never reasoned is not disturbed by reasoning_end", () => {
  const state = reduceTuiEvent(emptyTuiState(FACTS), { type: "reasoning_end" });
  assert.equal(state.lines.length, 0);
});

test("a diff a tool printed is coloured by what it says", () => {
  let state = reduceTuiEvent(emptyTuiState(FACTS), {
    type: "tool_use",
    toolCallId: "c1",
    name: "edit_file",
  });

  state = reduceTuiEvent(state, {
    type: "tool_result",
    toolCallId: "c1",
    status: "ok",
    output: "--- a/retry.ts\n+++ b/retry.ts\n-old line\n+new line",
    truncated: false,
  });
  const tones = state.lines.map((line) => line.tone);

  assert.equal(tones.includes("added"), true, "the added row is not marked");
  assert.equal(tones.includes("removed"), true, "the removed row is not marked");
  // The file headers are navigation, not change: painting them the colour of
  // the rows under them makes a header read as a whole file added.
  const headers = state.lines.filter((line) => /^\s+(---|\+\+\+)/.test(line.text));

  assert.equal(headers.length, 2);
  assert.deepEqual(headers.map((line) => line.tone), ["output", "output"]);
});

test("a bulleted list a tool printed is not painted as a diff", () => {
  let state = reduceTuiEvent(emptyTuiState(FACTS), {
    type: "tool_use",
    toolCallId: "c1",
    name: "run_shell",
  });

  state = reduceTuiEvent(state, {
    type: "tool_result",
    toolCallId: "c1",
    status: "ok",
    output: "- first item\n- second item\n+ also a bullet",
    truncated: false,
  });
  const tones = new Set(state.lines.map((line) => line.tone));

  assert.equal(tones.has("added"), false, "a bullet was painted as an added row");
  assert.equal(tones.has("removed"), false, "a bullet was painted as a removed row");
});

test("a user line and a system line are told apart without colour too", () => {
  let state = pushUserLine(emptyTuiState(FACTS), "fix the retry bug");

  state = reduceTuiEvent(state, {
    type: "warning",
    code: "usage_unreported",
    message: "provider returned no usage",
  });
  const body = plain(renderFrame(state, 80)).split("\n");
  const user = body.find((line) => line.includes("fix the retry bug")) ?? "";
  const warning = body.find((line) => line.includes("usage_unreported")) ?? "";

  assert.match(user, /^>/, "the user's own line has no marker");
  assert.match(warning, /warning/i);
});
