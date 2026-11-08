import assert from "node:assert/strict";
import { test } from "node:test";
import { createFixtureProvider, DEFAULT_FIXTURE_SCRIPT } from "../adapters/provider/fixture.js";
import type { PermissionPort } from "../ports/permission.js";
import type { ProviderEvent, ProviderPort } from "../ports/provider.js";
import type { ToolBinding, ToolCallRequest, ToolOutcome, ToolPort } from "../ports/tools.js";
import { DEFAULT_PROFILE_PORT } from "./child-attempt.js";
import { SubagentRuntime } from "./runtime.js";
import {
  createSubagentToolPort,
  DELEGATE_SUBAGENT_BINDING,
  mountSubagentTool,
  SUBAGENT_TOOL_NAME,
} from "./subagent-tool.js";

function createMockPermission(): PermissionPort {
  return {
    async request(action) {
      return { ticketId: "t-1", toolCallId: action.toolCallId };
    },
    async awaitDecision() {
      return { resolution: "approved", scope: "session" };
    },
  };
}

/**
 * A provider that never answers: its stream neither yields nor finishes, so the
 * subagent that uses it can only be observed, never completed.
 */
function createHangingProvider(): ProviderPort {
  return {
    stream(): AsyncIterable<ProviderEvent> {
      return {
        [Symbol.asyncIterator](): AsyncIterator<ProviderEvent> {
          return {
            next: () => new Promise<IteratorResult<ProviderEvent>>(() => {}),
          };
        },
      };
    },
  };
}

function createMockWorkspaceTools(): ToolPort {
  const bindings: ToolBinding[] = [
    {
      name: "read_file",
      description: "Read file",
      sideEffect: "read_only",
      parameters: {},
      needsApproval: false,
      timeoutMs: 5000,
      outputLimits: { maxBytes: 1000, maxLines: 100 },
    },
  ];

  return {
    snapshot() {
      return bindings;
    },
    async execute(call: ToolCallRequest): Promise<ToolOutcome> {
      if (call.name === "read_file") {
        return {
          outcome: "result",
          value: { content: '{"name": "@trylo/subagent-tool-pkg"}' },
          output: '{"name": "@trylo/subagent-tool-pkg"}',
          truncated: false,
        };
      }
      return { outcome: "error", code: "unsupported", message: "unsupported" };
    },
    async cancel() {},
  };
}

test("SA-S-2 subagent-tool: 契约与绑定符合安全边界与只读规格", () => {
  assert.equal(DELEGATE_SUBAGENT_BINDING.name, SUBAGENT_TOOL_NAME);
  assert.equal(DELEGATE_SUBAGENT_BINDING.sideEffect, "read_only");
  assert.equal(DELEGATE_SUBAGENT_BINDING.needsApproval, false);
  assert.ok(DELEGATE_SUBAGENT_BINDING.parameters);
});

test("SA-S-2 subagent-tool: execute 成功调度真实子代理再入，返回结果与 usage", async () => {
  const provider = createFixtureProvider(DEFAULT_FIXTURE_SCRIPT);
  const permission = createMockPermission();
  const parentTools = createMockWorkspaceTools();
  const runtime = new SubagentRuntime({ tools: parentTools });

  const subagentTool = createSubagentToolPort({
    runtime,
    provider,
    permission,
    profile: DEFAULT_PROFILE_PORT,
  });

  const outcome = await subagentTool.execute(
    {
      toolCallId: "call-sa-1",
      name: SUBAGENT_TOOL_NAME,
      arguments: {
        taskName: "inspect_project",
        prompt: "read package.json and inspect",
        allowedTools: ["read_file"],
      },
    },
    new AbortController().signal,
  );

  assert.equal(outcome.outcome, "result");

  if (outcome.outcome === "result") {
    assert.equal(outcome.value["status"], "completed");
    assert.match(String(outcome.value["output"]), /@trylo\/subagent-tool-pkg/);
    const usage = outcome.value["usage"] as { inputTokens?: number; outputTokens?: number };
    assert.ok(Number(usage.inputTokens) > 0);
    assert.ok(Number(usage.outputTokens) > 0);
  }
});

test("SA-M: the child attempt asks for the run's model, never the engine's fallback", async () => {
  const seen: string[] = [];
  const provider: ProviderPort = {
    async *stream(request): AsyncIterable<ProviderEvent> {
      seen.push(request.model);
      yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
    },
  };

  const subagentTool = createSubagentToolPort({
    runtime: new SubagentRuntime({ tools: createMockWorkspaceTools() }),
    provider,
    permission: createMockPermission(),
    profile: DEFAULT_PROFILE_PORT,
    model: "radeon-deepseek",
  });

  const outcome = await subagentTool.execute(
    {
      toolCallId: "call-sa-model",
      name: SUBAGENT_TOOL_NAME,
      arguments: { taskName: "answer", prompt: "What is 2 plus 2?" },
    },
    new AbortController().signal,
  );

  assert.equal(outcome.outcome, "result");
  assert.deepEqual(seen, ["radeon-deepseek"]);
});

test("SA-S-2 subagent-tool: mountSubagentTool 挂载入主工具目录且互不冲突", async () => {
  const provider = createFixtureProvider(DEFAULT_FIXTURE_SCRIPT);
  const permission = createMockPermission();
  const parentTools = createMockWorkspaceTools();
  const runtime = new SubagentRuntime({ tools: parentTools });

  const subagentTool = createSubagentToolPort({
    runtime,
    provider,
    permission,
    profile: DEFAULT_PROFILE_PORT,
  });

  const composed = mountSubagentTool(parentTools, subagentTool);
  const snapshot = composed.snapshot();

  assert.equal(snapshot.length, 2);
  const names = snapshot.map((b) => b.name);

  assert.ok(names.includes("read_file"));
  assert.ok(names.includes(SUBAGENT_TOOL_NAME));

  // Regular parent tool can still be called
  const readRes = await composed.execute(
    { toolCallId: "call-read-1", name: "read_file", arguments: { path: "package.json" } },
    new AbortController().signal,
  );

  assert.equal(readRes.outcome, "result");

  // Subagent tool can be called
  const saRes = await composed.execute(
    {
      toolCallId: "call-sa-2",
      name: SUBAGENT_TOOL_NAME,
      arguments: {
        taskName: "composed_inspect",
        prompt: "check package",
        allowedTools: ["read_file"],
      },
    },
    new AbortController().signal,
  );

  assert.equal(saRes.outcome, "result");
});

/**
 * CLI-01B: the delegation's `timeoutMs` is its *execution* budget — it ends the
 * run, it does not merely stop waiting — while the slot the run holds follows
 * whether the worker really stopped.
 */
test("CLI-01B subagent-tool：delegation 超时结束运行，名额仍由 worker 是否停止决定", async () => {
  const runtime = new SubagentRuntime({ tools: createMockWorkspaceTools() });
  const subagentTool = createSubagentToolPort({
    runtime,
    provider: createHangingProvider(),
    permission: createMockPermission(),
    profile: DEFAULT_PROFILE_PORT,
  });

  const outcome = await subagentTool.execute(
    {
      toolCallId: "call-delegation-timeout",
      name: SUBAGENT_TOOL_NAME,
      arguments: {
        taskName: "stuck_delegation",
        prompt: "wait forever",
        timeoutMs: 5,
      },
    },
    new AbortController().signal,
  );

  assert.equal(outcome.outcome, "error");

  if (outcome.outcome === "error") {
    assert.equal(outcome.code, "subagent_timed_out");
  }

  // The run is settled, but this provider ignores its abort signal, so the slot
  // is still occupied: the cap bounds an unstoppable worker at the price of a
  // slot it keeps holding. That is the documented boundary, not a claim that it
  // stopped.
  const [activeId] = runtime.getActiveInstances();

  assert.ok(activeId !== undefined, "an unstoppable worker keeps its slot");
  assert.equal(runtime.status(activeId), "timed_out");
});

/**
 * CLI-01B: a delegation cancelled by its caller is a cancelled tool, not a
 * failed one — the loop must not report an interrupt to the model as an error.
 */
test("CLI-01B subagent-tool：父调用取消时工具报 cancelled，不报失败", async () => {
  const runtime = new SubagentRuntime({ tools: createMockWorkspaceTools() });
  const subagentTool = createSubagentToolPort({
    runtime,
    provider: createFixtureProvider(DEFAULT_FIXTURE_SCRIPT),
    permission: createMockPermission(),
    profile: DEFAULT_PROFILE_PORT,
  });

  const cancelled = new AbortController();

  cancelled.abort("parent_cancelled");

  const outcome = await subagentTool.execute(
    {
      toolCallId: "call-parent-cancelled",
      name: SUBAGENT_TOOL_NAME,
      arguments: { taskName: "cancelled_delegation", prompt: "never runs" },
    },
    cancelled.signal,
  );

  assert.equal(outcome.outcome, "cancelled");
  assert.deepEqual(runtime.getActiveInstances(), [], "the cancelled delegation kept no slot");
});
