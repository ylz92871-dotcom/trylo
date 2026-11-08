import test from "node:test";
import assert from "node:assert/strict";
import { toolLearningInputTokenEstimate, toolConstructionReserve } from "./learning-resources.js";

test("admission preserves the ASCII estimate and accounts for CJK/emoji UTF-8 size", () => {
  assert.equal(toolLearningInputTokenEstimate(["abcd"]), 514);
  assert.equal(toolLearningInputTokenEstimate(["工具学习"]), 518);
  assert.equal(toolLearningInputTokenEstimate(["😀"]), 514);
  assert.equal(toolLearningInputTokenEstimate(["ab", "cd"], 10), 524);
  assert.equal(toolLearningInputTokenEstimate(["x"], NaN), Infinity);
});

test("construction guidance distinguishes two-phase npm work from a final decision without generation allowance", () => {
  const full = toolConstructionReserve({ callsRemaining: 8, tokensRemaining: 96000, prompt: "Plan a bounded tool improvement", route: "npm_tool" });
  assert.equal(full.calls, 2);
  assert.equal(full.tokens, 32000);
  assert.ok(full.affordableRoutes.includes("adapt"));
  const final = toolConstructionReserve({ callsRemaining: 1, tokensRemaining: 12000, prompt: "Make a final choice", route: "npm_tool" });
  assert.equal(final.afterPlanningCalls, 0);
  assert.equal(final.investigationCalls, 0);
  assert.ok(final.affordableRoutes.includes("reuse"));
  assert.equal(final.affordableRoutes.includes("create"), false);
  assert.equal(final.affordableRoutes.includes("adapt"), false);
});
