import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ExpertLibrary, type ExpertConfiguration } from "../../subagent/experts/index.js";
import { createFileExpertStore, createPermissionExpertAuthorization } from "../../adapters/expert-library/index.js";
import { createAllowToolsPermission } from "./permission.js";
import { createSubagentControlTool } from "../../subagent/control-tools.js";
import { SubagentRuntime } from "../../subagent/runtime.js";
import type { SubagentTeam } from "../../subagent/team.js";
import type { ProviderPort, ProviderRequest } from "../../ports/provider.js";
import type { ToolBinding, ToolPort } from "../../ports/tools.js";
import type { JsonObject } from "../../protocol/envelope.js";
import { createToolLibrary, runtimeToolId } from "../../tooling/library/index.js";
import { createCollaborationExecution } from "./collaboration-execution.js";
import type { CollaborationCapabilities } from "./collaboration-capabilities.js";
import { emptyBoardState } from "../../learning/control/state.js";
import { reduce } from "../../learning/control/reducer.js";
import { createCollaborationControl } from "../../learning/agent/subsystems/collaboration/control/index.js";
import { createCollaborationExperienceStore } from "../../learning/agent/subsystems/collaboration/experience/index.js";
import type { CollaborationRuntimeReceipt } from "../../protocol/collaboration-resource.js";

const now = () => "2026-11-03T12:00:00.000Z";
const unexpected = async (): Promise<never> => { throw new Error("This local executor test must not invoke a builder provider, business tool, or network"); };
const binding: ToolBinding = { name: "read_file", description: "Read", parameters: {}, sideEffect: "read_only", needsApproval: false,
  timeoutMs: 100, outputLimits: { maxBytes: 1000, maxLines: 100 } };
const bindings: readonly ToolBinding[] = [binding, ...["web_fetch", "run_shell"].map(name => ({ ...binding, name, sideEffect: "external" as const, needsApproval: true }))];
const methods = (name: string): ExpertConfiguration => ({ displayName: name, specialty: name, baseRole: "worker", situations: ["Inspection"],
  responsibilities: [name], constraints: ["Preserve original data"], collaboration: ["Report evidence"],
  role: { name: "worker", description: name, model: name === "CONFLICT" ? "another-model" : "local-model", allowedTools: bindings.map(tool => tool.name),
    disallowedTools: name === "FIRST" ? ["web_fetch"] : [], maxIterations: 5 },
  toolRefs: bindings.map(tool => runtimeToolId(tool.name)), sources: [{ kind: "user", title: "Local policy", uri: "user:policy", excerpt: "Use actual evidence" }],
  methods: [{ title: name, instructions: `METHOD_${name}`, sourceUris: ["user:policy"] }] });

test("the selected library expert enters the original executor provider request with official adoption and isolated handoff guidance (local provider only)", async t => {
  const root = mkdtempSync(path.join(tmpdir(), "trylo-expert-dispatch-"));

  t.after(() => {
    assert.equal(path.dirname(root), tmpdir());
    assert.match(path.basename(root), /^trylo-expert-dispatch-/);
    rmSync(root, { recursive: true, force: true });
  });
  const permission = createAllowToolsPermission(new Set(["expert_library.create", "expert_library.retain", ...bindings.map(tool => tool.name)]));
  const library = new ExpertLibrary({ store: createFileExpertStore(root), authorization: createPermissionExpertAuthorization({ permission }),
    builder: { async build(input) { return methods(input.request.instruction); } } });
  const seed = async (name: string) => { const request = await library.submitRequest({ origin: "settings", instruction: name });
    await library.build(request.requestId);
  await library.retain(request.requestId, { kind: "save" });
  return library.get(request.expertId)!; };
  const firstExpert = await seed("FIRST"), secondExpert = await seed("SECOND"), conflictExpert = await seed("CONFLICT");
  const team: SubagentTeam = { runId: "team-real-dispatch", profileId: "profile-real", surface: "code", members: [{ memberId: "member-real", baseRole: "worker",
    displayName: "Existing worker", expert: { expertId: firstExpert.expertId }, role: { name: "worker", description: "Existing worker", model: "local-model",
      prompt: "ORIGINAL_GUIDANCE\nENGINEERING_CONTRACT\nEXISTING_USER_CONSTRAINT", allowedTools: bindings.map(tool => tool.name), disallowedTools: ["run_shell"], maxIterations: 2 } }] };
  const workspaceTools: ToolPort = { snapshot: () => bindings, execute: unexpected, cancel: async () => {} };
  const toolLibrary = createToolLibrary({ sources: [{ id: "actual-runtime", async read() { return { ok: true, value: bindings.map(tool => ({ id: runtimeToolId(tool.name),
    runtimeName: tool.name, name: tool.name, description: tool.description, capabilities: [], source: { kind: "builtin" as const, label: "runtime" }, availability: { state: "available" as const } })) }; } }],
    async access() { return { ok: true, value: { tools: workspaceTools, configuredNames: bindings.map(tool => tool.name), permission } }; } });
  const capabilities: CollaborationCapabilities = { toolLibrary, expertHost: { library, execute: unexpected, executeUserAction: unexpected, instantiate: unexpected },
    configuredTools: workspaceTools, executeAuthorized: unexpected, executeTool: unexpected, buildExpert: unexpected };
  let state = emptyBoardState();
  const receipts: CollaborationRuntimeReceipt[] = [];
  const board = { async load() { return { ok: true as const, state, generation: 0 }; }, async apply(command: Parameters<typeof reduce>[1]) {
    const result = reduce(state, command);
    if (result.ok) state = result.state;
    return result;
  } };
  const control = createCollaborationControl({ board, now, ownerId: "local-fixture" });
  const report = await control.report({ scope: "workspace-real", problemKey: "handoff", report: { reportId: "report-real", source: { teamRunId: team.runId, memberId: "member-real", taskId: "task-real" }, facts: ["Keep units"], evidenceRefs: [] } });
  assert.ok(report.ok);
  const focus = await control.decide({ issueId: report.issue.issueId, expectedRevision: report.issue.revision, decision: "focused_learning", reason: "Fix handoff", sourceRefs: ["report-real"] });
  assert.ok(focus.ok);
  const experience = createCollaborationExperienceStore({ board, scope: "workspace-real", now, async recordRuntimeReceipt(receipt) {
    receipts.push(receipt);
    return { ok: true };
  } });
  const published = await experience.publishExperience({ issueId: focus.issue.issueId, familyId: "first-expert", owner: { kind: "expert", experienceKey: firstExpert.experienceKey },
    expertIdentity: { expertId: firstExpert.expertId, version: firstExpert.version, experienceKey: firstExpert.experienceKey },
    situation: "Inspection", responsibilities: ["worker"], practice: "FIRST_ONLY_EXPERIENCE", sourceRefs: ["report-real"] });
  assert.ok(published.ok, JSON.stringify(published));
  const execution = createCollaborationExecution({ scope: "workspace-real", taskId: "task-real", team, model: "local-model", tools: workspaceTools,
    capabilities, experience, now, warn: reason => { throw new Error(reason); } });
  const requests: ProviderRequest[] = [];
  let entered!: () => void, release!: () => void;
  const firstEntered = new Promise<void>(resolve => { entered = resolve; }), firstGate = new Promise<void>(resolve => { release = resolve; });
  const provider: ProviderPort = { fork() { return { async *stream(request, signal) {
    requests.push(request);
    if (requests.length === 1) {
      entered();
      await Promise.race([firstGate, new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }))]);
    }
    yield { type: "stream_start", providerId: "local-development-provider", model: request.model, warnings: [] };
    yield { type: "text_start", blockId: "answer" };
    yield { type: "text_delta", blockId: "answer", text: "Local result" };
    yield { type: "text_end", blockId: "answer" };
    yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
  } }; }, stream: () => { throw new Error("Child provider must fork"); } };
  let sequence = 0;
  const runtime = new SubagentRuntime({ tools: workspaceTools, idGenerator: () => `local-${++sequence}` });

  t.after(async () => {
    release();
    await runtime.cancelAll();
  });
  const resolutions: unknown[] = [];
  const controlTools = createSubagentControlTool({ runtime, provider, permission, team, model: "local-model", allowedTools: bindings.map(tool => tool.name), collaboration: execution.member,
    memberConfigurations: { async resolve(input) {
      const result = await execution.memberConfigurations.resolve(input);
      resolutions.push(result);
      return result;
    } } });
  const parentTools = execution.wrapParentTools(controlTools);
  const call = async (name: string, args: JsonObject) => { const result = await parentTools.execute({ name, arguments: args, toolCallId: `call-${++sequence}` }, new AbortController().signal);
    assert.equal(result.outcome, "result");
  if (result.outcome !== "result") throw new Error(JSON.stringify(result));
  return result.value; };
  const substituted = await parentTools.execute({ name: "spawn_agent", toolCallId: "wrong-frozen-expert", arguments: {
    member_id: "member-real", agent_type: "worker", message: "Do not silently substitute the selected expert",
    configuration_ref: execution.reference({ expertId: secondExpert.expertId }) } }, new AbortController().signal);

  assert.equal(substituted.outcome, "error", "A model-supplied reference cannot replace the user's selected expert at initial composition");
  assert.equal(requests.length, 0);
  const started = await call("spawn_agent", { member_id: "member-real", agent_type: "worker", message: "Inspect first artifact",
    configuration_ref: execution.reference({ expertId: firstExpert.expertId }) });

  await firstEntered;
  const secondRef = execution.reference({ expertId: secondExpert.expertId }, "member-real");
  const handoff = { scope: "Inspect next artifact", artifacts: ["artifact.json"], evidence: ["check:local"], pending: [], blockers: [] };
  const busy = await call("reconfigure_agent", { target: started.task_id!, configuration_ref: secondRef, message: "Inspect next", handoff });

  assert.equal(busy.reason, "waiting_handoff");
  assert.equal(resolutions.length, 1);
  release();
  await call("wait_agent", { targets: [started.task_id!], timeout_ms: 1000 });
  assert.match(JSON.stringify(resolutions[0]), /expertAdoption/);
  assert.match(JSON.stringify(resolutions[0]), /"maxIterations":2/);
  assert.equal((started.configuration as JsonObject).expert_adoption !== undefined, true);
  const firstText = JSON.stringify(requests[0]!.messages);

  for (const part of ["ORIGINAL_GUIDANCE", "ENGINEERING_CONTRACT", "EXISTING_USER_CONSTRAINT", "METHOD_FIRST", "FIRST_ONLY_EXPERIENCE"]) assert.ok(firstText.includes(part), part);

  const changed = await call("reconfigure_agent", { target: started.task_id!, configuration_ref: secondRef, message: "Inspect next", handoff });

  assert.equal(changed.status, "configured");
  await call("wait_agent", { targets: [started.task_id!], timeout_ms: 1000 });
  const secondText = JSON.stringify(requests[1]!.messages);

  assert.match(secondText, /METHOD_SECOND/);
  assert.doesNotMatch(secondText, /METHOD_FIRST|FIRST_ONLY_EXPERIENCE/);
  assert.match(secondText, /ENGINEERING_CONTRACT/);
  assert.ok(requests[1]!.tools.some(tool => tool.name === "web_fetch") && !requests[1]!.tools.some(tool => tool.name === "run_shell"), "The new expert drops the old expert's denial and keeps the original user's denial");
  assert.match(JSON.stringify(resolutions[1]), /"boundary":"handoff"/);
  assert.ok(receipts.some(receipt => receipt.phase === "dispatched" && "versionIds" in receipt && receipt.versionIds.includes(published.versionId)));
  const rejected = await call("reconfigure_agent", { target: started.task_id!, configuration_ref: execution.reference({ expertId: conflictExpert.expertId }, "member-real"), message: "Conflicting model", handoff });

  assert.equal(rejected.status, "unavailable");
  assert.match(String(rejected.reason), /fixed team member model/);
  assert.equal(requests.length, 2);
});
