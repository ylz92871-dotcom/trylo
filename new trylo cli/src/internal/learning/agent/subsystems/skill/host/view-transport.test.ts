import assert from "node:assert/strict";
import test from "node:test";
import { MAX_TOOL_OUTPUT_BYTES } from "../../../../../loop/tool-execution.js";
import { HERMES_VIEW_MAX_BYTES_ENV, isCompleteHermesViewOutput, withHermesViewTransportBudget } from "./view-transport.js";

test("view profiles carry the canonical host byte ceiling without mutating the worker profile", () => {
  const original = { name: "fixture", command: "python", args: [], allowedTools: [],
    env: { HERMES_HOME: "synthetic-home", [HERMES_VIEW_MAX_BYTES_ENV]: "1" } };
  const profile = withHermesViewTransportBudget(original);
  assert.equal(profile.env[HERMES_VIEW_MAX_BYTES_ENV], String(MAX_TOOL_OUTPUT_BYTES));
  assert.equal(profile.env.HERMES_HOME, "synthetic-home");
  assert.equal(original.env[HERMES_VIEW_MAX_BYTES_ENV], "1");
});

test("complete view admission measures UTF-8 bytes and rejects existing truncation", () => {
  assert.equal(isCompleteHermesViewOutput({ output: "a".repeat(MAX_TOOL_OUTPUT_BYTES), truncated: false }), true);
  assert.equal(isCompleteHermesViewOutput({ output: "a".repeat(MAX_TOOL_OUTPUT_BYTES + 1), truncated: false }), false);
  assert.equal(isCompleteHermesViewOutput({ output: "complete JSON but flagged partial", truncated: true }), false);
  const output = JSON.stringify({ success: true, name: "synthetic", content: "😀".repeat(17_000) });

  assert.ok([...output].length < 20_000);
  assert.ok(Buffer.byteLength(output, "utf8") > MAX_TOOL_OUTPUT_BYTES);
  assert.equal(isCompleteHermesViewOutput({ output, truncated: false }), false);
});
