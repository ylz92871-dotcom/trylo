import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_SEEN_EVENTS } from "../domain/state.js";
import { reduce } from "../domain/reduce.js";
import { initialState } from "../domain/state.js";
import { EMPTY_PROFILE } from "../contract/profile.js";
import { createFakePermission, createFakeProvider, createFakeTools, emptyProfileLoader } from "./fakes.js";
import { runTurn } from "./runner.js";
import { runScenario } from "./scenarios.js";

test("seen event overflow fails the turn with a cause, not a dribble of errors", () => {
  // D7 P2-A 精修（hard-eval 实测）：4096 是单个 turn 的事件数上限，
  // 不是会话永久中毒。撞上限继续跑只会让每个后续输入都报错、
  // 整轮空转到预算兜底——直接熔断并点名原因。
  const start = reduce(initialState(), {
    type: "start_turn",
    eventId: "e0",
    sessionId: "s",
    turnId: "t",
    correlationId: "c",
    text: "x",
  });
  assert.equal(start.ok, true);
  if (!start.ok) {
    return;
  }
  const state = {
    ...start.state,
    seenEventIds: Array.from({ length: MAX_SEEN_EVENTS }, (_, i) => `full-${i}`),
  };
  const overflow = reduce(state, { type: "begin_stream", eventId: "new" });
  assert.equal(overflow.ok, true);
  if (!overflow.ok) {
    return;
  }
  assert.equal(overflow.state.phase, "terminal");
  assert.equal(overflow.state.terminalReason, "failed");
});

test("learning snapshot cannot grant permission", async () => {
  const result = await runScenario("tool-approve");
  assert.equal("permission" in EMPTY_PROFILE, false);
  assert.equal(result.state.approvals["tkt-call-1"]?.status, "approved");
  assert.equal(EMPTY_PROFILE.toolBindings.length, 0);
});

test("unknown tool outcome is not success", async () => {
  const result = await runTurn(
    {
      profile: emptyProfileLoader(),
      permission: createFakePermission("approved"),
      tools: createFakeTools([
        { outcome: "unknown", code: "timeout_after_send", message: "no_ack" },
      ]),
      provider: createFakeProvider([
        [
          { type: "tool_call", toolCallId: "call-u", name: "echo", arguments: {} },
          { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true },
        ],
        [{ type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false }],
      ]),
    },
    {
      sessionId: "ses-1",
      turnId: "trn-u",
      correlationId: "cor-u",
      text: "unknown",
    },
  );
  assert.equal(result.state.toolCalls["call-u"]?.status, "unknown");
  assert.notEqual(result.state.toolCalls["call-u"]?.status, "succeeded");
});
