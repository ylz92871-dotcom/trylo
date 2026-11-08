import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { wirePorts } from "./wiring.js";
import { runTurn } from "../../loop/runner.js";
import { createFakePermission } from "../../loop/fakes.js";

for (const summary of ["Safe summary.", "bad C:\\private\\path"]) test(`shipping native replay is counted by the next-request hard gate; summary=${summary.startsWith("Safe") ? "valid" : "refused"}`, async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "trylo-native-budget-")), originalFetch = globalThis.fetch;

  fs.writeFileSync(path.join(project, "note.txt"), "READ-MARKER");
  let requests = 0;

  globalThis.fetch = async () => {
    requests++;
    const frames = requests === 1 ? [
      { choices: [{ delta: { reasoning_content: "R".repeat(20000), tool_calls: [{ index: 0, id: "read",
        function: { name: "read_file", arguments: '{"path":"note.txt"}' } }] }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ] : [{ choices: [{ delta: { content: "Done." }, finish_reason: "stop" }] }];

    return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n");
  };
  const wiring = wirePorts({ providerId: "openai-compatible", model: "glm-5.3-flash",
    endpoint: "https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions", apiKey: "fixture-key", workspaceRoot: project,
    permission: createFakePermission("approved"), nowMs: 0, toolSelection: ["read_file"] });

  assert.ok("ports" in wiring);

  try {
    const result = await runTurn({ ...wiring.ports, compaction: { ...wiring.ports.compaction!, summarize: () => summary } },
      { sessionId: "s", turnId: "t", correlationId: "c", text: "Read note.txt.", model: "glm-5.3-flash",
        budget: { maxIterations: 4, contextTokenLimit: 4096 } });
    assert.equal(requests, 1, "native replay alone exceeds the ceiling; no second request may escape");
    assert.equal(result.state.terminalReason, "failed");
    assert.equal(result.envelopes.at(-1)?.payload["cause"], "context_limit");
  } finally {
    globalThis.fetch = originalFetch;
    await wiring.close();
    assert.equal(path.dirname(fs.realpathSync(project)), fs.realpathSync(os.tmpdir()));
    fs.rmSync(project, { recursive: true, force: true });
  }
});
