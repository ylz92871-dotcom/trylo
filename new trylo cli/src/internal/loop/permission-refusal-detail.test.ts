import assert from "node:assert/strict";
import { test } from "node:test";
import { isPermissionDecision, type PermissionPort } from "../ports/permission.js";
import type { ProviderRequest } from "../ports/provider.js";
import { stdioAnswer } from "../surface/cli/stdio-control.js";
import { projectEnvelopeSequence } from "../surface/cli/stream-projection.js";
import { createPermissionGrantCache } from "./permission-grants.js";
import { echoBinding, emptyProfileLoader, toolResult } from "./fakes.js";
import { runTurn } from "./runner.js";

const detail = "浏览器地址需要完整协议；请使用 http://localhost:3000/index.html。";
const response = (reason: string, message = detail) => JSON.stringify({
  type: "control_response", response: { subtype: "success", request_id: "current",
    response: { behavior: "deny", reason, message } },
});

test("stdio preserves an invalid-arguments refusal without calling it a user or policy denial", () => {
  assert.deepEqual(stdioAnswer(response("invalid_arguments"), "current"),
    { resolution: "denied", scope: "once", reason: "invalid_arguments", message: detail });
  assert.equal(stdioAnswer(response("invalid_arguments"), "stale"), undefined);
  assert.deepEqual(stdioAnswer(response("policy_denied"), "current"),
    { resolution: "denied", scope: "once", reason: "policy_denied", message: detail });
});

test("invalid arguments is valid only as a nonpersistent refusal", () => {
  assert.equal(isPermissionDecision({ resolution: "denied", scope: "once", reason: "invalid_arguments" }), true);
  for (const resolution of ["approved", "cancelled", "expired"]) {
    assert.equal(isPermissionDecision({ resolution, scope: "once", reason: "invalid_arguments" }), false);
  }
  assert.equal(isPermissionDecision({ resolution: "denied", scope: "session", reason: "invalid_arguments" }), false);
  assert.equal(isPermissionDecision({ resolution: "denied", scope: "session", reason: "policy_denied" }), true);
});

test("missing host explanation uses a readable invalid-arguments fallback", () => {
  assert.deepEqual(projectEnvelopeSequence([{
    protocolVersion: "0.0", eventId: "e1", sequence: 1, timestamp: "2026-11-08T00:00:00.000Z",
    kind: "observation", producerId: "fixture", producerSequence: 1,
    payload: { component: "permission", code: "invalid_arguments", reason: "invalid_arguments", toolCallId: "refused" },
  }]), [{ type: "warning", code: "invalid_arguments", message: "工具参数无效，原调用未执行。请更正参数后重试。" }]);
});

for (const shape of ["single", "batch"] as const) {
  for (const reason of ["invalid_arguments", "policy_denied"] as const) {
    test(shape + " " + reason + " preserves its explanation and permits a corrected call", async () => {
      const message = reason === "invalid_arguments" ? detail : "此页面不在当前授权范围，原调用未执行。";
      const requests: ProviderRequest[] = [], executed: string[] = [];
      const grants = createPermissionGrantCache();
      const permission: PermissionPort = {
        async request(action) { return { ticketId: action.toolCallId, toolCallId: action.toolCallId }; },
        async awaitDecision(ticketId) {
          if (ticketId !== "refused") return { resolution: "approved", scope: "once" };
          const result = stdioAnswer(response(reason, message), "current");
          if (result === undefined) throw new Error("valid host response was lost");
          return result;
        },
      };
      const result = await runTurn({
        grants, permission, profile: emptyProfileLoader(),
        tools: {
          snapshot: () => [echoBinding({ name: "browser_navigate", sideEffect: "external" }),
            echoBinding({ name: "read_file", needsApproval: false })],
          async execute(call) { executed.push(call.toolCallId); return toolResult({ ok: true }); },
          async cancel() {},
        },
        provider: { async *stream(request) {
          requests.push(request);
          if (requests.length === 1) {
            yield { type: "tool_call", toolCallId: "refused", name: "browser_navigate", arguments: { url: "index.html" } };
            if (shape === "batch") yield { type: "tool_call", toolCallId: "sibling", name: "read_file", arguments: {} };
            yield { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true };
          } else if (requests.length === 2) {
            yield { type: "tool_call", toolCallId: "corrected", name: "browser_navigate",
              arguments: { url: "http://localhost:3000/index.html" } };
            yield { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true };
          } else {
            yield { type: "text_delta", blockId: "answer", text: "Completed the allowed navigation." };
            yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
          }
        } },
      }, { sessionId: "s", turnId: "t", correlationId: "c", text: "Correct a malformed call and continue." });

      assert.equal(result.state.terminalReason, "completed");
      assert.deepEqual(executed, shape === "batch" ? ["sibling", "corrected"] : ["corrected"]);
      assert.equal(grants.isDenied("browser_navigate"), false);
      assert.deepEqual(grants.entries(), []);
      const recorded = result.transcript.filter(item => item.kind === "tool_result" && item.toolCallId === "refused");
      assert.equal(recorded.length, 1);
      const refusal = recorded[0];
      assert.ok(refusal?.kind === "tool_result");
      const code = reason === "invalid_arguments" ? "invalid_arguments" : "permission_denied";
      assert.equal(refusal.outcome, "failed");
      assert.ok(refusal.output.startsWith(code + ":"));
      assert.ok(refusal.output.includes(message));
      const modelResults = requests[1]?.messages.filter(item => item.role === "tool" && item.toolCallId === "refused");
      assert.equal(modelResults?.length, 1);
      assert.equal(modelResults[0]?.content, refusal.output);
      const settled = result.envelopes.filter(item => item.kind === "tool_result" && item.payload.toolCallId === "refused");
      assert.equal(settled.length, 1);
      assert.equal(settled[0]?.payload.code, code);
      const projected = projectEnvelopeSequence(result.envelopes);
      const publicResult = projected.find(item => item.type === "tool_result" && item.toolCallId === "refused");
      assert.ok(publicResult?.type === "tool_result");
      assert.equal(publicResult.code, code);
      assert.equal(publicResult.message, refusal.output);
      assert.ok(projected.some(item => item.type === "warning" && item.message === message));
    });
  }
}
