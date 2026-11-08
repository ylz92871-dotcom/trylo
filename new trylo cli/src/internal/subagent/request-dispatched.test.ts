import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProviderPort, ProviderRequest } from "../ports/provider.js";
import type { ChildRequestDispatch } from "./request-dispatched.js";
import { buildSubagentPorts } from "../surface/cli/wiring-subagent.js";

const noTools = { snapshot: () => [], execute: async () => ({ outcome: "cancelled" as const }), cancel: async () => {} };
const permission = { request: async () => { throw new Error("No approval expected"); }, awaitDecision: async () => { throw new Error("No approval expected"); } };

test("host child hook receives the actual request and runtime lineage once at the first real acknowledgement", async t => {
  const requests: ProviderRequest[] = [], dispatches: ChildRequestDispatch[] = [];
  const events: { readonly kind: string; readonly payload: Record<string, unknown>; readonly root: string }[] = [];
  const provider: ProviderPort = { async *stream(request) {
    requests.push(request);
    yield { type: "stream_start", providerId: "fixture", model: "fixture", warnings: [] };
    assert.equal(dispatches.length, 0, "adapter setup is not acknowledgement");
    yield { type: "text_start", blockId: "answer" };
    assert.equal(dispatches.length, 1, "the observer runs at the first real response");
    yield { type: "text_delta", blockId: "answer", text: "Visible child answer" };
    yield { type: "text_end", blockId: "answer" };
    yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
  } };
  const built = buildSubagentPorts({ parentTools: noTools, workspaceTools: noTools, childProvider: provider, permission,
    model: "fixture", callerMessages: undefined,
    team: { runId: "team", members: [{ memberId: "worker", baseRole: "worker", displayName: "worker",
      role: { name: "worker", description: "worker", prompt: "PRIVATE_ROLE_TEXT\nEXACT_SKILL_BODY" } }] },
    onChildRequestDispatched: async observation => {
      dispatches.push(observation);
      assert.deepEqual(observation.request, requests[0]);
      assert.equal(observation.request.messages, requests[0]?.messages, "the session wrapper preserves the actual sent message body");
      assert.ok(observation.request.messages.some(message => message.role === "user" && message.content.includes("EXACT_SKILL_BODY")));
      return [{ component: "request_dispatch_contract", requestId: observation.request.attemptId, taskId: observation.taskId }];
    },
    onEvent: (kind, payload, root) => { events.push({ kind, payload, root }); },
  });

  t.after(() => built.runtime.cancelAll());
  const signal = new AbortController().signal;
  const spawn = await built.tools.execute({ name: "spawn_agent", toolCallId: "parent-spawn", arguments: {
    agent_type: "worker", member_id: "worker", message: "Real parent assignment" } }, signal);

  assert.equal(spawn.outcome, "result");
  if (spawn.outcome !== "result") return;

  const taskId = String(spawn.value.task_id), agentId = String(spawn.value.agent_id);

  await built.tools.execute({ name: "wait_agent", toolCallId: "parent-wait", arguments: { targets: [agentId], timeout_ms: 1000 } }, signal);
  assert.equal(requests.length, 1);
  assert.equal(dispatches.length, 1);
  const observed = dispatches[0];
  assert.ok(observed);
  assert.equal(observed.taskId, taskId);
  assert.equal(observed.agentId, agentId);
  assert.equal(observed.round, 1);
  assert.equal(observed.rootAttemptId, "att-root-parent-spawn");
  assert.equal(observed.parentToolCallId, "parent-spawn");
  assert.deepEqual(observed.teamMember, { teamRunId: "team", memberId: "worker" });
  const committed = events.filter(event => event.payload.component === "request_dispatch_contract");
  assert.equal(committed.length, 1);
  assert.equal(committed[0]?.kind, "observation");
  assert.equal(committed[0]?.root, observed.rootAttemptId);
  assert.doesNotMatch(JSON.stringify(committed), /PRIVATE_ROLE_TEXT|EXACT_SKILL_BODY|messages/);
});

test("before-header child failure does not call the host hook or produce its observation", async t => {
  let dispatches = 0;
  const observations: Record<string, unknown>[] = [];
  const provider: ProviderPort = { async *stream() {
    yield { type: "stream_start", providerId: "fixture", model: "fixture", warnings: [] };
    yield { type: "error", class: "network", retryable: false, phase: "before_headers", message: "No remote acknowledgement" };
  } };
  const built = buildSubagentPorts({ parentTools: noTools, workspaceTools: noTools, childProvider: provider, permission,
    model: "fixture", callerMessages: undefined,
    onChildRequestDispatched: async () => {
      dispatches++;
      return [{ component: "must-not-exist" }];
    },
    onEvent: (kind, payload) => { if (kind === "observation") observations.push(payload); } });

  t.after(() => built.runtime.cancelAll());
  const signal = new AbortController().signal;
  const spawn = await built.tools.execute({ name: "spawn_agent", toolCallId: "spawn", arguments: { message: "A bounded task" } }, signal);

  assert.equal(spawn.outcome, "result");
  if (spawn.outcome !== "result") return;

  await built.tools.execute({ name: "wait_agent", toolCallId: "wait", arguments: { targets: [String(spawn.value.agent_id)], timeout_ms: 1000 } }, signal);
  assert.equal(dispatches, 0);
  assert.deepEqual(observations, []);
});
