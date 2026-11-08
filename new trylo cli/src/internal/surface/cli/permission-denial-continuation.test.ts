import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProviderRequest } from "../../ports/provider.js";
import { echoBinding, emptyProfileLoader, toolResult } from "../../loop/fakes.js";
import { runTurn } from "../../loop/runner.js";
import { createInteractivePermission } from "./permission.js";
import { createStdioApproval } from "./stdio-control.js";

test("the host denial explanation survives stdio approval and reaches the next model request", async () => {
  const message = "The managed Office tool refused an unsupported action. Read its tool schema and correct the arguments.";
  const frames: Array<Record<string, unknown>> = [];
  const requests: ProviderRequest[] = [];
  let executed = 0;
  const requestApproval = createStdioApproval({ now: () => 0, newId: () => "approval", stdout: line => frames.push(JSON.parse(line)),
    async readLine() {
      return JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: "approval",
        response: { behavior: "deny", reason: "policy_denied", message } } });
    },
  });
  const permission = createInteractivePermission({ prompt() {}, async readLine() { throw new Error("stdio owns approval input"); }, requestApproval });
  const result = await runTurn({ profile: emptyProfileLoader(), permission,
    tools: { snapshot: () => [echoBinding({ name: "officecli", sideEffect: "external" })],
      async execute() { executed += 1; return toolResult({}); }, async cancel() {} },
    provider: { async *stream(request) {
      requests.push(request);
      if (requests.length === 1) {
        yield { type: "tool_call", toolCallId: "office", name: "officecli", arguments: { action: "unsupported" } };
        yield { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true };
      } else {
        const failed = request.messages.filter(item => item.role === "tool" && item.toolCallId === "office");
        assert.equal(failed.length, 1);
        assert.ok(failed[0]!.content.includes(message), "the model must receive the host's actionable refusal, not just policy_denied");
        assert.match(failed[0]!.content, /did not run/);
        yield { type: "text_delta", blockId: "answer", text: "The action did not run. I will correct its arguments." };
        yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
      }
    } },
  }, { sessionId: "s", turnId: "t", correlationId: "c", text: "Use the managed tool." });

  assert.equal(requests.length, 2);
  assert.equal(result.state.terminalReason, "completed");
  assert.equal(result.state.toolCalls.office?.status, "denied");
  assert.equal(executed, 0);
  assert.equal(frames.filter(frame => frame.type === "control_request").length, 1);
  const recorded = result.transcript.filter(item => item.kind === "tool_result" && item.toolCallId === "office");
  assert.equal(recorded.length, 1);
  assert.ok(recorded[0]?.kind === "tool_result");
  assert.equal(recorded[0].outcome, "failed");
});
