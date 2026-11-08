import assert from "node:assert/strict";
import { test } from "node:test";
import { createComposer } from "./composer.js";
import { renderComposer } from "./composer-view.js";
import { displayWidth } from "./frame.js";
import { emptyTuiState, reduceTuiEvent } from "./state.js";
import { statusBar } from "./status-bar.js";
import { createChoice } from "./choice.js";

test("the input prompt is visible before the first keystroke", () => {
  const output: string[] = [];
  const composer = createComposer({
    io: { write: text => output.push(text), columns: () => 80 },
    keys: { start: () => {}, suspend: () => {}, resume: () => {}, stop: () => {} },
  });

  void composer.compose("> ");
  assert.ok(output.join("").includes("> "));
  composer.stop();
});

test("Tab completes a command in the actual composer", async () => {
  let feed: (chunk: string) => void = () => {};
  const composer = createComposer({
    io: { write: () => {}, columns: () => 80 },
    keys: { start: handler => { feed = handler; }, suspend: () => {}, resume: () => {}, stop: () => {} },
  });
  const submitted = composer.compose("> ");

  feed("/comp");
  feed("\t");
  feed("\r");
  assert.equal(await submitted, "/compact");
  composer.stop();
});

test("Chinese rows without the cursor still fit the terminal", () => {
  const view = renderComposer({ text: "中".repeat(40) + "\nsecond", cursor: 41, prompt: "> ", footer: undefined }, 80);
  assert.ok(view.rows.every(row => displayWidth(row) <= 80));
});

test("the current model survives an 80-column completed status", () => {
  const state = emptyTuiState({ sessionId: "audit", providerId: "AMD", model: "DeepSeek-V4-Flash-Vision-Exp", maxIterations: 32, contextTokenLimit: 128000 });
  const completed = { ...state, iterations: 3, lastStatus: "completed", durationMs: 10200, usage: { inputTokens: 18422, outputTokens: 824, totalTokens: 19246 } };
  assert.ok(statusBar(completed, 80).includes("DeepSeek"));
});

test("an active tool renders its name instead of an object", () => {
  const state = emptyTuiState({ sessionId: "audit", providerId: "fixture", model: "default", maxIterations: 32, contextTokenLimit: undefined });
  const running = reduceTuiEvent(state, { type: "tool_use", toolCallId: "call-1", name: "read_file", input: { path: "src/main.ts" } });
  assert.ok(!statusBar(running, 160).includes("[object Object]"));
});

test("stopping typing releases the last character through the idle scheduler", async () => {
  const output: string[] = [];
  let feed: (chunk: string) => void = () => {};
  let flush = () => {};
  const composer = createComposer({
    io: { write: text => output.push(text), columns: () => 80 },
    keys: { start: handler => { feed = handler; }, suspend: () => {}, resume: () => {}, stop: () => {} },

    schedule: callback => {
      flush = callback;
      return () => {};
    },
  });
  const submitted = composer.compose("> ");

  feed("中");
  flush();
  assert.ok(output.join("").includes("中"));
  feed("\r");
  assert.equal(await submitted, "中");
  composer.stop();
});

test("a selector filters, confirms and cancels without sending a message", async () => {
  let feed: (chunk: string) => void = () => {};
  const composer = createComposer({
    io: { write: () => {}, columns: () => 80 },
    keys: { start: handler => { feed = handler; }, suspend: () => {}, resume: () => {}, stop: () => {} },
  });
  const request = { title: "模型", items: [{ id: "a", label: "Alpha" }, { id: "b", label: "Beta" }] };
  const selection = composer.choose(request);

  feed("Bet\r");
  assert.equal(await selection, "b");
  const cancelled = composer.choose(request);

  feed("\x1b");
  assert.equal(await cancelled, undefined);
  assert.equal(composer.takePending(), undefined);
  composer.stop();
});

test("filtering a choice to no results can still be cancelled", () => {
  const choice = createChoice({ title: "模型", items: [{ id: "a", label: "Alpha" }] });
  choice.key({ kind: "char", text: "xyz" });
  assert.equal(choice.key({ kind: "enter" }).kind, "continue");
  assert.deepEqual(choice.key({ kind: "escape" }), { kind: "done", id: undefined });
});

test("running input has a visible draft and delivers through capture", () => {
  let feed: (chunk: string) => void = () => {};
  let changes = 0;
  const received: string[] = [];
  const composer = createComposer({
    io: { write: () => {}, columns: () => 80 },
    keys: { start: handler => { feed = handler; }, suspend: () => {}, resume: () => {}, stop: () => {} },
    onCaptureChange: () => { changes += 1; },
  });

  composer.beginCapture(line => received.push(line));
  feed("\x1b[200~追加要求\x1b[201~");
  assert.equal(composer.captureView()?.text, "追加要求");
  assert.ok(changes > 0);
  feed("\r");
  assert.deepEqual(received, ["追加要求"]);
  composer.endCapture();
  assert.equal(composer.captureView(), undefined);
  composer.stop();
});
