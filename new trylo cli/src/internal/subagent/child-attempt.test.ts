import assert from "node:assert/strict";
import { test } from "node:test";
import { createFixtureProvider, DEFAULT_FIXTURE_SCRIPT } from "../adapters/provider/fixture.js";
import type { PermissionPort } from "../ports/permission.js";
import type { ToolBinding, ToolCallRequest, ToolOutcome, ToolPort } from "../ports/tools.js";
import type { Envelope } from "../protocol/envelope.js";
import { createChildAttemptWorker, DEFAULT_PROFILE_PORT } from "./child-attempt.js";
import { SubagentGovernanceTracker } from "./governance.js";
import { SubagentRuntime } from "./runtime.js";

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

function createMockWorkspaceTools(): {
  readonly tools: ToolPort;
  readonly executedCalls: ToolCallRequest[];
} {
  const executedCalls: ToolCallRequest[] = [];
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
    {
      name: "write_file",
      description: "Write file",
      sideEffect: "workspace_write",
      parameters: {},
      needsApproval: true,
      timeoutMs: 5000,
      outputLimits: { maxBytes: 1000, maxLines: 100 },
    },
  ];

  const tools: ToolPort = {
    snapshot() {
      return bindings;
    },
    async execute(call: ToolCallRequest): Promise<ToolOutcome> {
      executedCalls.push(call);
      if (call.name === "read_file") {
        return {
          outcome: "result",
          value: { content: '{"name": "@trylo/subagent-pkg"}' },
          output: '{"name": "@trylo/subagent-pkg"}',
          truncated: false,
        };
      }
      return { outcome: "error", code: "unsupported", message: "unsupported" };
    },
    async cancel() {},
  };

  return { tools, executedCalls };
}

test("SA-S-1 真实执行器：再入同一引擎完成子任务，输出结果与真实 Usage", async () => {
  const provider = createFixtureProvider(DEFAULT_FIXTURE_SCRIPT);
  const permission = createMockPermission();
  const { tools, executedCalls } = createMockWorkspaceTools();
  const childEnvelopes: Envelope[] = [];

  const runtime = new SubagentRuntime({ tools });

  const worker = createChildAttemptWorker({
    provider,
    permission,
    profile: DEFAULT_PROFILE_PORT,
    prompt: "inspect package.json",
    onEnvelope: (env) => {
      childEnvelopes.push(env);
    },
  });

  const handle = runtime.spawn({
    name: "child_inspector",
    lineage: {
      parentAgentId: "main-agent",
      rootAttemptId: "att-root-99",
    },
    permissions: {
      allowedTools: ["read_file"], // tool boundary allows read_file
    },
    worker,
  });

  const res = await handle.wait();
  assert.equal(res.status, "completed");
  assert.ok(res.output);
  assert.equal(res.output.status, "completed");
  assert.match(res.output.output, /@trylo\/subagent-pkg/);
  assert.equal(executedCalls.length, 1);
  assert.ok(res.usage.inputTokens > 0);
  assert.ok(res.usage.outputTokens > 0);

  // Assert lineage on child envelopes
  assert.ok(childEnvelopes.length > 0);
  for (const env of childEnvelopes) {
    assert.equal(env.attemptId, "att-root-99");
  }
});

test("SA-S-1 真实执行器：工具边界拦截，未授权工具在子任务中被直接阻断", async () => {
  const provider = createFixtureProvider(DEFAULT_FIXTURE_SCRIPT); // calls read_file
  const permission = createMockPermission();
  const { tools, executedCalls } = createMockWorkspaceTools();
  const envelopes: Envelope[] = [];

  const runtime = new SubagentRuntime({ tools });

  const worker = createChildAttemptWorker({
    provider,
    permission,
    profile: DEFAULT_PROFILE_PORT,
    prompt: "attempt unauthorized tool call",
    onEnvelope: envelope => { envelopes.push(envelope); },
  });

  const handle = runtime.spawn({
    name: "blocked_subagent",
    lineage: {
      parentAgentId: "main-agent",
      rootAttemptId: "att-root-100",
    },
    permissions: {
      allowedTools: [], // empty allowedTools: read_file is NOT allowed!
    },
    worker,
  });

  const res = await handle.wait();
  assert.equal(res.status, "failed");
  assert.equal(res.error?.code, "subagent_permission_denied");
  // Underlying tool was never executed because boundary blocked it
  assert.equal(executedCalls.length, 0);
  assert.ok(envelopes.some(envelope => envelope.kind === "permission_denied"),
    "the refusal is recorded before dispatch, rather than presented as successful delegated work");
});

test("SA-S-1 真实执行器：Token 预算硬顶，超额消耗中止子 turn", async () => {
  const provider = createFixtureProvider(DEFAULT_FIXTURE_SCRIPT);
  const permission = createMockPermission();
  const { tools } = createMockWorkspaceTools();

  const governance = new SubagentGovernanceTracker({ tokenBudget: 20 }); // strict low token budget
  const runtime = new SubagentRuntime({ tools, governance });

  const worker = createChildAttemptWorker({
    provider,
    permission,
    profile: DEFAULT_PROFILE_PORT,
    prompt: "inspect package.json with low budget",
  });

  const handle = runtime.spawn({
    name: "budget_capped_subagent",
    lineage: {
      parentAgentId: "main-agent",
      rootAttemptId: "att-root-101",
    },
    permissions: {
      allowedTools: ["read_file"],
    },
    governance: {
      tokenBudget: 20,
    },
    worker,
  });

  const res = await handle.wait();
  assert.equal(res.status, "failed");
  assert.equal(res.error?.code, "token_budget_exhausted");
});
