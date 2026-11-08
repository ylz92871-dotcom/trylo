import assert from "node:assert/strict";
import { test } from "node:test";
import { runTurn } from "../../loop/runner.js";
import { createFakePermission, emptyProfileLoader, echoBinding, toolResult } from "../../loop/fakes.js";
import { createOpenAiCompatibleProvider } from "./openai-compatible.js";
import { finalReportInstructions } from "../../loop/budget-final-report.js";

test("reserved report stays the latest request on Chat wire without inventing human input or executing more tools", async () => {
  const wires: Array<{ messages: Array<{ role: string; content: string }>; tools?: unknown[] }> = [];
  let executions = 0;
  const provider = createOpenAiCompatibleProvider({
    endpoint: "https://developer.amd.com.cn/radeon/api/v1/chat/completions",
    model: "DeepSeek-V4-Flash-Vision-Exp", apiKey: "fixture-key",
    fetchImpl: async (_url, init) => {
      wires.push(JSON.parse(String(init?.body)));
      const choice = wires.length === 1
        ? { delta: { tool_calls: [{ index: 0, id: "observed", function: { name: "echo", arguments: "{}" } }] }, finish_reason: "tool_calls" }
        : { delta: { content: "已取得工具结果；验收尚未完成。" }, finish_reason: "stop" };

      return new Response(`data: ${JSON.stringify({ choices: [choice] })}\n\ndata: [DONE]\n\n`, {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  const result = await runTurn({ provider, permission: createFakePermission("approved"), profile: emptyProfileLoader(),
    tools: { snapshot: () => [echoBinding({ needsApproval: false })],
      async execute() {
        executions += 1;
        return toolResult({ observed: true });
      }, async cancel() { return; } },
  }, { sessionId: "report-position", turnId: "turn1", correlationId: "corr", model: "DeepSeek-V4-Flash-Vision-Exp", text: "Implement and validate.",
    callerMessages: [{ role: "system", content: "Governing instructions stay in the system channel." }],
    budget: { maxIterations: 2, finalRequest: "report_only" },
  });

  assert.equal(wires.length, 2);
  assert.deepEqual(wires[1]?.messages.at(-1), { role: "user", content: finalReportInstructions(result.transcript) });
  assert.match(wires[1]!.messages.at(-1)!.content, /echo: succeeded/);
  assert.equal(wires[1]?.messages[0]?.role, "system");
  assert.equal(wires[1]?.messages[0]?.content, "Governing instructions stay in the system channel.");
  assert.equal(wires[1]?.tools?.length ?? 0, 0);
  assert.equal(executions, 1);
  assert.equal(result.transcript.filter(item => item.kind === "user").length, 1);
  assert.equal(result.state.verification.status, "unset");
});
