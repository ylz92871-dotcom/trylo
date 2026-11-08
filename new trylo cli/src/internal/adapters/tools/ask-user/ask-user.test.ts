import assert from "node:assert/strict";
import { test } from "node:test";
import { createAskUserTools } from "./index.js";
import type { ToolCallRequest } from "../../../ports/tools.js";
import type { JsonObject } from "../../../protocol/envelope.js";

function call(toolCallId: string, name: string, args: JsonObject): ToolCallRequest {
  return { toolCallId, name, arguments: args };
}

function questions(): JsonObject {
  return {
    questions: [
      {
        header: "Auth",
        question: "Which auth method should we use?",
        options: [
          { label: "OAuth", description: "Delegated login via provider." },
          { label: "API key", description: "Long-lived secret in config." },
        ],
      },
      {
        id: "scope_pick",
        header: "Scope",
        question: "Which scope should we enable?",
        options: [
          { label: "Read", description: "Read-only access." },
          { label: "Write", description: "Read and write access." },
        ],
        multiSelect: true,
      },
    ],
  };
}

function resultValue(outcome: unknown): JsonObject {
  assert.equal((outcome as { outcome: string }).outcome, "result");
  return (outcome as { outcome: "result"; value: JsonObject }).value;
}

function resultOutput(outcome: unknown): string {
  assert.equal((outcome as { outcome: string }).outcome, "result");
  return (outcome as { outcome: "result"; output: string }).output;
}

function errorCode(outcome: unknown): string {
  assert.equal((outcome as { outcome: string }).outcome, "error");
  return (outcome as { outcome: "error"; code: string }).code;
}

test("ask_user_question validates shape before creating anything", async () => {
  const port = createAskUserTools();
  const signal = new AbortController().signal;
  const bad = await port.execute(call("t1", "ask_user_question", { questions: [] }), signal);

  assert.equal(bad.outcome, "error");
  const duplicate = await port.execute(
    call("t2", "ask_user_question", {
      questions: [
        {
          header: "A",
          question: "Same?",
          options: [
            { label: "X", description: "x." },
            { label: "Y", description: "y." },
          ],
        },
        {
          header: "B",
          question: "Same?",
          options: [
            { label: "X", description: "x." },
            { label: "Y", description: "y." },
          ],
        },
      ],
    }),
    signal,
  );

  assert.equal(duplicate.outcome, "error");
});

test("ask then answer drives the next step; late and duplicate answers are rejected", async () => {
  const port = createAskUserTools();
  const signal = new AbortController().signal;
  const asked = await port.execute(call("t1", "ask_user_question", questions()), signal);
  const requestId = resultValue(asked)["requestId"];

  assert.equal(typeof requestId, "string");
  assert.match(requestId as string, /^ask-/);

  const answered = await port.execute(
    call("t2", "answer_user_question", {
      requestId: requestId as string,
      answers: { auth: "OAuth", scope_pick: "Read, Write" },
    }),
    signal,
  );
  const output = resultOutput(answered);

  assert.match(output, /Which auth method/);
  assert.match(output, /OAuth/);

  const late = await port.execute(
    call("t3", "answer_user_question", {
      requestId: requestId as string,
      answers: { auth: "API key" },
    }),
    signal,
  );

  assert.equal(errorCode(late), "late_answer_rejected");

  const unknown = await port.execute(
    call("t4", "answer_user_question", { requestId: "ask-999", answers: { auth: "OAuth" } }),
    signal,
  );

  assert.equal(unknown.outcome, "error");
});

test("answers carry input only: bindings are read-only and approval-free", () => {
  const port = createAskUserTools();

  for (const binding of port.snapshot()) {
    assert.equal(binding.sideEffect, "read_only");
    assert.equal(binding.needsApproval, false);
  }

  const names = port.snapshot().map((binding) => binding.name);

  assert.ok(names.includes("ask_user_question"));
  assert.ok(names.includes("answer_user_question"));
  assert.ok(names.includes("request_user_input_async"));
  assert.ok(names.includes("send_message_to_user_async"));
});

test("async ask returns immediately with the same validation", async () => {
  const port = createAskUserTools();
  const signal = new AbortController().signal;
  const single: JsonObject = {
    questions: [
      {
        header: "Auth",
        question: "Which auth method should we use?",
        options: [
          { label: "OAuth", description: "Delegated login via provider." },
          { label: "API key", description: "Long-lived secret in config." },
        ],
      },
    ],
  };
  const asked = await port.execute(call("t1", "request_user_input_async", single), signal);
  const output = resultOutput(asked);

  assert.match(output, /continue working/);
});
