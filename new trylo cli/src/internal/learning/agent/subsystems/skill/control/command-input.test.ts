import assert from "node:assert/strict";
import test from "node:test";
import { isSkillFocus, isSkillIssueReference } from "./command-input.js";

const focus = { issueId: "skill-issue:one", expectedRevision: 1, reason: "Explicit user allocation for this reported task.",
  sourceRefs: ["journal:session:turn"], allowance: { schemaVersion: 2, unit: "total_model_tokens", maxTokens: 1000,
    maxCalls: 2, maxSteps: 2, maxPromptChars: 8000 } };

test("skill focus accepts the complete canonical central allowance without creating defaults", () => {
  assert.ok(isSkillFocus(focus));
  assert.equal(isSkillFocus({ ...focus, allowance: { maxOutputTokens: 1000, maxCalls: 2 } }), false);
  assert.equal(isSkillFocus({ ...focus, allowance: { ...focus.allowance, unit: "output_tokens" } }), false);
  assert.equal(isSkillFocus({ ...focus, allowance: { ...focus.allowance, maxTokens: 0 } }), false);
  assert.equal(isSkillFocus({ ...focus, allowance: { ...focus.allowance, maxSteps: undefined } }), false);
  assert.equal(isSkillFocus({ ...focus, unexpected: true }), false);
});

test("skill focus reuses central decision limits and rejects malformed issue references", () => {
  assert.equal(isSkillFocus({ ...focus, expectedRevision: -1 }), false);
  assert.equal(isSkillFocus({ ...focus, reason: "x".repeat(1001) }), false);
  assert.equal(isSkillFocus({ ...focus, sourceRefs: ["same", "same"] }), false);
  assert.equal(isSkillFocus({ ...focus, sourceRefs: ["x".repeat(513)] }), false);
  assert.equal(isSkillFocus({ ...focus, issueId: "unsafe\nissue" }), false);
  for (const value of [undefined, null, [], "", " ", "x".repeat(513), "issue\u0000id"]) assert.equal(isSkillIssueReference(value), false);
});
