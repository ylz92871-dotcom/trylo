import assert from "node:assert/strict";
import test from "node:test";
import { isLearningSwitch } from "../../integration/user-learning/switch.js";
import { FAMILY_COMMAND_WORDS } from "./command-vocabulary.js";
import { isApprovableToolName } from "./permission-plan.js";

test("daily skill learning has its own collection switch and command family", () => {
  assert.equal(isLearningSwitch("skill"), true);
  assert.ok((FAMILY_COMMAND_WORDS as readonly string[]).includes("skills"));
});

test("a caller can explicitly approve the real skill loading tool", () => {
  assert.equal(isApprovableToolName("skill"), true);
});
