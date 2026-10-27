import assert from "node:assert/strict";
import { test } from "node:test";
import { createStdioSession } from "./stdio-session.js";
import { createAskUserTools } from "../../adapters/tools/ask-user/index.js";
import { answerStdioInput, stdioQuestions } from "./stdio-questions.js";
import { buildPermissionAction } from "../../loop/permission-grants.js";

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const question = { id: "style", header: "样式", question: "选择方向", multiSelect: true,
  options: [{ label: "A", description: "a" }, { label: "B", description: "b" }] };
function harness() {
  const lines: Array<string | undefined> = [];
  let waiter: ((line: string | undefined) => void) | undefined;
  const frames: Array<Record<string, unknown>> = [];
  let id = 0;
  const channel = createStdioSession({ now: () => 100, newId: prefix => `${prefix}-${++id}`,
    stdout: line => frames.push(JSON.parse(line) as Record<string, unknown>),
    readLine: () => lines.length ? Promise.resolve(lines.shift()) : new Promise(resolve => { waiter = resolve; }),
  });
  const feed = (value: object | undefined): void => {
    const line = value === undefined ? undefined : JSON.stringify(value);
    if (waiter) { const current = waiter; waiter = undefined; current(line); } else lines.push(line);
  };
  channel.start();
  return { channel, frames, feed, close: () => { channel.close(); feed(undefined); } };
}
const response = (requestId: string, body: object) => ({ type: "control_response", response: {
  subtype: "success", request_id: requestId, response: body,
} });

test("member cancellation retracts only its owner approval and a late response cannot answer a sibling", async () => {
  const h = harness();
  try {
    const cancel = new AbortController();
    const requester = { kind: "subagent" as const, taskId: "task-a", executionId: "exec-a", teamRunId: "team-a",
      memberId: "member-a", displayName: "写作成员", role: "worker" };
    const first = h.channel.approval(buildPermissionAction("call-a", "write_file", { path: "a.txt" }), { signal: cancel.signal, requester });
    const second = h.channel.approval(buildPermissionAction("call-b", "write_file", { path: "b.txt" }));
    const requests = h.frames.filter(frame => frame.type === "control_request");
    assert.deepEqual((requests[0]?.request as Record<string, unknown>).requester, requester);
    const firstId = String(requests[0]?.request_id); const secondId = String(requests[1]?.request_id);
    cancel.abort();
    assert.equal((await first).resolution, "cancelled");
    assert.deepEqual(h.frames.find(frame => frame.type === "control_cancel_request"), { type: "control_cancel_request", request_id: firstId });
    h.feed(response(firstId, { behavior: "allow" })); await tick();
    assert.ok(h.frames.some(frame => frame.code === "stale_control_response"));
    assert.equal(h.frames.filter(frame => frame.type === "control_cancel_request").length, 1);
    h.feed(response(secondId, { behavior: "deny" }));
    assert.equal((await second).resolution, "denied");
  } finally { h.close(); }
});

test("host cancellation closes exactly the addressed child and acknowledges the result", async () => {
  const h = harness();
  try {
    const calls: unknown[] = [];
    h.channel.bindAgentTools({ snapshot: () => [{ name: "close_agent" } as never], cancel: async () => {},
      execute: async call => { calls.push(call); return { outcome: "result", value: {}, output: "closed", truncated: false }; } });
    h.feed({ type: "subagent_input", requestId: "cancel-1", target: "agent-a", action: "cancel" });
    await tick();
    assert.deepEqual(calls, [{ name: "close_agent", toolCallId: "host-cancel-1", arguments: { target: "agent-a", force: true } }]);
    assert.equal(h.frames.find(frame => frame.requestId === "cancel-1")?.accepted, true);
    assert.equal(h.channel.signal.aborted, false);
    assert.deepEqual(h.channel.pendingInput("turn"), []);
  } finally { h.close(); }
});

test("host restart mode is preserved and invalid input modes never dispatch", async () => {
  const h = harness();
  try {
    const calls: unknown[] = [];
    h.channel.bindAgentTools({ snapshot: () => [{ name: "send_input" } as never], cancel: async () => {},
      execute: async call => { calls.push(call.arguments); return { outcome: "result", value: {}, output: "restarted", truncated: false }; } });
    h.feed({ type: "subagent_input", requestId: "restart", target: "task-a", message: "new work", mode: "restart" });
    h.feed({ type: "subagent_input", requestId: "invalid", target: "task-a", message: "no effect", mode: "typo" });
    await tick();
    assert.deepEqual(calls, [{ target: "task-a", message: "new work", mode: "restart" }]);
    assert.equal(h.frames.find(frame => frame.requestId === "restart")?.accepted, true);
    assert.equal(h.frames.find(frame => frame.requestId === "invalid")?.accepted, false);
  } finally { h.close(); }
});

test("host child input is targeted, acknowledged and never becomes parent guidance", async () => {
  const h = harness();
  try {
    const calls: unknown[] = [];
    h.channel.bindAgentTools({ snapshot: () => [{ name: "send_input" } as never], cancel: async () => {},
      execute: async call => { calls.push(call); return call.arguments.target === "closed"
        ? { outcome: "error", code: "agent_closed", message: "agent_closed" }
        : { outcome: "result", value: {}, output: "queued", truncated: false }; } });
    h.feed({ type: "subagent_input", requestId: "host-1", target: "agent-a", message: "第二轮" });
    h.feed({ type: "subagent_input", requestId: "host-2", target: "closed", message: "继续" });
    await tick();
    assert.deepEqual(calls, [
      { name: "send_input", toolCallId: "host-host-1", arguments: { target: "agent-a", message: "第二轮" } },
      { name: "send_input", toolCallId: "host-host-2", arguments: { target: "closed", message: "继续" } },
    ]);
    assert.deepEqual(h.channel.pendingInput("turn"), []);
    assert.equal(h.frames.find(frame => frame.requestId === "host-1")?.accepted, true);
    assert.equal(h.frames.find(frame => frame.requestId === "host-2")?.accepted, false);
    h.channel.bindAgentTools(undefined);
    h.feed({ type: "subagent_input", requestId: "host-3", target: "agent-a", message: "结束后" });
    await tick(); assert.equal(calls.length, 2);
    assert.equal(h.frames.find(frame => frame.requestId === "host-3")?.accepted, false);
  } finally { h.close(); }
});

test("one stdin reader routes a question, approval and guidance independently", async () => {
  const h = harness();
  try {
    const owner = createAskUserTools({ surfaceAnswersOnly: true, nextRequestId: () => "question-1" });
    const asking = stdioQuestions(owner, h.channel).execute({ name: "ask_user_question", toolCallId: "q", arguments: { questions: [question] } }, new AbortController().signal);
    const approving = h.channel.approval({ name: "write_file", toolCallId: "w", arguments: { path: "proof.txt" }, pattern: "w" });
    await tick();
    h.feed({ type: "user", message: { role: "user", content: "new guidance" } });
    h.feed(response("question-1", { status: "submitted", answers: { style: "A, B" } }));
    h.feed(response("approval-1", { behavior: "allow" }));
    assert.equal((await asking).outcome, "result");
    assert.equal((await approving).resolution, "approved");
    assert.deepEqual(owner.pending(), []);
    assert.deepEqual(h.channel.pendingInput("turn"), [{ text: "new guidance", mode: "steer", turnId: "turn" }]);
    assert.deepEqual(h.channel.pendingInput("turn"), []);
  } finally { h.close(); }
});
test("malformed and stale replies cannot deny or approve a pending tool", async () => {
  const h = harness();
  try {
    let settled = false;
    const pending = h.channel.approval({ name: "write_file", toolCallId: "w", arguments: {}, pattern: "w" }).then(value => { settled = true; return value; });
    h.feed(response("old-id", { behavior: "allow" }));
    h.feed(response("approval-1", { status: "submitted", answers: {} }));
    await tick(); assert.equal(settled, false);
    h.feed(response("approval-1", { behavior: "deny", reason: "policy_denied" }));
    assert.equal((await pending).reason, "policy_denied");
  } finally { h.close(); }
});
test("legacy interrupt command cancels pending user interaction without granting permission", async () => {
  const h = harness();
  try {
    const waiting = h.channel.approval({ name: "write_file", toolCallId: "w", arguments: {}, pattern: "w" });
    h.feed({ type: "control_request", request_id: "stop", request: { subtype: "interrupt" } });
    assert.equal((await waiting).resolution, "cancelled"); assert.equal(h.channel.signal.aborted, true);
  } finally { h.close(); }
});

test("a restored question uses the shared reader and records only actual user answers", async () => {
  const h = harness();
  try {
    const owner = createAskUserTools({ surfaceAnswersOnly: true, restored: [{ requestId: "restored", status: "pending", questions: [question] }] });
    const waiting = answerStdioInput(owner, h.channel, "continue", h.channel.signal);
    h.feed(response("restored", { status: "submitted", answers: { style: "B" } }));
    assert.match(await waiting, /^User answer for request restored: /);
    assert.deepEqual(owner.pending(), []);
  } finally { h.close(); }
});

test("async user questions display immediately and put the eventual answer into the same run inbox", async () => {
  const h = harness();
  try {
    const owner = createAskUserTools({ surfaceAnswersOnly: true, nextRequestId: () => "async-q" });
    const result = await stdioQuestions(owner, h.channel).execute({ name: "request_user_input_async", toolCallId: "async", arguments: { questions: [question] } }, new AbortController().signal);
    assert.equal(result.outcome, "result");
    assert.equal(h.frames.some(frame => frame.request_id === "async-q"), true);
    h.feed(response("async-q", { status: "submitted", answers: { style: "A" } }));
    await tick();
    assert.match(h.channel.pendingInput("turn")[0]?.text ?? "", /^User answer for request async-q: /);
  } finally { h.close(); }
});
