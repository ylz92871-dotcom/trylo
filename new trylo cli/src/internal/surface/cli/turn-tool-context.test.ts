import assert from "node:assert/strict";
import { test } from "node:test";
import { createFakeTools, createFakePermission } from "../../loop/fakes.js";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { executeTurn, isTurnFailure } from "./host.js";
import { createRunExecution } from "./run-execution-wiring.js";
import { resolveToolPrompt } from "./turn-tool-context.js";

test("native context receives the final mounted names unchanged and only appends to caller instructions", async () => {
  const tools = createFakeTools([], [{ name: "run_shell", description: "shell", parameters: {}, sideEffect: "external", needsApproval: true,
    timeoutMs: 1000, outputLimits: { maxBytes: 1000, maxLines: 20 } },
  { name: "mcp__native__read", description: "read", parameters: {}, sideEffect: "read_only", needsApproval: false,
    timeoutMs: 1000, outputLimits: { maxBytes: 1000, maxLines: 20 } }]);
  const signal = new AbortController().signal;
  const result = await resolveToolPrompt({ systemPromptAppend: "CALLER", cancelSignal: signal, async toolPromptContext(input) {
    assert.deepEqual(input.mountedTools, ["run_shell", "mcp__native__read"]);
    assert.equal(input.signal, signal);
    return "OFFICIAL_INDEX";
  } }, tools);

  assert.equal(result, "CALLER\n\nOFFICIAL_INDEX");
  assert.equal(tools.snapshot()[0]?.needsApproval, true);
});

test("absent context does not inspect tools; cancellation and empty context preserve existing text", async () => {
  const forbidden = { snapshot() { throw new Error("unexpected snapshot"); }, execute: async () => ({ outcome: "cancelled" as const }), cancel: async () => {} };
  assert.equal(await resolveToolPrompt({ systemPromptAppend: "CALLER" }, forbidden), "CALLER");
  const cancel = new AbortController();
  cancel.abort();
  assert.equal(await resolveToolPrompt({ systemPromptAppend: "CALLER", cancelSignal: cancel.signal,
    toolPromptContext: async () => { throw new Error("unexpected context"); } }, forbidden), "CALLER");
  assert.equal(await resolveToolPrompt({ toolPromptContext: async () => "" }, createFakeTools([], [])), undefined);
});

test("the actual host resolves context after selection and before the provider sees its first request", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "trylo-tool-prompt-"));

  t.after(() => rm(root, { recursive: true, force: true }));
  const execution = createRunExecution(root, { homeDir: root, env: {}, shellIsolation: "host" });

  t.after(() => execution.close());
  const selected = { name: "selected_exact", description: "selected", parameters: {}, sideEffect: "read_only" as const, needsApproval: false,
    timeoutMs: 1000, outputLimits: { maxBytes: 1000, maxLines: 20 } };
  const tools = createFakeTools([], [selected, { ...selected, name: "excluded_exact" }]);
  let prepared = 0, requests = 0;
  const result = await executeTurn({ text: "inspect", sessionId: "s", turnId: "t", correlationId: "c", workspaceRoot: root,
    workspaceId: "w", checkpointRoot: path.join(root, "checkpoints"), providerId: "fixture", model: "m", endpoint: "", apiKey: undefined,
    permission: createFakePermission("approved"), format: "stream-json", sink: { stdout() {}, stderr() {} }, now: () => 0,
    additionalTools: tools, toolSelection: ["selected_exact"], execution, maxIterations: 1, systemPromptAppend: "CALLER",

    async toolPromptContext(input) {
      prepared++;
      assert.deepEqual(input.mountedTools, ["selected_exact"]);
      return "OFFICIAL_INDEX";
    },

    providerGuard: () => ({ async *stream(request) {
      requests++;
      assert.equal(prepared, 1);
      assert.deepEqual(request.tools.map(item => item.name), ["selected_exact"]);
      assert.ok(request.messages.some(item => item.role === "system" && item.content === "CALLER\n\nOFFICIAL_INDEX"));
      yield { type: "finish" as const, reason: "stop" as const, rawReason: "stop", requiresFollowUp: false };
    } }) });

  assert.equal(isTurnFailure(result), false, JSON.stringify(result));
  assert.equal(requests, 1);
  assert.equal(prepared, 1);
});
