import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createSubagentToolBoundary,
  guardSubagentAttribution,
  SubagentLineageError,
  validateSubagentLineage,
} from "./lineage.js";
import { buildPermissionAction, createPermissionGrantCache } from "../loop/permission-grants.js";
import type { ToolBinding, ToolCallRequest, ToolOutcome, ToolPort } from "../ports/tools.js";

function createCatalogTools(bindings: ToolBinding[]): {
  readonly tools: ToolPort;
  readonly executedCalls: ToolCallRequest[];
} {
  const executedCalls: ToolCallRequest[] = [];
  const tools: ToolPort = {
    snapshot() {
      return bindings;
    },
    async execute(call: ToolCallRequest): Promise<ToolOutcome> {
      executedCalls.push(call);
      return {
        outcome: "result",
        value: { executed: call.name },
        output: "ok",
        truncated: false,
      };
    },
    async cancel() {},
  };

  return { tools, executedCalls };
}

/**
 * A live run signal. The cases below exercise the permission gates and the
 * cancellation gate, never the run's own cancellation, so it is never aborted.
 */
const liveRun = new AbortController().signal;

const mockBindings: ToolBinding[] = [
  {
    name: "read_file",
    description: "Read a file",
    sideEffect: "read_only",
    parameters: {},
    needsApproval: false,
    timeoutMs: 5000,
    outputLimits: { maxBytes: 1000, maxLines: 100 },
  },
  {
    name: "write_file",
    description: "Write a file",
    sideEffect: "workspace_write",
    parameters: {},
    needsApproval: true,
    timeoutMs: 5000,
    outputLimits: { maxBytes: 1000, maxLines: 100 },
  },
  {
    name: "run_shell",
    description: "Execute a shell command",
    sideEffect: "external",
    parameters: {},
    needsApproval: true,
    timeoutMs: 10000,
    outputLimits: { maxBytes: 1000, maxLines: 100 },
  },
];

test("SA-2 权限血缘：子代理权限严格继承，只能调用白名单范围内的工具", async () => {
  const { tools, executedCalls } = createCatalogTools(mockBindings);
  const lineage = { parentAgentId: "main-agent", rootAttemptId: "att-root-1" };
  const subagentTools = createSubagentToolBoundary(
    tools,
    { allowedTools: ["read_file"] },
    lineage,
    liveRun,
  );

  // snapshot only exposes allowed tool
  const snapshot = subagentTools.snapshot();

  assert.equal(snapshot.length, 1);
  assert.equal(snapshot[0]?.name, "read_file");

  // invoking allowed tool succeeds
  const res = await subagentTools.execute(
    { toolCallId: "call-1", name: "read_file", arguments: { path: "a.txt" } },
    new AbortController().signal,
  );

  assert.equal(res.outcome, "result");
  assert.equal(executedCalls.length, 1);
});

test("SA-2 对抗/红线（必红被阻断）：子代理试图拓宽权限调用非白名单工具，严厉拒绝", async () => {
  const { tools } = createCatalogTools(mockBindings);
  const lineage = { parentAgentId: "main-agent", rootAttemptId: "att-root-2" };
  const subagentTools = createSubagentToolBoundary(
    tools,
    { allowedTools: ["read_file"] }, // write_file is not allowed!
    lineage,
    liveRun,
  );

  // Subagent attempts to invoke write_file
  const res = await subagentTools.execute(
    { toolCallId: "call-hack", name: "write_file", arguments: { path: "hack.txt" } },
    new AbortController().signal,
  );

  assert.equal(res.outcome, "error");

  if (res.outcome === "error") {
    assert.equal(res.code, "subagent_permission_denied");
  }
});

test("SA-2 对抗/红线（必红被阻断）：子代理无独立审批通道，未预授权的高危工具严禁发起审批弹窗", async () => {
  const { tools } = createCatalogTools(mockBindings);
  const lineage = { parentAgentId: "main-agent", rootAttemptId: "att-root-3" };
  // write_file is allowed in tool whitelist, BUT requires user approval!
  const subagentTools = createSubagentToolBoundary(
    tools,
    { allowedTools: ["write_file"] },
    lineage,
    liveRun,
  );

  const res = await subagentTools.execute(
    { toolCallId: "call-unapproved", name: "write_file", arguments: { path: "danger.txt" } },
    new AbortController().signal,
  );

  assert.equal(res.outcome, "error");

  if (res.outcome === "error") {
    assert.equal(res.code, "subagent_approval_channel_forbidden");
    assert.match(res.message, /cannot prompt users/);
  }
});

test("SA-2 权限血缘：父代理已预授权的 grant 可被子代理安全消费", async () => {
  const { tools, executedCalls } = createCatalogTools(mockBindings);
  const lineage = { parentAgentId: "main-agent", rootAttemptId: "att-root-4" };
  const grants = createPermissionGrantCache();
  const writeArgs = { path: "safe.txt" };
  const action = buildPermissionAction("call-preapproved", "write_file", writeArgs);

  // Pre-approved by human in parent agent with session scope
  grants.record(action, "approved", "session");

  const subagentTools = createSubagentToolBoundary(
    tools,
    { allowedTools: ["write_file"], inheritedGrants: grants },
    lineage,
    liveRun,
  );

  const res = await subagentTools.execute(
    { toolCallId: "call-preapproved", name: "write_file", arguments: writeArgs },
    new AbortController().signal,
  );

  assert.equal(res.outcome, "result");
  assert.equal(executedCalls.length, 1);
});

test("SA-2 血缘归因：子代理事件与日志严格归属于 rootAttemptId", () => {
  const lineage = { parentAgentId: "main-agent", rootAttemptId: "att-root-77" };
  const guarded = guardSubagentAttribution(
    "subagent_spawn",
    { subagentId: "sub-1", name: "scanner" },
    lineage,
  );

  assert.equal(guarded.rootAttemptId, "att-root-77");
});

test("SA-2 对抗/红线（必红被阻断）：子代理日志伪装成用户反馈或用户输入，严厉阻断", () => {
  const lineage = { parentAgentId: "main-agent", rootAttemptId: "att-root-88" };

  // 1. Attempt to emit user_correction
  assert.throws(
    () => {
      guardSubagentAttribution("user_correction", { correction: "malicious" }, lineage);
    },
    (err: unknown) => {
      return (
        err instanceof SubagentLineageError && err.code === "subagent_masquerade_blocked"
      );
    },
  );

  // 2. Attempt to emit user_cancel
  assert.throws(
    () => {
      guardSubagentAttribution("user_cancel", { phase: "streaming" }, lineage);
    },
    (err: unknown) => {
      return (
        err instanceof SubagentLineageError && err.code === "subagent_masquerade_blocked"
      );
    },
  );

  // 3. Attempt to inject payload claiming role = 'user'
  assert.throws(
    () => {
      guardSubagentAttribution("observation", { role: "user", text: "fake input" }, lineage);
    },
    (err: unknown) => {
      return (
        err instanceof SubagentLineageError && err.code === "subagent_masquerade_blocked"
      );
    },
  );
});

test("SA-2 校验：缺 parentAgentId 或 rootAttemptId 抛出校验异常", async () => {
  assert.throws(() => {
    validateSubagentLineage({ parentAgentId: "", rootAttemptId: "att-1" });
  }, /parentAgentId/);

  assert.throws(() => {
    validateSubagentLineage({ parentAgentId: "agent-1", rootAttemptId: "" });
  }, /rootAttemptId/);
});

/**
 * CLI-01B: a cancelled call must not reach the real tool port.
 *
 * "No new tool dispatch after a cancel" has to be structural, or a worker that
 * ignores its abort signal keeps reaching the tools the run was torn down to
 * stop.
 */
test("CLI-01B 工具边界：已取消的调用不得派发到真实工具", async () => {
  const { tools, executedCalls } = createCatalogTools(mockBindings);
  const lineage = { parentAgentId: "main-agent", rootAttemptId: "att-cancel-boundary" };
  const subagentTools = createSubagentToolBoundary(
    tools,
    { allowedTools: ["read_file"] },
    lineage,
    liveRun,
  );

  const cancelled = new AbortController();

  cancelled.abort("parent_cancelled");

  const res = await subagentTools.execute(
    { toolCallId: "call-after-cancel", name: "read_file", arguments: { path: "a.txt" } },
    cancelled.signal,
  );

  assert.notEqual(res.outcome, "result", "a cancelled call must not be dispatched");
  assert.equal(executedCalls.length, 0, "the real tool port must not be reached");
});

/**
 * CLI-01B: a call that was already dispatched is stopped through the existing
 * cancel path, and the tool's own answer is the answer.
 */
test("CLI-01B 工具边界：在飞调用走 ToolPort.cancel，工具给出的结局就是结局", async () => {
  const cancelledCalls: string[] = [];
  const answers = new Map<string, (outcome: ToolOutcome) => void>();
  const tools: ToolPort = {
    snapshot() {
      return mockBindings;
    },
    execute(call: ToolCallRequest): Promise<ToolOutcome> {
      return new Promise<ToolOutcome>((resolve) => {
        answers.set(call.toolCallId, resolve);
      });
    },
    async cancel(toolCallId: string): Promise<void> {
      cancelledCalls.push(toolCallId);
      answers.get(toolCallId)?.({
        outcome: "result",
        value: { stopped: true },
        output: "stopped",
        truncated: false,
      });
    },
  };

  const run = new AbortController();
  const lineage = { parentAgentId: "main-agent", rootAttemptId: "att-in-flight" };
  const subagentTools = createSubagentToolBoundary(
    tools,
    { allowedTools: ["read_file"] },
    lineage,
    run.signal,
  );
  const pending = subagentTools.execute(
    { toolCallId: "call-in-flight", name: "read_file", arguments: { path: "a.txt" } },
    new AbortController().signal,
  );

  run.abort("cancelled_mid_flight");
  const outcome = await pending;

  assert.deepEqual(cancelledCalls, ["call-in-flight"], "the existing cancel path is used");
  assert.equal(outcome.outcome, "result");

  if (outcome.outcome === "result") {
    assert.equal(outcome.output, "stopped");
  }
});

/**
 * CLI-01B: a tool that never answers leaves the side effect unknown — never a
 * success, and never a clean cancellation either.
 */
test("CLI-01B 工具边界：工具不回应取消时显式报 unknown，不报成功", async () => {
  const cancelledCalls: string[] = [];
  const tools: ToolPort = {
    snapshot() {
      return mockBindings;
    },
    execute(): Promise<ToolOutcome> {
      // A tool that never settles: whether it started a side effect cannot be
      // confirmed in either direction.
      return new Promise<ToolOutcome>(() => {});
    },
    async cancel(toolCallId: string): Promise<void> {
      cancelledCalls.push(toolCallId);
    },
  };

  const run = new AbortController();
  const lineage = { parentAgentId: "main-agent", rootAttemptId: "att-unknown-outcome" };
  const subagentTools = createSubagentToolBoundary(
    tools,
    { allowedTools: ["read_file"] },
    lineage,
    run.signal,
  );
  const pending = subagentTools.execute(
    { toolCallId: "call-unknown", name: "read_file", arguments: { path: "a.txt" } },
    new AbortController().signal,
  );

  run.abort("cancelled_mid_flight");
  const outcome = await pending;

  assert.deepEqual(cancelledCalls, ["call-unknown"], "the existing cancel path is used");
  assert.equal(outcome.outcome, "unknown");

  if (outcome.outcome === "unknown") {
    assert.equal(outcome.code, "call_cancelled_outcome_unknown");
  }
});
