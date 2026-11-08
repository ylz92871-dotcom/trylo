import assert from "node:assert/strict";
import test from "node:test";
import type { SkillCatalogPort } from "../../ports/skills.js";
import type { ToolBinding } from "../../ports/tools.js";
import { createExpertBuilder } from "./build.js";
import type { ExpertConfiguration, ExpertRequest, ExpertVersion } from "./contracts.js";
import { instantiateExpert } from "./instantiate.js";
import { createToolExpertResources } from "../../adapters/expert-library/resources.js";
import { createProviderExpertSynthesis } from "../../adapters/expert-library/provider.js";
import { createToolLibrary, runtimeToolId } from "../../tooling/library/index.js";
import { createToolLibraryExpertPort } from "../../adapters/expert-library/tool-port.js";

const signal = new AbortController().signal;
const configuration: ExpertConfiguration = { displayName: "Database reviewer", specialty: "SQL index inspection",
  situations: ["Query plan review"], responsibilities: ["Check index plan"], constraints: ["Never mutate data"], collaboration: ["Report evidence"],
  baseRole: "worker", role: { name: "worker", description: "SQL specialist", allowedTools: ["read_file", "run_shell", "web_fetch"] },
  toolRefs: [], methods: [{ title: "Inspect plan", instructions: "Read the query plan before suggesting an index", sourceUris: ["https://docs.example.test/plans"] }],
  sources: [{ kind: "official", title: "Query plans", uri: "https://docs.example.test/plans", excerpt: "Check the plan first." }] };
const request: ExpertRequest = { requestId: "r1", expertId: "e1", experienceKey: "expert:e1", origin: "collaboration",
  instruction: "Create SQL specialist", baseVersion: 0, state: "authorized", revision: 0, createdAt: 1, userEdits: {}, creationAuthorization: "grant1" };
const version: ExpertVersion = { expertId: "e1", experienceKey: "expert:e1", version: 1, configuration, createdAt: 1, requestId: "r1" };
const binding = (name: string): ToolBinding => ({ name, description: name, parameters: {}, needsApproval: true,
  sideEffect: "read_only", timeoutMs: 100, outputLimits: { maxBytes: 1000, maxLines: 100 } });
const dispatch = { expert: version, memberId: "m1", task: "Inspect query plan", runId: "run1", surface: "code" as const,
  catalog: [binding("read_file"), binding("run_shell"), binding("web_fetch")],
  parent: { model: "model1", allowedTools: ["read_file", "web_fetch"], maxIterations: 10 }, signal };

test("builder refuses construction before recorded user consent and rejects invented source evidence", async () => {
  let calls = 0;
  const builder = createExpertBuilder({ resources: { async collect() {
    calls++;
    return { sources: configuration.sources, installedSkills: [], toolNames: [] };
  } },
    synthesize: { async synthesize() { return { ...configuration, sources: [{ ...configuration.sources[0]!, uri: "https://invented.test" }],
      methods: [{ ...configuration.methods[0]!, sourceUris: ["https://invented.test"] }] }; } } });
  const { creationAuthorization: _authorization, ...unapproved } = request;

  await assert.rejects(builder.build({ request: { ...unapproved, state: "awaiting_creation" }, signal }), /authorization/);
  assert.equal(calls, 0);
  await assert.rejects(builder.build({ request, signal }), /not retrieved/);
});

test("builder uses retrieved source provenance rather than a model-rewritten excerpt", async () => {
  const builder = createExpertBuilder({ resources: { async collect() { return { sources: configuration.sources, installedSkills: [], toolNames: [] }; } },
    synthesize: { async synthesize() { return { ...configuration, sources: [{ ...configuration.sources[0]!, excerpt: "invented excerpt" }] }; } } });
  const built = await builder.build({ request, signal });
  assert.deepEqual(built.sources, configuration.sources);
});

test("configuration revision gets only the same expert's scoped experience as ephemeral synthesis guidance", async () => {
  let loads = 0;
  let sawGuidance = false;
  const synthesis = createProviderExpertSynthesis({ model: "m", maxOutputTokens: 600, provider: { async *stream(input) {
    const payload = JSON.parse(input.messages[1]!.content);
    sawGuidance = payload.guidance?.text === "Use cardinality evidence" && payload.guidance.versionIds[0] === "exp:v2";
    assert.deepEqual(payload.userEdits.constraints, ["User constraint takes precedence"]);
    yield { type: "text_delta", blockId: "b", text: JSON.stringify(configuration) };
    yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
  } } });
  const builder = createExpertBuilder({ resources: { async collect() { return { sources: configuration.sources, installedSkills: [], toolNames: [] }; } },
    synthesize: synthesis, experience: { async load(input) {
      loads++;
      assert.deepEqual({ expertId: input.expertId, version: input.version, experienceKey: input.experienceKey, task: input.task, maxChars: input.maxChars },
        { expertId: "e1", version: 1, experienceKey: "expert:e1", task: request.instruction, maxChars: 600 });
      return { text: "Use cardinality evidence", versionIds: ["exp:v2"] };
    } } });
  const built = await builder.build({ request: { ...request, baseVersion: 1, userEdits: { constraints: ["User constraint takes precedence"] } }, previous: configuration, signal });

  assert.equal(loads, 1);
  assert.equal(sawGuidance, true);
  assert.equal("guidance" in built, false);
  assert.equal(JSON.stringify(built).includes("exp:v2"), false);
});

test("dispatch preserves stable expert attribution and intersects tools with role floor and parent allowance", async () => {
  const loads: string[] = [];
  const instance = await instantiateExpert({ ...dispatch, experience: { async load(input) {
    loads.push(`${input.expertId}:${input.experienceKey}:${input.task}`);
    return { text: "Check cardinality estimates", versionIds: ["exp:v1"] };
  } } });

  assert.deepEqual(instance.identity, { expertId: "e1", experienceKey: "expert:e1", version: 1 });
  assert.deepEqual(instance.member.role.allowedTools, ["read_file", "web_fetch"]);
  assert.deepEqual(instance.withheldTools, ["run_shell"]);
  assert.equal(loads.length, 1);
  assert.match(loads[0]!, /^e1:expert:e1:Inspect query plan$/);
  assert.match(instance.member.role.prompt!, /Inspect plan/);
  assert.match(instance.overlay!.systemPromptOverlay, /Never mutate data/);
  const capped = await instantiateExpert({ ...dispatch, expert: { ...version, configuration: { ...configuration,
    role: { ...configuration.role, maxIterations: 2 } } } });

  assert.equal(capped.member.role.maxIterations, 2);
  assert.equal(capped.overlay, undefined, "an incompatible legacy projection must not silently drop the ceiling");
  assert.match(instance.member.role.prompt!, /Check cardinality estimates/);
  assert.deepEqual(instance.experienceVersionIds, ["exp:v1"]);
});

test("dispatch gives experience only the remaining overlay budget after preserving a near-limit professional configuration", async () => {
  const baseline = await instantiateExpert(dispatch);
  const currentConstraintLength = configuration.constraints[0]!.length;
  const constraints = ["x".repeat(1900 - baseline.overlay!.systemPromptOverlay.length + currentConstraintLength)];
  let requestedBudget = 0;
  const instance = await instantiateExpert({ ...dispatch, expert: { ...version, configuration: { ...configuration, constraints } },
    experience: { async load(input) {
      requestedBudget = input.maxChars;
      return { text: "Relevant advice", versionIds: ["exp:v3"] };
    } } });

  assert.ok(requestedBudget > 0 && requestedBudget < 100);
  assert.ok(instance.overlay!.systemPromptOverlay.length <= 2000);
  assert.ok(instance.overlay!.systemPromptOverlay.includes(constraints[0]!));
  assert.deepEqual(instance.experienceVersionIds, ["exp:v3"]);
});

test("unconnected tool references remain pending and are never advertised as configured", async () => {
  const instance = await instantiateExpert({ ...dispatch, expert: { ...version, configuration: { ...configuration, toolRefs: ["runtime:read_file"] } } });
  assert.equal(instance.toolResolutions[0]?.state, "pending");
  assert.deepEqual(instance.overlay!.tools, []);
});

test("real tool library adapter resolves current member scope and excludes explicitly denied tools", async () => {
  const names = ["read_file", "run_shell"];
  const library = createToolLibrary({ sources: [{ id: "runtime", async read() { return { ok: true, value: names.map(name => ({
    id: runtimeToolId(name), name, description: name, capabilities: [], source: { kind: "builtin" as const, label: "runtime" },
    runtimeName: name, availability: { state: "available" as const } })) }; } }],
  async access(context) { assert.equal(context.memberId, "m1");
  return { ok: true, value: { configuredNames: names,
    permission: { isDenied: name => name === "run_shell" }, tools: { snapshot: () => names.map(binding),
      async execute() { throw new Error("Resolution must not execute any tool"); }, async cancel() {} } } }; } });
  const instance = await instantiateExpert({ ...dispatch, expert: { ...version, configuration: { ...configuration,
    toolRefs: names.map(runtimeToolId) } }, tools: createToolLibraryExpertPort(library, { memberId: "m1", scope: "workspace1" }) });

  assert.deepEqual(instance.overlay!.tools, ["read_file"]);
  assert.equal(instance.toolResolutions.find(item => item.ref === "runtime:run_shell")?.state, "unavailable");
});

test("temporary experts require completed consented construction and long overlays fail instead of losing user constraints", async () => {
  const scoped = { ...request, state: "temporary" as const, configuration, useScope: { workspaceId: "ws1", taskId: "t1" } };
  const temporary = await instantiateExpert({ ...dispatch, expert: { request: scoped }, useScope: scoped.useScope });

  assert.equal(temporary.identity.version, 1);
  assert.deepEqual(temporary.identity.draft, { requestId: "r1", revision: 0 });
  await assert.rejects(instantiateExpert({ ...dispatch, expert: { request: scoped }, useScope: { workspaceId: "ws2", taskId: "t1" } }), /authorized workspace and task scope/);
  await assert.rejects(instantiateExpert({ ...dispatch, expert: { request } }), /Temporary use/);
  await assert.rejects(instantiateExpert({ ...dispatch, expert: { ...version, configuration: {
    ...configuration, constraints: ["x".repeat(2200)] } } }), /2000-character/);
});

const skillCatalog = (forkExecution = false): SkillCatalogPort => ({ list() { return []; }, load(name) {
  return { kind: "loaded", skill: { content: "Actual skill instructions", descriptor: { name, description: "SQL skill", source: "user",
    skillRoot: "/skills/sql", path: "/skills/sql/SKILL.md", contentHash: "hash", body: "SQL", userInvocable: true,
    disableModelInvocation: false, forkExecution, allowedTools: ["Read"] } } };
} });

test("selected installed skill text is loaded and narrows tool access; fork and read-only seat skills fail explicitly", async () => {
  const expert = { ...version, configuration: { ...configuration, role: { ...configuration.role, skills: ["sql"] } } };
  const instance = await instantiateExpert({ ...dispatch, expert, skills: skillCatalog() });

  assert.match(instance.member.role.prompt!, /Actual skill instructions/);
  assert.deepEqual(instance.overlay!.tools, ["read_file"]);
  await assert.rejects(instantiateExpert({ ...dispatch, expert, skills: skillCatalog(true) }), /nested fork/);
  const reviewer = { ...expert, configuration: { ...expert.configuration, baseRole: "reviewer" as const,
    role: { ...expert.configuration.role, name: "reviewer" } } };

  await assert.rejects(instantiateExpert({ ...dispatch, expert: reviewer, skills: skillCatalog() }), /only for worker/);
});

test("resource adapter searches and fetches real evidence through the authorized host callback", async () => {
  const calls: string[] = [];
  const resources = createToolExpertResources({ availableToolNames: () => ["web_search", "web_fetch"], officialDomains: ["docs.example.test"],
    async executeAuthorized(call) {
      calls.push(call.name);
      return call.name === "web_search" ? { outcome: "result", value: { sources: [{ url: "https://docs.example.test/plans", title: "Official plans" }] },
        output: "Search answer alone is not specialist evidence", truncated: false } : { outcome: "result",
        value: { url: "https://docs.example.test/plans", status: 200 }, output: "Fetched method: inspect actual cardinality.", truncated: false };
    } });
  const collected = await resources.collect({ request, signal });

  assert.deepEqual(calls, ["web_search", "web_fetch"]);
  assert.equal(collected.sources[0]?.kind, "official");
  assert.match(collected.sources[0]!.excerpt, /Fetched method/);
  const unavailable = createToolExpertResources({ availableToolNames: () => ["web_search"], async executeAuthorized() {
    return { outcome: "error", code: "denied", message: "user refused web" };
  } });

  await assert.rejects(unavailable.collect({ request, signal }), /denied/);
});

test("provider synthesis respects host budget and refuses partial or tool-calling responses", async () => {
  let quota = 0;
  const synth = createProviderExpertSynthesis({ model: "m", maxOutputTokens: 600, provider: { async *stream(input) {
    quota = input.maxOutputTokens!;
    assert.deepEqual(input.tools, []);
    yield { type: "text_delta", blockId: "b", text: JSON.stringify(configuration) };
    yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
  } } });
  const result = await synth.synthesize({ request, resources: { sources: configuration.sources, installedSkills: [], toolNames: [] }, signal });

  assert.equal(quota, 600);
  assert.deepEqual(result, configuration);
  const incomplete = createProviderExpertSynthesis({ model: "m", maxOutputTokens: 600, provider: { async *stream() {
    yield { type: "text_delta", blockId: "b", text: "{}" };
    yield { type: "finish", reason: "length", rawReason: "length", requiresFollowUp: false };
  } } });

  await assert.rejects(incomplete.synthesize({ request, resources: { sources: [], installedSkills: [], toolNames: [] }, signal }), /complete configuration/);
  const unexpectedTool = createProviderExpertSynthesis({ model: "m", maxOutputTokens: 600, provider: { async *stream() {
    yield { type: "tool_call", toolCallId: "c1", name: "write_file", arguments: {} };
  } } });

  await assert.rejects(unexpectedTool.synthesize({ request, resources: { sources: [], installedSkills: [], toolNames: [] }, signal }), /model-selected tools/);
});
