import assert from "node:assert/strict";
import test from "node:test";
import { isSkillExplicitInput } from "./explicit-input.js";

test("explicit skill input binds one actual session and an output allowance, never a total-token allowance", () => {
  const input = { workspaceRoot: "D:/repo", sessionId: "desktop-canonical", learnRequest: "Retain the revised build method.",
    allowance: { maxCalls: 4, maxOutputTokens: 8000 } };
  assert.equal(isSkillExplicitInput(input), true);
  assert.equal(isSkillExplicitInput({ ...input, turnId: "actual-turn" }), true);
  for (const value of [{ ...input, sessionId: "" }, { ...input, learnRequest: "" }, { ...input, allowance: { maxCalls: 4, maxTokens: 8000 } },
    { ...input, allowance: { maxCalls: 4, maxOutputTokens: -1 } }, { ...input, transcript: "Renderer-authored evidence" }]) assert.equal(isSkillExplicitInput(value), false);
});
