import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExecutionProgressPort } from "../ports/execution-progress.js";
import { echoBinding, emptyProfileLoader, toolResult } from "./fakes.js";
import { runTurn } from "./runner.js";

for (const cancellation of ["permission_cancelled", "caller_abort_then_permission_throw"] as const) {
  test(`a batch does not issue or execute later siblings after ${cancellation}`, async () => {
    const controller = new AbortController();
    const executed: string[] = [];
    const issued: string[] = [];
    const pending = new Set<string>();
    let requests = 0;
    const progress: ExecutionProgressPort = {
      async flush() { return { ok: true }; },
      async issue(key) { issued.push(key); pending.add(key); return { ok: true }; },
      async settle(key) { pending.delete(key); return { ok: true }; },
    };
    const result = await runTurn({ profile: emptyProfileLoader(), progress,
      tools: {
        snapshot: () => [echoBinding({ name: "read", needsApproval: false }), echoBinding({ name: "restricted", needsApproval: true })],
        async execute(call) { executed.push(call.toolCallId); return toolResult({ ok: true }, call.toolCallId); },
        async cancel() {},
      },
      permission: {
        async request(action) {
          if (cancellation === "caller_abort_then_permission_throw") {
            controller.abort();
            throw new Error("permission service closed while cancelling");
          }
          return { ticketId: "ticket", toolCallId: action.toolCallId };
        },
        async awaitDecision() { return { resolution: "cancelled", scope: "once" }; },
      },
      provider: { async *stream() {
        requests += 1;
        yield { type: "tool_call", toolCallId: "completed-before-cancel", name: "read", arguments: {} };
        yield { type: "tool_call", toolCallId: "permission", name: "restricted", arguments: {} };
        yield { type: "tool_call", toolCallId: "must-not-start", name: "read", arguments: {} };
        yield { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true };
      } },
    }, { sessionId: "s", turnId: "t", correlationId: "c", text: "Cancel at the permission boundary.", cancelSignal: controller.signal });

    assert.equal(result.state.terminalReason, "cancelled");
    assert.equal(requests, 1, "cancellation must not ask the model to continue");
    assert.deepEqual(executed, ["completed-before-cancel"]);
    assert.deepEqual(issued, ["tool:completed-before-cancel"]);
    assert.equal(pending.size, 0);
    assert.equal(result.state.toolCalls["completed-before-cancel"]?.status, "succeeded");
    assert.equal(result.state.toolCalls["must-not-start"]?.status, "cancelled");
    const earlier = result.transcript.filter(item => item.kind === "tool_result" && item.toolCallId === "completed-before-cancel");
    assert.equal(earlier.length, 1);
    assert.equal(earlier[0]?.kind === "tool_result" && earlier[0].outcome, "succeeded");
    const later = result.transcript.filter(item => item.kind === "tool_result" && item.toolCallId === "must-not-start");
    assert.equal(later.length, 1);
    assert.equal(later[0]?.kind === "tool_result" && later[0].outcome, "cancelled");
  });
}

for (const boundary of ["issue", "checkpoint"] as const) {
  test(`a batch clears issued effects without executing after cancellation during ${boundary}`, async () => {
    const controller = new AbortController();
    const issued: string[] = [];
    const pending = new Set<string>();
    let executed = 0;
    const progress: ExecutionProgressPort = {
      async flush() { return { ok: true }; },
      async issue(key) {
        issued.push(key);
        pending.add(key);
        if (boundary === "issue") controller.abort();
        return { ok: true };
      },
      async settle(key, outcome) {
        assert.equal(outcome, "cancelled", "only unexecuted calls exist in this scenario");
        pending.delete(key);
        return { ok: true };
      },
    };
    const result = await runTurn({ profile: emptyProfileLoader(), progress,
      tools: {
        snapshot: () => [echoBinding({ name: "write", needsApproval: false, sideEffect: "workspace_write" })],
        async execute() { executed += 1; return toolResult({ ok: true }); }, async cancel() {},
      },
      permission: { async request() { throw new Error("unused"); }, async awaitDecision() { throw new Error("unused"); } },
      ...(boundary === "checkpoint" ? { checkpoint: { workspaceRoot: "/ws", now: () => "fixture", port: {
        async snapshot() { controller.abort(); return { ok: false as const, code: "storage_unavailable" as const, detail: "fixture" }; },
        async restore() { throw new Error("unused"); }, async list() { throw new Error("unused"); },
      } } } : {}),
      provider: { async *stream() {
        yield { type: "tool_call", toolCallId: "first", name: "write", arguments: {} };
        yield { type: "tool_call", toolCallId: "second", name: "write", arguments: {} };
        yield { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true };
      } },
    }, { sessionId: "s", turnId: "t", correlationId: "c", text: "Cancel before the writes start.", cancelSignal: controller.signal });

    assert.equal(result.state.terminalReason, "cancelled");
    assert.equal(executed, 0);
    assert.equal(pending.size, 0);
    assert.deepEqual(issued, boundary === "issue" ? ["tool:first"] : []);
    for (const id of ["first", "second"]) {
      const outcomes = result.transcript.filter(item => item.kind === "tool_result" && item.toolCallId === id);
      assert.equal(outcomes.length, 1);
      assert.equal(outcomes[0]?.kind === "tool_result" && outcomes[0].outcome, "cancelled");
    }
  });
}
