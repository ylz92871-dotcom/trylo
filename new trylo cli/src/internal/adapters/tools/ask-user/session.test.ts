import assert from "node:assert/strict";
import { test } from "node:test";
import { createAskUserTools } from "./index.js";

const signal = new AbortController().signal;
const questions = { questions: [{ id: "color", header: "颜色", question: "选择颜色？", options: [{ label: "蓝色", description: "蓝" }, { label: "红色", description: "红" }] }] };

test("a prepared question session accepts only actual user answers across turns", async () => {
  const port = createAskUserTools({ surfaceAnswersOnly: true });

  await port.execute({ name: "ask_user_question", toolCallId: "ask", arguments: questions }, signal);
  const id = port.pending()[0]?.requestId;

  assert(id);
  const spoofed = await port.execute({ name: "answer_user_question", toolCallId: "spoof", arguments: { requestId: id, answers: { color: "红色" } } }, signal);

  assert.equal(spoofed.outcome, "error");
  const accepted = port.answerFromUser(id, { color: "蓝色" });

  assert.equal(accepted.outcome, "result");
  assert.equal(port.pending().length, 0);
  assert.equal(port.answerFromUser(id, { color: "红色" }).outcome, "error");
});

test("settled question history does not consume the pending request ceiling", async () => {
  const port = createAskUserTools({ surfaceAnswersOnly: true });
  for (let i = 0; i < 100; i++) {
    const result = await port.execute({ name: "ask_user_question", toolCallId: `ask-${i}`, arguments: questions }, signal);
    assert.equal(result.outcome, "result");
    const id = port.pending()[0]?.requestId;
    assert(id);
    assert.equal(port.answerFromUser(id, { color: "蓝色" }).outcome, "result");
  }
});
