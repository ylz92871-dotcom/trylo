import assert from "node:assert/strict";
import { test } from "node:test";
import { truncateOutput } from "./output-limits.js";

test("byte and line ceilings compose without excess, surrogate damage or negative loss", () => {
  const samples = ["中👍é𝔘".repeat(80), "a\n".repeat(60), "HEAD\n" + "noise\n".repeat(100) + "TAIL-ERROR"];
  for (const source of samples) for (const maxBytes of [0, 1, 4, 7, 8, 20, 32, 40, 64, 129, 200, 512]) for (const maxLines of [0, 1, 2, 3, 6, 20]) {
    const result = truncateOutput(source, { maxBytes, maxLines });
    const label = JSON.stringify({ maxBytes, maxLines });
    assert.ok(Buffer.byteLength(result.text) <= maxBytes, label);
    assert.ok(result.text === "" || result.text.split("\n").length <= maxLines, label);
    assert.equal(Buffer.from(result.text).toString("utf8"), result.text, label);
    assert.ok(result.omittedBytes >= 0, label);
    assert.equal(result.omittedBytes, Buffer.byteLength(source) - Buffer.byteLength(result.text), label);
  }
});

test("a line-only cut cannot claim zero bytes were omitted when source bytes were removed", () => {
  const result = truncateOutput("line\n".repeat(100), { maxBytes: 2000, maxLines: 5 });
  assert.ok(result.omittedBytes > 400);
  assert.doesNotMatch(result.text, /0 bytes omitted/);
  assert.match(result.text, /lines omitted/);
});

test("numeric loss markers agree with their metadata across decimal digit boundaries", () => {
  for (let size = 40; size < 1200; size += 1) for (const maxBytes of [32, 40, 64, 100, 200]) {
    const result = truncateOutput("x".repeat(size), { maxBytes });
    const marker = result.text.match(/(\d+) bytes omitted/);
    if (marker !== null) assert.equal(Number(marker[1]), result.omittedBytes, JSON.stringify({ size, maxBytes }));
  }
});
