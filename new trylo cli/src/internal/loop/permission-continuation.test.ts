import assert from "node:assert/strict";
import { test } from "node:test";
import type { PermissionPort } from "../ports/permission.js";
import type { ProviderRequest } from "../ports/provider.js";
import type { ToolPort } from "../ports/tools.js";
import { echoBinding, emptyProfileLoader, toolResult } from "./fakes.js";
import { runTurn } from "./runner.js";

type Refusal = "denied" | "expired" | "request_failed" | "decision_failed" | "guard_failed" | "policy_denied";

function permissionFor(refusal: Refusal): PermissionPort {
  return {
    ...(refusal === "policy_denied" ? { isDenied: (name: string) => name === "restricted_action" } : {}),
    async request(action) {
      if (refusal === "request_failed") throw new Error("permission-request-down");
      if (refusal === "policy_denied") throw new Error("standing policy must not prompt");
      return { ticketId: "ticket", toolCallId: action.toolCallId };
    },
    async awaitDecision() {
      if (refusal === "decision_failed") throw new Error("permission-store-down");
      return { resolution: refusal === "expired" ? "expired" : "denied", scope: "once" };
    },
  };
}

for (const shape of ["single", "batch"] as const) {
  for (const refusal of ["denied", "expired", "request_failed", "decision_failed", "guard_failed", "policy_denied"] as const) {
    test(`${shape} ${refusal} returns a failed tool result to the model and permits legal recovery`, async () => {
      const unavailable = refusal === "request_failed" || refusal === "decision_failed" || refusal === "guard_failed";
      const requests: ProviderRequest[] = [];
      const executed: string[] = [];
      const tools: ToolPort = {
        snapshot: () => [echoBinding({ name: "restricted_action", sideEffect: "external" }),
          echoBinding({ name: "read_file", needsApproval: false })],
        async execute(call) {
          executed.push(call.toolCallId);
          assert.equal(call.name, "read_file", "a refusal must never dispatch the restricted action");
          return toolResult({ text: "permitted observation" });
        },
        async cancel() {},
      };
      const result = await runTurn({ tools, permission: permissionFor(refusal), profile: emptyProfileLoader(),
        ...(refusal === "guard_failed" ? { execPolicy: () => { throw new Error("execution-policy-unavailable"); } } : {}),
        provider: { async *stream(request) {
          requests.push(request);
          if (requests.length === 1) {
            yield { type: "tool_call", toolCallId: "restricted", name: "restricted_action", arguments: { target: "protected" } };
            if (shape === "batch") yield { type: "tool_call", toolCallId: "sibling", name: "read_file", arguments: { path: "allowed.txt" } };
            yield { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true };
          } else if (requests.length === 2) {
            const failed = request.messages.filter(message => message.role === "tool" && message.toolCallId === "restricted");
            assert.equal(failed.length, 1, "the next real model request must contain exactly one result for the refused call");
            const code = unavailable ? "permission_unavailable"
              : refusal === "expired" ? "permission_expired" : "permission_denied";
            assert.match(failed[0]!.content, new RegExp(code));
            assert.match(failed[0]!.content, /did not run/);
            yield { type: "tool_call", toolCallId: "recovery", name: "read_file", arguments: { path: "allowed.txt" } };
            yield { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true };
          } else {
            yield { type: "text_delta", blockId: "answer", text: "The restricted action did not run. I continued with the permitted observation." };
            yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
          }
        } },
      }, { sessionId: "s", turnId: "t", correlationId: "c", text: "Continue with permitted work if a tool is refused." });

      assert.equal(result.state.terminalReason, "completed");
      assert.equal(requests.length, 3);
      assert.deepEqual(executed, shape === "batch" ? ["sibling", "recovery"] : ["recovery"]);
      assert.equal(result.state.toolCalls.restricted?.status,
        unavailable ? "permission_failed" : "denied");
      const recorded = result.transcript.filter(item => item.kind === "tool_result" && item.toolCallId === "restricted");
      assert.equal(recorded.length, 1);
      assert.ok(recorded[0]?.kind === "tool_result");
      assert.equal(recorded[0].outcome, "failed");
      assert.equal(result.envelopes.some(item => item.kind === "terminal" && item.payload.reason !== "completed"), false);
    });
  }
}

test("active approval cancellation still stops the turn without executing or asking the model to continue", async () => {
  let requests = 0;
  let executed = false;
  const result = await runTurn({ profile: emptyProfileLoader(),
    tools: { snapshot: () => [echoBinding()], async execute() { executed = true; return toolResult({}); }, async cancel() {} },
    permission: { async request(action) { return { ticketId: "ticket", toolCallId: action.toolCallId }; },
      async awaitDecision() { return { resolution: "cancelled", scope: "once", reason: "user_cancelled" }; } },
    provider: { async *stream() {
      requests += 1;
      yield { type: "tool_call", toolCallId: "cancelled", name: "echo", arguments: {} };
      yield { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true };
    } },
  }, { sessionId: "s", turnId: "t", correlationId: "c", text: "Cancel this approval." });
  assert.equal(result.state.terminalReason, "cancelled");
  assert.equal(requests, 1);
  assert.equal(executed, false);
});

test("caller cancellation during a failed approval remains cancelled before any recovery request", async () => {
  const cancelled = new AbortController();
  let requests = 0;
  let executed = false;
  const result = await runTurn({ profile: emptyProfileLoader(),
    tools: { snapshot: () => [echoBinding()], async execute() { executed = true; return toolResult({}); }, async cancel() {} },
    permission: { async request() { cancelled.abort(); throw new Error("approval-input-aborted"); },
      async awaitDecision() { throw new Error("failed request cannot have a decision"); } },
    provider: { async *stream() {
      requests += 1;
      yield { type: "tool_call", toolCallId: "cancelled", name: "echo", arguments: {} };
      yield { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true };
    } },
  }, { sessionId: "s", turnId: "t", correlationId: "c", text: "Cancel this approval.", cancelSignal: cancelled.signal });
  assert.equal(result.state.terminalReason, "cancelled");
  assert.equal(requests, 1);
  assert.equal(executed, false);
});
