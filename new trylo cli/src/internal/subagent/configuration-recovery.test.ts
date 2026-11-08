import assert from "node:assert/strict";
import test from "node:test";
import type { JsonObject, JsonValue } from "../protocol/envelope.js";
import type { ProviderPort, ProviderRequest } from "../ports/provider.js";
import type { SessionRecord } from "../ports/session.js";
import type { ToolBinding } from "../ports/tools.js";
import { createSubagentCheckpointJournal } from "../adapters/subagent-checkpoints/journal.js";
import { isSubagentCheckpoint } from "./checkpoint.js";
import { createSubagentControlTool } from "./control-tools.js";
import type { SubagentMemberConfigurationPort } from "./member-configuration.js";
import { SubagentRuntime } from "./runtime.js";

const permission = { request: async () => { throw new Error("unexpected approval"); }, awaitDecision: async () => { throw new Error("unexpected approval"); } };
const object = (value: JsonValue | undefined): value is JsonObject => !!value && typeof value === "object" && !Array.isArray(value);
const handoff = { scope: "Continue checked work", artifacts: ["artifact.txt"], evidence: ["check:local"], pending: ["verify next result"], blockers: [] };
const binding = (name: string): ToolBinding => ({ name, description: name, parameters: { type: "object" }, sideEffect: "read_only",
  needsApproval: false, timeoutMs: 1000, outputLimits: { maxBytes: 1024, maxLines: 10 } });
const team = { runId: "frozen-team", profileId: "profile", members: [{ memberId: "worker", baseRole: "worker", displayName: "worker",
  role: { name: "worker", description: "base role", disallowedTools: ["admin"] } }] };

type Resolve = SubagentMemberConfigurationPort["resolve"];

const ready: Resolve = async input => ({ kind: "ready", configurationVersion: input.configurationRef, profileId: "profile",
  identity: { expertId: "expert", version: 1, experienceKey: "expert-experience" }, experienceVersionIds: ["experience-v1"],
  expertAdoption: { runId: "frozen-team", memberId: "worker", boundary: input.boundary,
    identity: { expertId: "expert", version: 1, experienceKey: "expert-experience" }, experienceVersionIds: ["experience-v1"], toolResolutions: [] },
  role: { name: "worker", description: "expert role", prompt: `EXPERT_${input.configurationRef}`, model: "fixed-model", allowedTools: ["read_file", "write_file"] },
  dispatchTools: { snapshot: () => [binding("read_file")], execute: async () => ({ outcome: "cancelled" }), cancel: async () => {} } });

function harness(records: SessionRecord[], generation: string, resolve: Resolve = ready, allowedTools = ["read_file", "write_file"]) {
  let sequence = records.length, ids = 0, calls = 0;
  const requests: ProviderRequest[] = [], resolutions: Parameters<Resolve>[0][] = [];
  const checkpoints = createSubagentCheckpointJournal(records, "session", async payload => {
    records.push({ formatVersion: "1", sequence: ++sequence, sessionId: "session", type: "envelope", at: "2026-11-03T00:00:00Z",
      payload: { envelope: { kind: "observation", payload } } });
  });
  const provider: ProviderPort = { async *stream(request) {
    requests.push(request);
    yield { type: "text_start", blockId: "answer" };
    yield { type: "text_delta", blockId: "answer", text: `answer-${generation}` };
    yield { type: "text_end", blockId: "answer" };
    yield { type: "usage", usage: { mode: "snapshot", inputTokens: 10, outputTokens: 2, totalTokens: 12, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } };
    yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
  } };
  const runtime = new SubagentRuntime({ idGenerator: () => `${generation}-${++ids}`, tools: { snapshot: () => [binding("read_file"), binding("write_file")],
    execute: async () => ({ outcome: "cancelled" }), cancel: async () => {} } });
  const tools = createSubagentControlTool({ runtime, provider, permission, checkpoints, team, teamProfileId: "profile", model: "fixed-model", allowedTools,
    parentMessages: [{ role: "user", content: "PARENT_CONTEXT" }, { role: "assistant", content: "parent answer" }],
    memberConfigurations: { async resolve(input) {
      resolutions.push(input);
      return resolve(input);
    } } });

  return { runtime, requests, resolutions, checkpoints, call: (name: string, args: JsonObject) => tools.execute({ name, arguments: args,
    toolCallId: `call-${generation}-${++calls}` }, new AbortController().signal) };
}

async function roundReady(h: ReturnType<typeof harness>, boundary: "composition" | "handoff" = "composition") {
  const spawned = await h.call("spawn_agent", { member_id: "worker", agent_type: "worker", configuration_ref: "expert:1", message: "assigned work", fork_context: true });

  assert.equal(spawned.outcome, "result");
  if (spawned.outcome !== "result") throw new Error("spawn failed");

  const task = String(spawned.value.task_id);

  await h.call("wait_agent", { targets: [task], timeout_ms: 1000, release_on_ready: true });

  if (boundary === "handoff") {
    const changed = await h.call("reconfigure_agent", { target: task, configuration_ref: "expert:2", message: "continue work", handoff });
    assert.equal(changed.outcome, "result");
    await h.call("wait_agent", { targets: [task], timeout_ms: 1000, release_on_ready: true });
  }

  const saved = h.checkpoints.read(task);

  assert.equal(saved.kind, "ready");
  if (saved.kind !== "ready") throw new Error("missing checkpoint");

  assert.equal(saved.checkpoint.phase, "round_ready");

  return task;
}

for (const boundary of ["composition", "handoff"] as const) {
  test(`a configured expert cold-resumes the exact ${boundary} image with newly admitted bindings and current tool ceilings`, async t => {
    const records: SessionRecord[] = [];
    const old = harness(records, "old");
    t.after(() => old.runtime.cancelAll());
    const task = await roundReady(old, boundary);
    const next = harness(structuredClone(records), "new", ready, boundary === "handoff" ? ["read_file"] : ["read_file", "write_file"]);
    t.after(() => next.runtime.cancelAll());
    const resumed = await next.call("resume_agent", { target: task, message: "inspect the previous artifact and continue" });

    assert.equal(resumed.outcome, "result");
    const receipt = resumed.outcome === "result" ? resumed.value.configuration : undefined;

    assert.ok(object(receipt), "cold resume must identify the actual admitted expert configuration");
    assert.equal(receipt.configuration_version, boundary === "composition" ? "expert:1" : "expert:2");
    await next.call("wait_agent", { targets: [task], timeout_ms: 1000, release_on_ready: true });
    assert.equal(next.resolutions.length, 1);
    assert.equal(next.resolutions[0]?.boundary, boundary);
    assert.equal(next.requests.length, 1);
    assert.match(JSON.stringify(next.requests[0]?.messages), boundary === "composition" ? /answer-old/ : /EXPERT_expert:2/);
    assert.equal(next.requests[0]?.messages.some(message => message.content === "PARENT_CONTEXT"), boundary === "composition");
    const advertised = next.requests[0]?.tools.map(tool => tool.name) ?? [];

    assert.ok(advertised.includes("read_file"));
    assert.equal(advertised.includes("write_file"), false, "current binding selection and parent revocation must both narrow recovery");
    assert.equal(advertised.includes("admin"), false);
    assert.ok(advertised.includes("report_progress"), "the child's existing local reporting tool remains available");
    const saved = next.checkpoints.read(task);
    assert.equal(saved.kind, "ready");
    if (saved.kind !== "ready") return;

    assert.equal(saved.checkpoint.configuration?.configurationVersion, boundary === "composition" ? "expert:1" : "expert:2");
    assert.equal(JSON.stringify(saved.checkpoint.configuration).includes("dispatchTools"), false);
    assert.equal(JSON.stringify(saved.checkpoint.configuration).includes("toolResolutions"), false);
    assert.equal(isSubagentCheckpoint({ ...saved.checkpoint, configuration: { ...saved.checkpoint.configuration, dispatchTools: {} } }), false);
    assert.equal(isSubagentCheckpoint({ ...saved.checkpoint, configuration: { ...saved.checkpoint.configuration,
      expertAdoption: { ...saved.checkpoint.configuration?.expertAdoption, toolResolutions: [] } } }), false);
  });
}

const refused: readonly { name: string; resolve: Resolve }[] = [
  { name: "missing reference", resolve: async () => ({ kind: "unavailable", reason: "configuration_reference_unknown" }) },
  { name: "configuration drift", resolve: async input => {
    const value = await ready(input);
    return value.kind === "ready" ? { ...value, configurationVersion: "changed" } : value;
  } },
  { name: "experience drift", resolve: async input => { const value = await ready(input);
  return value.kind === "ready" ? { ...value, experienceVersionIds: ["experience-v2"],
    ...(value.expertAdoption === undefined ? {} : { expertAdoption: { ...value.expertAdoption, experienceVersionIds: ["experience-v2"] } }) } : value; } },
  { name: "temporary scope unavailable", resolve: async () => ({ kind: "unavailable", reason: "Temporary expert use is restricted to its authorized workspace and task scope" }) },
];

for (const scenario of refused) {
  test(`configured cold recovery refuses ${scenario.name} before any provider request`, async t => {
    const records: SessionRecord[] = [];
    const old = harness(records, "old");
    t.after(() => old.runtime.cancelAll());
    const task = await roundReady(old);
    const next = harness(structuredClone(records), "new", scenario.resolve);
    t.after(() => next.runtime.cancelAll());
    const result = await next.call("resume_agent", { target: task, message: "continue" });
    assert.equal(result.outcome, "error");
    if (result.outcome === "error") assert.match(result.code, /^agent_recovery_configuration_/);
    assert.equal(next.resolutions.length, 1);
    assert.equal(next.requests.length, 0);
  });
}
