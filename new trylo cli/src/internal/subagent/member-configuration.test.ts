import assert from "node:assert/strict";
import test from "node:test";
import type { JsonObject } from "../protocol/envelope.js";
import type { ProviderMessage, ProviderPort, ProviderRequest } from "../ports/provider.js";
import type { SubagentRoutingDispatch, SubagentRoutingPort } from "../ports/subagent-routing.js";
import type { SubagentCollaborationPort } from "./collaboration.js";
import type { SubagentMemberConfigurationPort } from "./member-configuration.js";
import { createSubagentControlTool } from "./control-tools.js";
import { SubagentRuntime } from "./runtime.js";

const permission = { request: async () => { throw new Error("unexpected approval"); }, awaitDecision: async () => { throw new Error("unexpected approval"); } };
const handoff = { scope: "Continue the verified artifact transformation", artifacts: ["artifact.json"], evidence: ["check:current"], pending: ["review next transform"], blockers: [] };
const ready: SubagentMemberConfigurationPort["resolve"] = async input => {
  const version = input.configurationRef.endsWith("2") ? 2 : 1;
  return { kind: "ready", configurationVersion: `configuration:${version}`, profileId: "profile:one",
    identity: { expertId: `expert:${input.baseRole}`, version, experienceKey: `experience:${input.baseRole}` }, experienceVersionIds: [`experience-version:${version}`],
    role: { name: input.baseRole, description: "A specialized existing seat", model: `expert-model-${version}`,
      prompt: `EXPERT_INSTRUCTION_${version}`, allowedTools: ["read_file", "write_file", "web_fetch", "unavailable_admin"] } };
};

test("an explicit role iteration allowance can exceed the former 1000 ceiling", async t => {
  let calls = 0;
  const provider: ProviderPort = { async *stream() {
    calls++;
    yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
  } };
  const h = fixture(provider, async input => {
    const resolved = await ready(input);
    return resolved.kind !== "ready" ? resolved : { ...resolved, role: { ...resolved.role, maxIterations: 1001 } };
  });

  t.after(() => h.runtime.cancelAll());
  const spawned = await result(h, "spawn_agent", { member_id: "worker", agent_type: "worker", message: "complete the task", configuration_ref: "expert:1" });

  await result(h, "wait_agent", { targets: [String(spawned.task_id)], timeout_ms: 1000 });
  assert.equal(calls, 1);
});

function fixture(provider: ProviderPort, resolve: SubagentMemberConfigurationPort["resolve"] = ready,
  extra: { collaboration?: SubagentCollaborationPort; taskResources?: { stop(taskId: string): Promise<void> };
    routing?: SubagentRoutingPort; parentMessages?: readonly ProviderMessage[] } = {}) {
  let seq = 0;
  const runtime = new SubagentRuntime({ idGenerator: () => `execution-${++seq}`, tools: { snapshot: () => [], execute: async () => ({ outcome: "cancelled" }), cancel: async () => {} } });
  const tools = createSubagentControlTool({ runtime, provider, permission, ...extra, teamProfileId: "profile:one", memberConfigurations: { resolve },
    allowedTools: ["read_file", "write_file", "web_fetch"], team: { runId: "team:one", members: ["worker", "reviewer"].map(baseRole => ({
      memberId: baseRole, baseRole, displayName: baseRole, role: { name: baseRole, description: baseRole, model: "legacy-model", disallowedTools: ["write_file"] } })) } });
  return { runtime, call: (name: string, args: JsonObject) => tools.execute({ name, arguments: args, toolCallId: `call-${++seq}` }, new AbortController().signal) };
}

function providerFixture(before?: (request: ProviderRequest, signal: AbortSignal) => Promise<void>) {
  const requests: { fork: number; request: ProviderRequest }[] = [];
  let forks = 0;
  const provider: ProviderPort = { fork() { const fork = ++forks;
  return { async *stream(request, signal) {
    requests.push({ fork, request });
    await before?.(request, signal);
    if (signal.aborted) return;
    yield { type: "text_start", blockId: "answer" };
    yield { type: "text_delta", blockId: "answer", text: "delivered artifact" };
    yield { type: "text_end", blockId: "answer" };
    yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
  } }; }, async *stream() { throw new Error("only an isolated child fork may execute"); } };

  return { provider, requests, forks: () => forks };
}

async function result(h: ReturnType<typeof fixture>, name: string, args: JsonObject) {
  const value = await h.call(name, args);
  assert.equal(value.outcome, "result");
  if (value.outcome !== "result") throw new Error("missing control result");
  return value.value;
}

test("a configured expert is really dispatched after handoff with fresh context and exact version receipts; normal continuation preserves it", async t => {
  const p = providerFixture();
  const dispatched: string[] = [];
  const collaboration: SubagentCollaborationPort = { prepare: async () => undefined, async dispatched(round) {
    if (round.configuration) dispatched.push(round.configuration.configurationVersion);
  }, completed: async () => {}, ended: async () => {} };
  const h = fixture(p.provider, ready, { collaboration });
  t.after(() => h.runtime.cancelAll());
  const first = await result(h, "spawn_agent", { member_id: "worker", agent_type: "worker", message: "first assignment", configuration_ref: "expert:1" });
  const task = String(first.task_id);
  await result(h, "wait_agent", { targets: [task], timeout_ms: 1000 });
  assert.deepEqual(first.allowed_tools, ["read_file", "web_fetch"]);
  assert.equal((first.configuration as JsonObject).configuration_version, "configuration:1");
  const next = await result(h, "reconfigure_agent", { target: task, configuration_ref: "expert:2", message: "next assignment", handoff });

  assert.equal(next.status, "configured");
  assert.equal(next.task_id, task);
  assert.notEqual(next.agent_id, first.agent_id);
  await result(h, "wait_agent", { targets: [task], timeout_ms: 1000 });
  assert.equal(p.forks(), 2);
  assert.equal(p.requests[1]?.request.model, "expert-model-2");
  const nextText = JSON.stringify(p.requests[1]?.request.messages);

  assert.match(nextText, /EXPERT_INSTRUCTION_2/);
  assert.doesNotMatch(nextText, /EXPERT_INSTRUCTION_1/);
  assert.match(nextText, /artifact\.json/);
  assert.deepEqual(dispatched, ["configuration:1", "configuration:2"]);
  await result(h, "send_input", { target: task, message: "ordinary follow-up" });
  const observed = await result(h, "wait_agent", { targets: [task], timeout_ms: 1000, release_on_ready: true });

  assert.match(JSON.stringify(observed), /configuration:2/);
  await result(h, "resume_agent", { target: task, message: "resume the same configuration" });
  await result(h, "wait_agent", { targets: [task], timeout_ms: 1000 });
  assert.equal(p.forks(), 2, "send_input and resume_agent must not silently install another configuration");
  assert.equal(p.requests.at(-1)?.request.model, "expert-model-2");
});

test("expert reconfiguration clears the previous fork receipt when the actual dispatch starts with fresh context", async t => {
  const p = providerFixture();
  const dispatched: SubagentRoutingDispatch[] = [];
  const h = fixture(p.provider, ready, { parentMessages: [{ role: "user", content: "PARENT_CONTEXT_SENTINEL" },
    { role: "assistant", content: "parent answer" }], routing: {
    choose: async () => ({ path: "fork", reason: "host_selection", candidateIds: ["independent", "fork"], versionId: "host-choice-v1" }),
    dispatched: async receipt => { dispatched.push(receipt); }, finished: async () => {},
  } });

  t.after(() => h.runtime.cancelAll());
  const first = await result(h, "spawn_agent", { member_id: "worker", agent_type: "worker", message: "first assignment",
    configuration_ref: "expert:1", fork_context: true });
  const task = String(first.task_id);

  await result(h, "wait_agent", { targets: [task], timeout_ms: 1000, release_on_ready: true });
  assert.match(JSON.stringify(p.requests[0]?.request.messages), /PARENT_CONTEXT_SENTINEL/);
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0]?.actualPath, "fork");
  assert.equal(dispatched[0]?.selectionExecutionId, dispatched[0]?.executionId);
  const next = await result(h, "reconfigure_agent", { target: task, configuration_ref: "expert:2", message: "next assignment", handoff });

  assert.equal(next.status, "configured");
  await result(h, "wait_agent", { targets: [task], timeout_ms: 1000, release_on_ready: true });
  assert.equal(p.requests.length, 2);
  assert.doesNotMatch(JSON.stringify(p.requests[1]?.request.messages), /PARENT_CONTEXT_SENTINEL|EXPERT_INSTRUCTION_1/);
  assert.match(JSON.stringify(p.requests[1]?.request.messages), /EXPERT_INSTRUCTION_2/);
  assert.equal(dispatched.length, 1, "a new configuration must not publish the earlier fork as its actual dispatch");
});

test("busy and queued rounds wait for handoff, and an unavailable configuration leaves the old member usable", async t => {
  let releaseFirst = () => {}, releaseSecond = () => {}, enteredFirst = () => {}, enteredSecond = () => {};
  const first = new Promise<void>(r => { releaseFirst = r; }), second = new Promise<void>(r => { releaseSecond = r; });
  const firstEntered = new Promise<void>(r => { enteredFirst = r; }), secondEntered = new Promise<void>(r => { enteredSecond = r; });
  let call = 0, resolutions = 0, unavailable = false;
  const p = providerFixture(async (_request, signal) => {
    call += 1;
    if (call > 2) return;
    const aborted = new Promise<void>(resolve => { if (signal.aborted) resolve();else signal.addEventListener("abort", () => resolve(), { once: true }); });
    if (call === 1) {
      enteredFirst();
      await Promise.race([first, aborted]);
    } else {
      enteredSecond();
      await Promise.race([second, aborted]);
    }
  });
  const h = fixture(p.provider, async input => {
    resolutions += 1;
    return unavailable ? { kind: "unavailable", reason: "real_library_pending" } : ready(input);
  });

  t.after(async () => {
    releaseFirst();
    releaseSecond();
    await h.runtime.cancelAll();
  });
  const started = await result(h, "spawn_agent", { member_id: "worker", agent_type: "worker", message: "old assignment" });
  const task = String(started.task_id);

  await firstEntered;
  const busy = await result(h, "reconfigure_agent", { target: task, configuration_ref: "expert:2", message: "new assignment", handoff });

  assert.equal(busy.reason, "waiting_handoff");
  assert.equal(resolutions, 0);
  assert.equal(p.forks(), 1);
  await result(h, "send_input", { target: task, message: "already queued work" });
  releaseFirst();
  await secondEntered;
  const queued = await result(h, "reconfigure_agent", { target: task, configuration_ref: "expert:2", message: "new assignment", handoff });

  assert.equal(queued.reason, "waiting_handoff");
  assert.equal(resolutions, 0);
  releaseSecond();
  await result(h, "wait_agent", { targets: [task], timeout_ms: 1000 });
  unavailable = true;
  const waiting = await result(h, "reconfigure_agent", { target: task, configuration_ref: "expert:2", message: "new assignment", handoff });

  assert.equal(waiting.status, "unavailable");
  assert.equal(p.forks(), 1);
  await result(h, "send_input", { target: task, message: "continue using the original configuration" });
  await result(h, "wait_agent", { targets: [task], timeout_ms: 1000 });
  assert.equal(p.requests.at(-1)?.request.model, "legacy-model");
});

test("failed task resource retirement cannot be reported as a configuration change and remains explicitly retryable", async t => {
  const p = providerFixture();
  let stops = 0;
  const h = fixture(p.provider, ready, { taskResources: { async stop() {
    stops += 1;
    if (stops === 1) throw new Error("owned operation still running");
  } } });

  t.after(() => h.runtime.cancelAll());
  const first = await result(h, "spawn_agent", { member_id: "worker", agent_type: "worker", message: "old assignment" });
  const task = String(first.task_id);

  await result(h, "wait_agent", { targets: [task], timeout_ms: 1000 });
  const rejected = await h.call("reconfigure_agent", { target: task, configuration_ref: "expert:2", message: "new assignment", handoff });

  assert.equal(rejected.outcome, "error");
  if (rejected.outcome === "error") assert.equal(rejected.code, "agent_cleanup_failed");

  assert.equal(p.forks(), 1);
  const retried = await result(h, "reconfigure_agent", { target: task, configuration_ref: "expert:2", message: "new assignment", handoff });

  assert.equal(retried.status, "configured");
  assert.equal(stops, 2);
  assert.equal(p.forks(), 2);
});

test("an unavailable or mismatched expert cannot create a fake instance or replace the base-role floor", async t => {
  const p = providerFixture();
  let unavailable = true;
  const h = fixture(p.provider, async input => {
    if (unavailable) return { kind: "waiting", reason: "creation_approval_pending" };
    const valid = await ready(input);
    if (valid.kind !== "ready") return valid;
    return { ...valid, role: { name: "worker", description: "wrong authority role", allowedTools: ["write_file"] } };
  });

  t.after(() => h.runtime.cancelAll());
  const waiting = await result(h, "spawn_agent", { member_id: "reviewer", agent_type: "reviewer", message: "inspect", configuration_ref: "expert:1" });

  assert.equal(waiting.status, "waiting");
  assert.equal(waiting.agent_id, undefined);
  assert.equal(p.forks(), 0);
  unavailable = false;
  const invalid = await h.call("spawn_agent", { member_id: "reviewer", agent_type: "reviewer", message: "inspect", configuration_ref: "expert:1" });

  assert.equal(invalid.outcome, "error");
  if (invalid.outcome === "error") assert.equal(invalid.code, "member_configuration_invalid");

  assert.equal(p.forks(), 0);
});
