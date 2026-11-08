import assert from "node:assert/strict";
import { test } from "node:test";
import type { JsonObject } from "../protocol/envelope.js";
import type { ProviderPort, ProviderRequest } from "../ports/provider.js";
import type { SubagentCollaborationPort, CollaborationRound } from "./collaboration.js";
import { createSubagentControlTool } from "./control-tools.js";
import { SubagentRuntime } from "./runtime.js";

const permission = { request: async () => { throw new Error("unexpected approval"); },
  awaitDecision: async () => { throw new Error("unexpected approval"); } };
const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

function harness(collaboration: SubagentCollaborationPort, provider: ProviderPort) {
  const runtime = new SubagentRuntime({ tools: { snapshot: () => [], execute: async () => ({ outcome: "cancelled" }), cancel: async () => {} } });
  const tools = createSubagentControlTool({ runtime, provider, permission, collaboration,
    team: { runId: "frozen-team", members: ["architect", "verifier"].map(role => ({ memberId: role, baseRole: role,
      displayName: role, role: { name: role, description: role } })) } });
  let sequence = 0;
  const call = (name: string, args: JsonObject) => tools.execute({ name, arguments: args,
    toolCallId: `call-${++sequence}` }, new AbortController().signal);
  const spawn = async (role: string, dependsOn: readonly string[] = []) => {
    const result = await call("spawn_agent", { message: `assigned ${role}`, member_id: role,
      agent_type: role, depends_on: [...dependsOn] });
    assert.equal(result.outcome, "result");
    return result.outcome === "result" ? String(result.value["task_id"]) : "";
  };
  const wait = (id: string) => call("wait_agent", { targets: [id], timeout_ms: 1000 });

  return { runtime, call, spawn, wait };
}

test("collaboration advice reaches the actual member request with canonical handoff, without extra tools or lasting prompt text", async t => {
  const requests: ProviderRequest[] = [], rounds: CollaborationRound[] = [], sent: string[] = [];
  let completed = 0;
  const provider: ProviderPort = { async *stream(request) {
    requests.push(request);
    yield { type: "text_start", blockId: "a" };
    yield { type: "text_delta", blockId: "a", text: "actual output" };
    yield { type: "text_end", blockId: "a" };
    yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
  } };
  const advice = "BOUNDED_COLLABORATION_ADVICE";
  const collaboration: SubagentCollaborationPort = {
    async prepare(round) {
      rounds.push(round);
      return round.round === 2 ? advice : undefined;
    },
    async dispatched(_round, requestId, guidance) {
      if (guidance !== undefined) {
        assert.ok(requests.some(request => request.messages.some(message => message.content === advice)), "provider must acknowledge the actual advice request before its receipt");
        sent.push(requestId);
      }
    },
    async completed() { completed += 1; }, async ended() {},
  };
  const h = harness(collaboration, provider);
  t.after(() => h.runtime.cancelAll());
  const id = await h.spawn("architect");
  await h.wait(id);
  const handoff = { scope: "verify conversion", artifacts: ["conversion.json"], evidence: ["check:baseline"], pending: ["unit check"], blockers: [] };

  await h.call("send_input", { target: id, message: "follow-up", handoff });
  await h.wait(id);
  assert.equal(rounds[1]?.teamRunId, "frozen-team");
  assert.deepEqual(rounds[1]?.handoff, handoff);
  assert.ok(requests[1]?.messages.some(message => message.role === "system" && message.content === advice));
  assert.equal(sent.length, 1);
  assert.equal(completed, 2);
  assert.deepEqual(requests[1]?.tools.map(tool => tool.name), ["report_progress"]);
  await h.call("send_input", { target: id, message: "later independent instruction" });
  await h.wait(id);
  assert.ok(!requests[2]?.messages.some(message => message.content === advice), "round-local advice must leave the next request");
  const prerequisite = await h.spawn("verifier");
  await h.wait(prerequisite);
  await h.call("send_input", { target: id, message: "new declared dependent work", depends_on: [prerequisite] });
  await h.wait(id);
  assert.deepEqual(rounds.at(-1)?.dependencies, [prerequisite], "later input prerequisites must reach the actual round");
  assert.equal(rounds.at(-1)?.handoff, undefined);
});

test("runtime supplies canonical failed/cancelled terminals to the optional observer", async t => {
  const ended: string[] = [];
  const identities: Parameters<SubagentCollaborationPort["ended"]>[0][] = [], preparedExecutions = new Map<string, string>();
  let dispatches = 0;
  const provider: ProviderPort = { async *stream(request, signal) {
    if (request.messages.some(message => message.content === "assigned verifier")) await new Promise<void>(resolve => {
      if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true });
    });
    throw new Error("provider_unavailable");
  } };
  const collaboration: SubagentCollaborationPort = { prepare: async round => {
    assert.ok(round.executionId);
    preparedExecutions.set(round.memberId, round.executionId);
    return undefined;
  }, dispatched: async () => { dispatches += 1; },
    completed: async () => { throw new Error("failure cannot publish completion"); },
    ended: async (identity, status) => {
      identities.push(identity);
      ended.push(status);
    } };
  const h = harness(collaboration, provider);
  t.after(() => h.runtime.cancelAll());
  const id = await h.spawn("architect");
  await h.wait(id);
  await flush();
  assert.deepEqual(ended, ["failed"]);
  assert.equal(identities[0]?.executionId, preparedExecutions.get("architect"));
  const cancelled = await h.spawn("verifier");
  await flush();
  await h.call("close_agent", { target: cancelled, force: true });
  await flush();
  assert.deepEqual(ended, ["failed", "cancelled"]);
  assert.equal(identities[1]?.executionId, preparedExecutions.get("verifier"));
  assert.equal(dispatches, 0, "before-header failures and aborted pending streams have no adoption receipt");
});
