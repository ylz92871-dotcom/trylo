import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyTuiState, reduceTuiEvent, type TuiState } from "./state.js";
import { statusBar } from "./status-bar.js";

/**
 * WP23.3 (L44): the shell says why it is waiting, from facts events said.
 *
 * A question the model asked, a plan the model submitted, and a call still in
 * flight are three different kinds of waiting a person can act on — answer,
 * approve, cancel — and the bar names the kind while the panel names the
 * details. Both are drawn from the same call, so they cannot disagree.
 */

const FACTS = {
  sessionId: "repl-1",
  providerId: "fixture",
  model: "default",
  maxIterations: 8,
  contextTokenLimit: undefined,
};

function askCall(): TuiState {
  let state = reduceTuiEvent(emptyTuiState(FACTS), {
    type: "tool_use",
    toolCallId: "call-1",
    name: "ask_user_question",
    input: {
      questions: [
        {
          id: "auth",
          header: "Auth",
          question: "Which auth method should we use?",
          options: [
            { label: "OAuth", description: "Delegated login via provider." },
            { label: "API key", description: "Long-lived secret in config." },
          ],
        },
      ],
    },
  });

  state = reduceTuiEvent(state, {
    type: "tool_result",
    toolCallId: "call-1",
    status: "success",
    output: "question request ask-1 recorded:\n- [auth] Auth: Which auth method should we use? (OAuth / API key)\nawait the user's answer via answer_user_question; do not proceed as if answered",
    truncated: false,
  });

  return state;
}

test("a successful ask makes the shell wait on the person's answer", () => {
  const state = askCall();

  assert.equal(state.waiting?.kind, "question");

  if (state.waiting?.kind === "question") {
    assert.equal(state.waiting.requestId, "ask-1");
    assert.equal(state.waiting.questions.length, 1);
    assert.equal(state.waiting.questions[0]?.header, "Auth");
  }
});

test("the question panel shows the choices the model offered", () => {
  const state = askCall();
  const text = state.lines.map((line) => line.text).join("\n");
  assert.match(text, /awaiting your answer/);
  assert.match(text, /Which auth method should we use\?/);
  assert.match(text, /1\. OAuth/);
  assert.match(text, /2\. API key/);
});

test("the status bar names the wait while a question is open", () => {
  const state = askCall();
  assert.match(statusBar(state, 120), /waiting on your answer \(ask-1\)/);
});

test("a delivered answer clears the wait", () => {
  let state = askCall();

  state = reduceTuiEvent(state, {
    type: "tool_use",
    toolCallId: "call-2",
    name: "answer_user_question",
    input: { requestId: "ask-1", answers: { auth: "OAuth" } },
  });
  state = reduceTuiEvent(state, {
    type: "tool_result",
    toolCallId: "call-2",
    status: "success",
    output: "auth -> OAuth",
    truncated: false,
  });
  assert.equal(state.waiting, undefined);
  assert.match(statusBar(state, 120), /idle|last /);
});

test("a failed ask waits on nothing and shows no panel", () => {
  let state = reduceTuiEvent(emptyTuiState(FACTS), {
    type: "tool_use",
    toolCallId: "call-1",
    name: "ask_user_question",
    input: { questions: [] },
  });

  state = reduceTuiEvent(state, {
    type: "tool_result",
    toolCallId: "call-1",
    status: "error",
    output: "",
    message: "questions must not be empty",
    truncated: false,
  });
  assert.equal(state.waiting, undefined);
  assert.equal(state.lines.some((line) => line.text.includes("awaiting your answer")), false);
});

test("a submitted plan waits on approval and is shown", () => {
  let state = reduceTuiEvent(emptyTuiState(FACTS), {
    type: "tool_use",
    toolCallId: "call-1",
    name: "exit_plan_mode",
    input: { plan: "# The plan\n\n1. Read the file\n2. Edit it" },
  });

  state = reduceTuiEvent(state, {
    type: "tool_result",
    toolCallId: "call-1",
    status: "success",
    output: "plan submitted for approval. Waiting on the user; do not mutate the workspace until approval arrives.",
    truncated: false,
  });
  assert.equal(state.waiting?.kind, "plan");
  const text = state.lines.map((line) => line.text).join("\n");

  assert.match(text, /plan awaiting approval/);
  assert.match(text, /Read the file/);
  assert.match(text, /workspace edits stay blocked until then/);
  assert.match(statusBar(state, 120), /waiting on your approval \(plan\)/);
});

test("a tool call in flight waits on that tool, and the next turn clears it", () => {
  let state = reduceTuiEvent(emptyTuiState(FACTS), {
    type: "tool_use",
    toolCallId: "call-1",
    name: "run_shell",
  });

  assert.deepEqual(state.waiting, { kind: "tool", names: ["run_shell"] });
  assert.match(statusBar(state, 120), /waiting on tool run_shell/);
  state = reduceTuiEvent(state, {
    type: "run_start",
    sessionId: "repl-1",
    turnId: "turn-2",
    providerId: "fixture",
    model: "default",
  });
  assert.equal(state.waiting, undefined);
});

test("a question outlives the turn that asked it", () => {
  let state = askCall();

  state = reduceTuiEvent(state, {
    type: "run_result",
    status: "completed",
    finishReason: "tool_use",
    sessionId: "repl-1",
    turnId: "turn-1",
    iterations: 1,
    usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
    durationMs: 5,
    lastMessage: "",
  });
  assert.equal(state.waiting?.kind, "question");
});

test("a failure's body is quoted beyond its headline", () => {
  const message = [
    "hunk 2 did not match",
    "expected: const a = 1;",
    "found:    const a = 2;",
    "file: src/a.ts",
    "hint: re-read the file and re-apply",
  ].join("\n");
  const state = reduceTuiEvent(emptyTuiState(FACTS), {
    type: "tool_use",
    toolCallId: "call-1",
    name: "apply_patch",
  });
  const closed = reduceTuiEvent(state, {
    type: "tool_result",
    toolCallId: "call-1",
    status: "error",
    output: "",
    message,
    truncated: false,
  });
  const text = closed.lines.map((line) => line.text).join("\n");

  assert.match(text, /! hunk 2 did not match/);
  assert.match(text, /! found:    const a = 2;/);
  // Past the fold the body is not dropped, it is pointed at: the person knows
  // there is more and where to read it.
  assert.match(text, /! … 1 more lines \(\/details for all\)/);
});
