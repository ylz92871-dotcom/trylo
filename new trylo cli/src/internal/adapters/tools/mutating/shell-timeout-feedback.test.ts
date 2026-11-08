import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createOpenAiCompatibleProvider } from "../../provider/openai-compatible.js";
import { createWorkspaceSandbox } from "../../sandbox/index.js";
import { createFakePermission, emptyProfileLoader } from "../../../loop/fakes.js";
import { runTurn } from "../../../loop/runner.js";
import { createMutatingTools } from "./index.js";
import { MIN_TIMEOUT_MS } from "./shell-tool.js";
import { RUN_SHELL_BINDING } from "./bindings.js";

type Wire = { readonly messages: ReadonlyArray<{ readonly role: string; readonly content: string; readonly tool_call_id?: string }> };

for (const timeoutMs of [1_000, 600_000]) {
  test(`shell timeout at ${timeoutMs}ms carries feasible recovery advice through the next Chat request`, async () => {
    const root = mkdtempSync(join(os.tmpdir(), "trylo-timeout-feedback-"));
    const wires: Wire[] = [];
      const spawned: (number | undefined)[] = [];
    const tools = createMutatingTools({ sandbox: createWorkspaceSandbox({ workspaceRoot: root }),
      spawner: async spec => {
        spawned.push(spec.timeoutMs);
        return { exitCode: -1, stdout: "PASS first 14 checks\n", stderr: "", timedOut: true, aborted: false, truncated: false };
      },
    });
    const provider = createOpenAiCompatibleProvider({
      endpoint: "https://developer.amd.com.cn/radeon/api/v1/chat/completions", model: "DeepSeek-V4-Flash-Vision-Exp", apiKey: "fixture-key",
      fetchImpl: async (_url, init) => {
        wires.push(JSON.parse(String(init?.body)));
        const choice = wires.length === 1
          ? { delta: { tool_calls: [{ index: 0, id: "timed-out", function: { name: "run_shell", arguments: JSON.stringify({ command: "node tests/verify.mjs", timeoutMs }) } }] }, finish_reason: "tool_calls" }
          : { delta: { content: "验收超时，尚未通过。" }, finish_reason: "stop" };
        return new Response(`data: ${JSON.stringify({ choices: [choice] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
      },
    });

    try {
      const result = await runTurn({ tools, provider, permission: createFakePermission("approved"), profile: emptyProfileLoader() },
        { sessionId: "timeout-feedback", turnId: "turn1", correlationId: "corr", model: "DeepSeek-V4-Flash-Vision-Exp", text: "Run and inspect verification." });

      assert.equal(wires.length, 2);
      assert.deepEqual(spawned, [timeoutMs], "feedback must not initiate an automatic retry");
      const feedback = wires[1]?.messages.find(message => message.role === "tool" && message.tool_call_id === "timed-out")?.content;

      assert.ok(feedback);
      assert.match(feedback, /shell_timeout/);
      assert.match(feedback, /PASS first 14 checks/);
      assert.match(feedback, /inspect|check/i);
      assert.match(feedback, /omit timeoutMs|longer explicit deadline/i);
      assert.doesNotMatch(feedback, /larger timeoutMs is not allowed/);
      assert.equal(result.transcript.filter(item => item.kind === "tool_result" && item.outcome === "failed").length, 1);
      assert.equal(result.state.verification.status, "unset");
      assert.equal(result.state.terminalReason, "completed", "lifecycle completion must remain separate from validation");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("Chat advertises the same timeout bounds that the shell executor enforces", async () => {
  let timeoutSchema: { minimum?: number; maximum?: number } | undefined;
  const provider = createOpenAiCompatibleProvider({ endpoint: "https://example.invalid/chat/completions", model: "fixture", apiKey: "fixture-key",
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { tools: Array<{ function: { parameters: { properties: { timeoutMs: { minimum?: number; maximum?: number } } } } }> };
      timeoutSchema = body.tools[0]?.function.parameters.properties.timeoutMs;
      return new Response('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    },
  });

  for await (const event of provider.stream({ attemptId: "schema", model: "fixture", messages: [], tools: [RUN_SHELL_BINDING] }, new AbortController().signal)) {
    assert.notEqual(event.type, "error");
  }

  assert.deepEqual({ minimum: timeoutSchema?.minimum, maximum: timeoutSchema?.maximum }, { minimum: MIN_TIMEOUT_MS, maximum: undefined });
});
