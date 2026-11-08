import assert from "node:assert/strict";
import { test } from "node:test";
import { createAskUserTools } from "../../adapters/tools/ask-user/index.js";
import { restoreQuestions } from "../../adapters/tools/ask-user/recovery.js";
import { answerQuestionInput } from "./question-input.js";

const one = { id: "color", header: "颜色", question: "选择颜色？", options: [{ label: "蓝色", description: "蓝" }, { label: "红色", description: "红" }] };
const args = { questions: [one] };

test("actual user answer is consumed and reconstructed from the existing transcript", async () => {
  const owner = createAskUserTools({ surfaceAnswersOnly: true, nextRequestId: () => "ask-real" });
  const result = await owner.execute({ name: "ask_user_question", toolCallId: "ask", arguments: args }, new AbortController().signal);

  assert.equal(result.outcome, "result");

  if (result.outcome !== "result") throw new Error("ask refused");

  const text = await answerQuestionInput(owner, "蓝色", async () => undefined);

  assert.match(text, /选择颜色？ -> 蓝色/);
  assert.equal(owner.pending().length, 0);
  const restored = restoreQuestions([
    { kind: "tool_call", sequence: 0, toolCallId: "ask", name: "ask_user_question", arguments: args },
    { kind: "tool_result", sequence: 1, toolCallId: "ask", name: "ask_user_question", outcome: "succeeded", output: result.output, truncated: false },
    { kind: "user", sequence: 2, text },
  ]);

  assert.equal(restored[0]?.status, "answered");
  assert.equal(restored[0]?.answers?.["color"], "蓝色");
});

test("all questions need answers; EOF cancels instead of partially settling", async () => {
  const owner = createAskUserTools({ surfaceAnswersOnly: true });

  await owner.execute({ name: "ask_user_question", toolCallId: "ask", arguments: { questions: [one, { ...one, id: "other", header: "另一项", question: "另一种颜色？" }] } }, new AbortController().signal);
  const id = owner.pending()[0]?.requestId;

  assert(id);
  assert.equal(owner.answerFromUser(id, { color: "蓝色" }).outcome, "error");
  assert.equal(owner.pending().length, 1);
  const cancelled = await answerQuestionInput(owner, "蓝色", async () => undefined);

  assert.match(cancelled, /User cancelled request/);
  assert.equal(owner.pending().length, 0);
  assert.equal(owner.answerFromUser(id, { color: "红色", other: "红色" }).outcome, "error");
});

test("blank answers are reread without losing the question owner", async () => {
  const owner = createAskUserTools({ surfaceAnswersOnly: true });

  await owner.execute({ name: "ask_user_question", toolCallId: "ask", arguments: { questions: [one, { ...one, id: "other", header: "另一项", question: "另一种颜色？" }] } }, new AbortController().signal);
  const lines = ["   ", "蓝色", "", "红色"];
  const prompts: string[] = [];
  const answer = await answerQuestionInput(owner, "", async prompt => {
    prompts.push(prompt ?? "");
    return lines.shift();
  });

  assert.match(answer, /"color":"蓝色","other":"红色"/);
  assert.equal(owner.pending().length, 0);
  assert.equal(lines.length, 0);
  assert.equal(prompts.length, 4);
});

test("cancel at a later question cancels the whole request", async () => {
  const owner = createAskUserTools({ surfaceAnswersOnly: true });
  await owner.execute({ name: "ask_user_question", toolCallId: "ask", arguments: { questions: [one, { ...one, id: "other", header: "另一项", question: "另一种颜色？" }] } }, new AbortController().signal);
  const answer = await answerQuestionInput(owner, "蓝色", async () => "/cancel");
  assert.match(answer, /^User cancelled request/);
  assert.equal(owner.pending().length, 0);
});

test("EOF cancellation remains cancelled when the authoritative transcript is restored", async () => {
  const owner = createAskUserTools({ surfaceAnswersOnly: true, nextRequestId: () => "ask-eof" });
  const argumentsValue = { questions: [one, { ...one, id: "other", header: "另一项", question: "另一种颜色？" }] };
  const issued = await owner.execute({ name: "ask_user_question", toolCallId: "ask", arguments: argumentsValue }, new AbortController().signal);

  assert.equal(issued.outcome, "result");

  if (issued.outcome !== "result") throw new Error("ask refused");

  const text = await answerQuestionInput(owner, "蓝色", async () => undefined);
  const restored = restoreQuestions([
    { kind: "tool_call", sequence: 0, toolCallId: "ask", name: "ask_user_question", arguments: argumentsValue },
    { kind: "tool_result", sequence: 1, toolCallId: "ask", name: "ask_user_question", outcome: "succeeded", output: issued.output, truncated: false },
    { kind: "user", sequence: 2, text },
  ]);

  assert.equal(restored[0]?.status, "cancelled");
});

test("a legal reserved dictionary key is answered and restored without loss", async () => {
  const owner = createAskUserTools({ surfaceAnswersOnly: true, nextRequestId: () => "ask-key" });
  const argumentsValue = { questions: [{ ...one, id: "__proto__" }] };
  const issued = await owner.execute({ name: "ask_user_question", toolCallId: "ask", arguments: argumentsValue }, new AbortController().signal);
  if (issued.outcome !== "result") throw new Error("ask refused");

  const text = await answerQuestionInput(owner, "蓝色", async () => undefined);

  assert.match(text, /"__proto__":"蓝色"/);
  const restored = restoreQuestions([
    { kind: "tool_call", sequence: 0, toolCallId: "ask", name: "ask_user_question", arguments: argumentsValue },
    { kind: "tool_result", sequence: 1, toolCallId: "ask", name: "ask_user_question", outcome: "succeeded", output: issued.output, truncated: false },
    { kind: "user", sequence: 2, text },
  ]);

  assert.equal(restored[0]?.status, "answered");
  assert.equal(restored[0]?.answers?.["__proto__"], "蓝色");
});
