import assert from "node:assert/strict";
import { test } from "node:test";
import { createOpenAiCompatibleProvider } from "./openai-compatible.js";
import { runTurn } from "../../loop/runner.js";
import { createFakePermission, echoBinding, emptyProfileLoader, toolResult } from "../../loop/fakes.js";

const endpoint = "https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions";
for (const shape of ["null_delta", "missing_delta", "stop_with_call"] as const) {
  test(`Chat ${shape}: completed tools receive a verified follow-up and native continuation`, async () => {
    const bodies: Array<{ messages: Array<{ role: string; reasoning_content?: string }> }> = [];
    let executions = 0;
    const provider = createOpenAiCompatibleProvider({ endpoint, model: "glm-5.3-flash", apiKey: "synthetic-only",
      fetchImpl: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        const terminal = { ...(shape === "missing_delta" ? {} : { delta: shape === "null_delta" ? null : {} }),
          finish_reason: shape === "stop_with_call" ? "stop" : "tool_calls" };
        const frames = bodies.length === 1 ? [
          { choices: [{ delta: { reasoning_content: "SYNTHETIC_NATIVE", tool_calls: [
            { index: 0, id: "call", function: { name: "echo", arguments: "{}" } },
          ] }, finish_reason: null }] }, { choices: [terminal] },
        ] : [{ choices: [{ delta: { content: "VERIFIED" }, finish_reason: "stop" }] }];
        return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n");
      } });
    const result = await runTurn({ provider, profile: emptyProfileLoader(), permission: createFakePermission("approved"),
      tools: { snapshot: () => [echoBinding({ needsApproval: false })], cancel: async () => {},
        execute: async () => { executions++; return toolResult({ ok: true }); } },
    }, { sessionId: "s", turnId: "t", correlationId: "c", text: "Use echo and verify.", model: "glm-5.3-flash",
      budget: { maxIterations: 3 } });
    assert.equal(result.state.terminalReason, "completed");
    assert.equal(bodies.length, 2, "a tool result still needs to reach the model");
    assert.equal(executions, 1);
    assert.equal(bodies[1]?.messages.find(message => message.role === "assistant")?.reasoning_content, "SYNTHETIC_NATIVE");
    assert.ok(result.transcript.some(item => item.kind === "assistant_text" && item.text === "VERIFIED"));
    assert.equal(result.envelopes.filter(event => event.kind === "terminal").length, 1);
  });
}
