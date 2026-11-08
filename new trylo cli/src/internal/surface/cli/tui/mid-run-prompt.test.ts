import assert from "node:assert/strict";
import { test } from "node:test";
import { createComposer } from "./composer.js";
import { createMidRunInput } from "./mid-run-input.js";

test("a fresh prompt remains visible after a slash command", async () => {
  let feed: (chunk: string) => void = () => {};
  const output: string[] = [];
  const io = { write: (text: string) => output.push(text), readLine: async () => undefined, size: () => ({ columns: 80, rows: 24 }) };
  const composer = createComposer({
    io: { write: io.write, columns: () => 80 },
    keys: { start: handler => { feed = handler; }, suspend: () => {}, resume: () => {}, stop: () => {} },
  });
  const mid = createMidRunInput({ io, composer });

  try {
    const first = mid.takeLine();

    assert.ok(output.join("").includes("> "));
    feed("/status\r");
    assert.equal(await first, "/status");
    output.length = 0;
    const second = mid.takeLine();

    assert.ok(output.join("").includes("> "), "the next prompt must appear before typing");
    feed("/exit\r");
    assert.equal(await second, "/exit");
  } finally {
    composer.stop();
  }
});
