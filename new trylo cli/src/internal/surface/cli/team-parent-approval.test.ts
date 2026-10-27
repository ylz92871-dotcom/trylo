import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { PermissionAction, PermissionDecision, PermissionRequestContext } from "../../ports/permission.js";
import type { ProviderPort } from "../../ports/provider.js";
import type { JsonObject } from "../../protocol/envelope.js";
import type { ToolOutcome, ToolPort, ToolSandbox } from "../../ports/tools.js";
import type { ExecPolicyGuard } from "../../loop/tool-admission.js";
import { buildPermissionAction, createPermissionGrantCache } from "../../loop/permission-grants.js";
import { createInteractivePermission } from "./permission.js";
import { buildSubagentPorts } from "./wiring-subagent.js";

const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
function value(outcome: ToolOutcome): JsonObject {
  assert.equal(outcome.outcome, "result");
  return outcome.outcome === "result" ? outcome.value : {};
}
async function harness(t: TestContext, answer: (action: PermissionAction, context?: PermissionRequestContext) => Promise<PermissionDecision>,
  options: { readonly count?: number; readonly differentLast?: boolean; readonly enabled?: boolean; readonly constrained?: boolean;
    readonly execPolicy?: ExecPolicyGuard; readonly sandbox?: ToolSandbox; readonly bindingApproval?: boolean } = {}) {
  const approvals: { action: PermissionAction; context: PermissionRequestContext | undefined }[] = [];
  const effects: JsonObject[] = [];
  let announce!: () => void;
  const requested = new Promise<void>(resolve => { announce = resolve; });
  const grants = createPermissionGrantCache();
  const tools: ToolPort = { snapshot: () => [{ name: "write_file", description: "write", parameters: {},
    needsApproval: options.bindingApproval ?? true, sideEffect: "workspace_write", timeoutMs: 1000, outputLimits: { maxBytes: 1000, maxLines: 10 } }],
    execute: async call => { effects.push(call.arguments); return { outcome: "result", value: {}, output: "written", truncated: false }; },
    cancel: async () => {} };
  const permission = createInteractivePermission({ ...(options.enabled === false ? {} : { supportsMemberApproval: true as const }),
    prompt: () => {}, readLine: async () => { throw new Error("A member cannot open another input reader"); },
    requestApproval: async (action, context) => { approvals.push({ action, context }); announce(); return answer(action, context); } });
  let ids = 0;
  const advertised: string[][] = [];
  const provider: ProviderPort = { async *stream(request) {
    if (request.model === "worker") {
      advertised.push(request.tools.map(tool => tool.name));
      let lastUser = -1;
      request.messages.forEach((message, index) => { if (message.role === "user") lastUser = index; });
      const count = request.messages.slice(lastUser + 1).filter(message => message.role === "tool").length;
      if (count < (options.count ?? 1)) {
        yield { type: "tool_call", name: "write_file", toolCallId: `write-${++ids}`, arguments: {
          path: options.constrained ? "blocked.txt" : "probe.txt", content: options.differentLast && count === 2 ? "different" : "same" } };
        yield { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true };
        return;
      }
    }
    yield { type: "text_start", blockId: "answer" };
    yield { type: "text_delta", blockId: "answer", text: "clear" };
    yield { type: "text_end", blockId: "answer" };
    yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
  } };
  const built = buildSubagentPorts({ parentTools: tools, workspaceTools: tools, childProvider: provider, model: "parent",
    callerMessages: undefined, permission, grants,
    ...(options.execPolicy === undefined ? {} : { execPolicy: options.execPolicy }),
    ...(options.sandbox === undefined ? {} : { sandbox: options.sandbox }),
    team: { runId: "team-approve", inspectRepresentation: () => ({ ready: true }),
      ...(options.constrained ? { constrainTool: () => ({ ok: false as const, code: "team_output_scope_denied", message: "outside member output" }) } : {}),
      members: ["person", "worker-a", "worker-b"].map(id => {
        const role = id === "person" ? "person" : "worker";
        return { memberId: id, baseRole: role, displayName: `成员 ${id}`, role: { name: role, model: role, description: role } };
      }) } });
  t.after(async () => { await built.runtime.cancelAll(); });
  let sequence = 0;
  const call = (name: string, args: JsonObject) => built.tools.execute({ name, arguments: args,
    toolCallId: `parent-${++sequence}` }, new AbortController().signal);
  const person = String(value(await call("spawn_agent", { agent_type: "person", member_id: "person", message: "represent" }))["task_id"]);
  await call("wait_agent", { targets: [person], timeout_ms: 1000 });
  const start = async (member = "worker-a") => value(await call("spawn_agent", { agent_type: "worker", member_id: member, message: "implement" }));
  const collect = (task: JsonObject) => call("wait_agent", { targets: [task["task_id"] ?? ""], timeout_ms: 1000 });
  return { call, start, collect, grants, approvals, effects, advertised, requested, runtime: built.runtime };
}

test("each once approval authorizes one exact member action without creating a session grant", async t => {
  const h = await harness(t, async () => ({ resolution: "approved", scope: "once" }), { count: 2 });
  const worker = await h.start(); await h.collect(worker);
  assert.equal(h.approvals.length, 2);
  assert.equal(h.effects.length, 2);
  assert.deepEqual(h.grants.entries(), []);
  assert.ok(h.advertised.every(names => names.includes("write_file")));
  assert.equal(h.approvals[0]?.context?.requester?.taskId, worker["task_id"]);
  assert.equal(h.approvals[0]?.context?.requester?.memberId, "worker-a");
  assert.equal(h.approvals[0]?.context?.requester?.teamRunId, "team-approve");
  assert.notEqual(h.approvals[0]?.action.toolCallId, "write-1");
});

test("the parent records session approval for exact arguments and asks again for a different action", async t => {
  const h = await harness(t, async () => ({ resolution: "approved", scope: "session" }), { count: 3, differentLast: true });
  await h.collect(await h.start());
  assert.equal(h.effects.length, 3);
  assert.equal(h.approvals.length, 2);
  assert.equal(h.grants.entries().length, 2);
});

test("a parent denial reaches the member without executing the action", async t => {
  const h = await harness(t, async () => ({ resolution: "denied", scope: "once", reason: "user_denied" }));
  await h.collect(await h.start());
  assert.equal(h.approvals.length, 1);
  assert.equal(h.effects.length, 0);
});

test("the parent's execution policy authorizes an exact member action without opening another prompt", async t => {
  const h = await harness(t, async () => { throw new Error("Policy-approved calls must not prompt"); },
    { execPolicy: () => ({ kind: "approved" }) });
  await h.collect(await h.start());
  assert.equal(h.approvals.length, 0);
  assert.equal(h.effects.length, 1);
  assert.deepEqual(h.grants.entries(), []);
});

test("a standing execution-policy refusal is applied before parent approval", async t => {
  const h = await harness(t, async () => ({ resolution: "approved", scope: "once" }),
    { execPolicy: () => ({ kind: "denied", code: "command_denied", message: "standing refusal" }) });
  await h.collect(await h.start());
  assert.equal(h.approvals.length, 0);
  assert.equal(h.effects.length, 0);
});

test("an argument-dependent sandbox approval reaches the parent even when the catalog binding needs no approval", async t => {
  const sandbox: ToolSandbox = { policy: { mode: "workspace_write", network: "restricted", workspaceRoot: "D:/fixture",
    maxWriteBytes: 1000, allowAbsoluteExecutable: false }, evaluate: () => ({ ok: true }),
    requiresApproval: call => call.arguments["path"] === "probe.txt" };
  const h = await harness(t, async () => ({ resolution: "approved", scope: "once" }), { sandbox, bindingApproval: false });
  await h.collect(await h.start());
  assert.equal(h.approvals.length, 1);
  assert.equal(h.effects.length, 1);
});

test("member constraints reject an action before the root UI is asked", async t => {
  const h = await harness(t, async () => ({ resolution: "approved", scope: "once" }), { constrained: true });
  await h.collect(await h.start());
  assert.equal(h.approvals.length, 0);
  assert.equal(h.effects.length, 0);
});

test("older permission adapters do not acquire a new member approval channel", async t => {
  const h = await harness(t, async () => ({ resolution: "approved", scope: "once" }), { enabled: false });
  await h.collect(await h.start());
  assert.equal(h.approvals.length, 0);
  assert.equal(h.effects.length, 0);
  assert.ok(h.advertised.every(names => !names.includes("write_file")));
});

test("stopping a member awaiting approval discards a late approved reply", { timeout: 10000 }, async t => {
  let release!: (answer: PermissionDecision) => void;
  const held = new Promise<PermissionDecision>(resolve => { release = resolve; });
  t.after(() => { release({ resolution: "approved", scope: "session" }); });
  const h = await harness(t, async () => held);
  const worker = await h.start(); await h.requested;
  const closed = await h.call("close_agent", { target: worker["task_id"] ?? "", force: true });
  assert.equal(closed.outcome, "result");
  release({ resolution: "approved", scope: "session" }); await flush();
  assert.equal(h.effects.length, 0);
  assert.deepEqual(h.grants.entries(), []);
});

test("an owner approval ticket cancels even when its callback answers later", async t => {
  let release!: (answer: PermissionDecision) => void;
  const held = new Promise<PermissionDecision>(resolve => { release = resolve; });
  t.after(() => { release({ resolution: "approved", scope: "once" }); });
  const cancel = new AbortController();
  const permission = createInteractivePermission({ supportsMemberApproval: true, prompt: () => {}, readLine: async () => undefined,
    requestApproval: async () => held });
  const ticket = await permission.request(buildPermissionAction("pending", "write_file", { path: "probe.txt" }), { signal: cancel.signal });
  let settled: PermissionDecision | undefined;
  const pending = permission.awaitDecision(ticket.ticketId).then(answer => { settled = answer; return answer; });
  cancel.abort("member_stopped"); await flush();
  assert.equal(settled?.resolution, "cancelled");
  release({ resolution: "approved", scope: "once" }); await pending;
  assert.equal(settled?.resolution, "cancelled");
});
