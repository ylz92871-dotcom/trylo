import assert from "node:assert/strict";
import { test } from "node:test";

import { MAX_TOOL_OUTPUT_BYTES, boundToolOutput } from "./tool-execution.js";

/**
 * The loop's own output bound must keep the **tail**, not only the head.
 *
 * The adapters' truncation module exists because "a build log's last line is the
 * error", and `shell-tool.ts` puts the failure advisory and the `[stderr]` block
 * at the *end* of a command's result. A bound that keeps only the head therefore
 * destroys exactly the bytes the model needs to understand a failure — however
 * careful its byte arithmetic is. Correct byte counting is not the same property
 * as keeping the outcome, and only the first one had a test.
 */

const bytesOf = (text: string): number => Buffer.byteLength(text, "utf8");

test("a payload over the bound keeps its tail, not just its head", () => {
  const head = "h".repeat(MAX_TOOL_OUTPUT_BYTES);
  const bounded = boundToolOutput(`${head}TAIL-ERROR: cannot find module`, false);

  assert.equal(bounded.truncated, true, "a payload this size is certainly cut");
  assert.equal(
    bounded.output.includes("TAIL-ERROR"),
    true,
    "the tail carries the outcome; a head-only cut throws away the reason the command failed",
  );
  assert.equal(bytesOf(bounded.output) <= MAX_TOOL_OUTPUT_BYTES, true, "the bound still holds");
});

test("the cut still walks code points when it comes from either end", () => {
  const wide = "汉".repeat(MAX_TOOL_OUTPUT_BYTES);
  const bounded = boundToolOutput(`${wide}尾部错误`, false);

  assert.equal(bounded.output.includes("\uFFFD"), false, "no half character may survive the cut");
  assert.equal(bytesOf(bounded.output) <= MAX_TOOL_OUTPUT_BYTES, true);
  assert.equal(bounded.output.includes("尾部错误"), true, "the multi-byte tail survives too");
});

test("a payload inside the bound is returned untouched", () => {
  const small = "all good";
  assert.deepEqual(boundToolOutput(small, false), { output: small, truncated: false });
});

test("an oversized adapter result is bounded once, with a single marker", () => {
  const value = "x".repeat(MAX_TOOL_OUTPUT_BYTES * 2);
  const bounded = boundToolOutput(value, true);

  assert.equal(bounded.truncated, true);
  assert.equal(
    bounded.output.split("[truncated]").length,
    2,
    "one marker per cut: a second one would misreport how much was lost",
  );
});
