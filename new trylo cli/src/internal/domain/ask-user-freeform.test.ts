import assert from "node:assert/strict";
import { test } from "node:test";
import { validateAskUserInput } from "./ask-user.js";

test("a proactive account question can use free text without fake predefined accounts", () => {
  const result = validateAskUserInput({ questions: [{ id: "accounts", header: "网页账号", question: "你有哪些可用的图片或视频网页账号？" }] });
  assert.ok(result.ok);
  if (result.ok) assert.deepEqual(result.questions[0]?.options, []);
});
