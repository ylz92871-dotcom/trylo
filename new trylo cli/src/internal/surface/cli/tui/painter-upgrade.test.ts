import assert from "node:assert/strict";
import { test } from "node:test";
import { createPainter } from "./painter.js";
import { emptyTuiState } from "./state.js";

const facts = { sessionId: "ui", providerId: "fixture", model: "default", maxIterations: 32, contextTokenLimit: undefined };

test("completed long output stays in scrollback and only the live tail is repainted", () => {
  const output: string[] = [];
  const painter = createPainter({ readLine: async () => undefined, write: text => output.push(text), size: () => ({ columns: 80, rows: 10 }), schedule: flush => flush() }, 0);
  const lines = Array.from({ length: 25 }, (_, index) => ({ tone: "assistant" as const, text: `row-${index}` }));
  const state = { ...emptyTuiState(facts), lines };

  painter.request(state);
  painter.request({ ...state, lines: [...lines, { tone: "assistant", text: "tail" }] });
  painter.settle({ ...state, lines: [...lines, { tone: "assistant", text: "tail" }] });
  const text = output.join("");

  assert.equal(text.split("row-0\n").length - 1, 1, "committed text must not be redrawn");
  const moves = [...text.matchAll(/\x1b\[(\d+)A/g)].map(match => Number(match[1]));

  assert.ok(moves.every(count => count < 10), "redraw cannot reach above the viewport");
  assert.ok(text.includes("row-24\n") && text.includes("tail\n"));
});

test("a tall streaming preview is bounded but settles with the complete message", () => {
  const output: string[] = [];
  const painter = createPainter({ readLine: async () => undefined, write: text => output.push(text), size: () => ({ columns: 80, rows: 10 }), schedule: flush => flush() }, 0);
  const text = Array.from({ length: 30 }, (_, index) => `stream-${index}`).join("\n");
  const state = { ...emptyTuiState(facts), pending: { text } };

  painter.request(state);
  assert.ok(output.join("").includes("stream-29"));
  output.length = 0;
  painter.settle(state);
  assert.ok(output.join("").includes(text));
  const move = Number(/\x1b\[(\d+)A/.exec(output.join(""))?.[1] ?? 0);

  assert.ok(move < 10, "settle clears only the bounded preview");
});
