import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExecutionProgressPort } from "../ports/execution-progress.js";
import type { PermissionPort } from "../ports/permission.js";
import type { ProviderRequest } from "../ports/provider.js";
import type { ToolPort } from "../ports/tools.js";
import { createFakePermission, echoBinding, emptyProfileLoader, toolResult } from "./fakes.js";
import { executeToolSafely, readToolApprovalRequirement } from "./tool-boundary.js";
import { runTurn } from "./runner.js";

const REQUEST = { sessionId: "s", turnId: "t", correlationId: "c", text: "Use a tool, then recover from an unavailable one." };

for (const shape of ["single", "batch"] as const) {
  for (const failure of ["missing", "admission_catalog", "execution_catalog", "execution_missing"] as const) {
    test(`${shape} ${failure} settles only the unexecuted call and lets the model continue`, async () => {
      const requests: ProviderRequest[] = [];
      const executed: string[] = [];
      const pending = new Set<string>();
      const settled: string[] = [];
      let prompts = 0;
      let rejectSnapshot = false;
      const available = [echoBinding({ name: "good", needsApproval: false, parallelSafe: true }),
        ...(failure === "missing" ? [] : [echoBinding({ name: "bad", needsApproval: false, parallelSafe: true })])];
      const tools: ToolPort = {
        snapshot() {
          if (rejectSnapshot) {
            rejectSnapshot = false;
            if (failure === "execution_missing") return available.filter(binding => binding.name !== "bad");
            throw new Error("private catalog storage is unreachable");
          }
          return available;
        },
        async execute(call) { executed.push(call.toolCallId); return toolResult({ ok: true }); },
        async cancel() {},
      };
      const permission: PermissionPort = {
        async request(action) { prompts += 1; return { ticketId: "ticket", toolCallId: action.toolCallId }; },
        async awaitDecision() { return { resolution: "approved", scope: "once" }; },
      };
      const progress: ExecutionProgressPort = {
        async flush() { return { ok: true }; },
        async issue(key) {
          pending.add(key);
          if (failure === "execution_catalog" || failure === "execution_missing") rejectSnapshot = true;
          return { ok: true };
        },
        async settle(key, outcome) {
          assert.notEqual(outcome, "unknown", "an unexecuted call cannot leave an uncertain effect");
          pending.delete(key);
          settled.push(key);
          return { ok: true };
        },
      };
      const result = await runTurn({ tools, permission, progress, profile: emptyProfileLoader(), provider: {
        async *stream(request) {
          requests.push(request);
          if (requests.length === 1) {
            yield { type: "tool_call", toolCallId: "bad-call", name: "bad", arguments: {} };
            if (shape === "batch") yield { type: "tool_call", toolCallId: "good-call", name: "good", arguments: {} };
            if (failure === "admission_catalog") rejectSnapshot = true;
            yield { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true };
          } else {
            const failed = request.messages.filter(item => item.role === "tool" && item.toolCallId === "bad-call");
            assert.equal(failed.length, 1);
            assert.match(failed[0]!.content, new RegExp(failure === "missing" || failure === "execution_missing" ? "unknown_tool" : "tool_catalog_unavailable"));
            assert.match(failed[0]!.content, /not executed/);
            yield { type: "text_delta", blockId: "answer", text: "The unavailable call did not run; the permitted work is recorded." };
            yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
          }
        },
      } }, REQUEST);

      assert.equal(result.state.terminalReason, "completed");
      assert.equal(requests.length, 2);
      assert.equal(prompts, 0);
      assert.equal(executed.includes("bad-call"), false);
      assert.deepEqual(executed, shape === "batch" ? ["good-call"] : []);
      assert.equal(result.state.toolCalls["bad-call"]?.status, "failed");
      assert.equal(result.envelopes.some(item => item.kind === "approval_requested"), false);
      assert.equal(result.envelopes.some(item => item.kind === "error" && item.payload["code"] === "illegal_transition"), false);
      assert.equal(pending.size, 0);
      if (failure === "execution_catalog" || failure === "execution_missing") assert.ok(settled.includes("tool:bad-call"));
      else assert.equal(settled.includes("tool:bad-call"), false, "pre-admission failure creates no business effect");
    });
  }
}

test("a newly discovered exact tool binding remains callable on the next iteration", async () => {
  const executed: string[] = [];
  let loaded = false;
  const tool = "mcp__office__officecli";
  const tools: ToolPort = {
    snapshot: () => [echoBinding({ name: "discover", needsApproval: false }),
      ...(loaded ? [echoBinding({ name: tool, needsApproval: true })] : [])],
    async execute(call) { executed.push(call.name); loaded = true; return toolResult({ ok: true }); },
    async cancel() {},
  };
  let requests = 0;
  const result = await runTurn({ tools, permission: createFakePermission("approved"), profile: emptyProfileLoader(), provider: {
    async *stream() {
      requests += 1;
      if (requests <= 2) {
        yield { type: "tool_call", toolCallId: `call-${requests}`, name: requests === 1 ? "discover" : tool, arguments: {} };
        yield { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true };
      } else yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
    },
  } }, REQUEST);

  assert.equal(result.state.terminalReason, "completed");
  assert.deepEqual(executed, ["discover", tool]);
  assert.equal(result.envelopes.filter(item => item.kind === "approval_requested").length, 1);
});

test("an adapter throw after execution stays unknown rather than a preflight failure", async () => {
  let executed = 0;
  const outcome = await executeToolSafely({ snapshot: () => [echoBinding()], async execute() {
    executed += 1;
    throw new Error("response lost after action");
  }, async cancel() {} }, { name: "echo", toolCallId: "executed", arguments: {} }, new AbortController().signal);

  assert.equal(executed, 1);
  assert.equal(outcome.outcome, "unknown");
});

test("a catalogue cancellation keeps its cancellation identity", () => {
  const cancelled = new Error("catalogue cancelled");
  cancelled.name = "AbortError";
  assert.throws(() => readToolApprovalRequirement({ snapshot() { throw cancelled; },
    async execute() { throw new Error("must not execute"); }, async cancel() {} }, "echo"), error => error === cancelled);
});
