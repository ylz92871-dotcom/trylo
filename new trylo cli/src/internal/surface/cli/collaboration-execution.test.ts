import assert from "node:assert/strict";
import test from "node:test";
import { reduce } from "../../learning/control/reducer.js";
import { emptyBoardState } from "../../learning/control/state.js";
import type { BoardStore } from "../../learning/control/store-port.js";
import type { ExperienceBoundaryReceipt } from "../../protocol/collaboration-experience.js";
import { createCollaborationControl } from "../../learning/agent/subsystems/collaboration/control/index.js";
import { createCollaborationExperienceStore } from "../../learning/agent/subsystems/collaboration/experience/index.js";
import type { PublishExperienceInput } from "../../learning/agent/subsystems/collaboration/experience/index.js";
import { createCollaborationRuntimeReceiptWriter } from "../../learning/agent/subsystems/collaboration/runtime/receipts/index.js";
import { ExpertLibrary, type ExpertIdentity, type ExpertVersion } from "../../subagent/experts/index.js";
import type { CollaborationRound } from "../../subagent/collaboration.js";
import { createSubagentControlTool } from "../../subagent/control-tools.js";
import { SubagentRuntime } from "../../subagent/runtime.js";
import type { JsonObject } from "../../protocol/envelope.js";
import type { SubagentTeam } from "../../subagent/team.js";
import { createToolLibrary } from "../../tooling/library/index.js";
import type { ProviderPort } from "../../ports/provider.js";
import type { ToolPort } from "../../ports/tools.js";
import { createCollaborationExecution } from "./collaboration-execution.js";
import type { CollaborationCapabilities } from "./collaboration-capabilities.js";
import { createPersonalAgentProvider } from "./collaboration-parent-context.js";
import { streamPreparedProvider } from "../../testing/provider-request.js";
import { createCollaborationObjectiveObservations, type CollaborationObjectiveObservations } from "../../learning/agent/subsystems/collaboration/runtime/objective-observations.js";

const NOW = "2026-11-03T12:00:00.000Z", scope = "workspace:round-boundary";
const identity: ExpertIdentity = { expertId: "expert:units", version: 1, experienceKey: "experience:units" };
const owner = { kind: "expert", experienceKey: identity.experienceKey } as const;
const team: SubagentTeam = { runId: "team-boundary", profileId: "profile-boundary", surface: "code", members: [
  { memberId: "worker-a", baseRole: "worker", displayName: "Units worker", role: { name: "worker", description: "Convert the assigned artifact", prompt: "Keep original user constraints." } },
  { memberId: "reviewer-a", baseRole: "reviewer", displayName: "Reviewer", role: { name: "reviewer", description: "Inspect output" } },
] };
const unexpected = (): never => { throw new Error("This boundary test must not invoke a library, model, business tool or external IO"); };
const tools: ToolPort = { snapshot: () => [], execute: unexpected, cancel: unexpected };

function unusedCapabilities(): CollaborationCapabilities {
  const library = new ExpertLibrary({ store: { read: unexpected, update: unexpected }, authorization: { authorize: unexpected },
    builder: { build: unexpected }, now: () => Date.parse(NOW), createId: unexpected });
  return { toolLibrary: createToolLibrary({ sources: [], access: unexpected }),
    expertHost: { library, execute: unexpected, executeUserAction: unexpected, instantiate: unexpected },
    configuredTools: tools, executeAuthorized: unexpected, executeTool: unexpected, buildExpert: unexpected };
}

function existingConfigurations(descriptions: readonly string[]): CollaborationCapabilities {
  const versions: ExpertVersion[] = descriptions.map((description, index) => ({ ...identity, version: index + 1,
    createdAt: Date.parse(NOW), requestId: `fixture:configuration-${index + 1}`, configuration: {
      displayName: "Units specialist", specialty: description, situations: ["Assigned artifact work"], responsibilities: [description],
      constraints: ["Keep original user constraints."], collaboration: [], baseRole: "worker",
      role: { name: "worker", description, allowedTools: [] }, toolRefs: [],
      methods: [{ title: "Read the current artifact", instructions: "Check its stated premises.", sourceUris: ["fixture:user-method"] }],
      sources: [{ kind: "user", title: "Test method", uri: "fixture:user-method", excerpt: "Check stated premises." }] } }));
  const base = unusedCapabilities(), library = new ExpertLibrary({ store: { read: () => ({ schemaVersion: 1, sequence: 1,
    experts: [{ expertId: identity.expertId, experienceKey: identity.experienceKey, status: "active", versions }], requests: [] }), update: unexpected },
    authorization: { authorize: unexpected }, builder: { build: unexpected }, now: () => Date.parse(NOW), createId: unexpected });

  return { ...base, expertHost: { ...base.expertHost, library }, toolLibrary: createToolLibrary({ sources: [],
    access: async () => ({ ok: true, value: { tools, configuredNames: [], permission: {} } }) }) };
}

async function fixture() {
  let state = emptyBoardState(), enabled = true;
  const warnings: string[] = [];
  const board: Pick<BoardStore, "load" | "apply"> = { async load() { return { ok: true, state, generation: 0 }; }, async apply(command) {
    const result = reduce(state, command);
    if (result.ok) state = result.state;
    return result;
  } };
  const control = createCollaborationControl({ board, now: () => NOW, ownerId: "boundary-fixture" });
  const reported = await control.report({ scope, problemKey: "unit-reference", report: { reportId: "report:round",
    source: { teamRunId: team.runId, taskId: "task-round", memberId: "worker-a" }, facts: ["The unit reference was incomplete."], evidenceRefs: [] } });
  assert.ok(reported.ok);
  const focused = await control.decide({ issueId: reported.issue.issueId, expectedRevision: reported.issue.revision, decision: "focused_learning",
    reason: "Learn a reusable handoff improvement.", sourceRefs: ["report:round"] });
  assert.ok(focused.ok);
  const enabledNow = () => enabled;
  const writer = createCollaborationRuntimeReceiptWriter({ board, scope, enabled: enabledNow });
  const experience = createCollaborationExperienceStore({ board, scope, now: () => NOW, enabled: enabledNow, recordRuntimeReceipt: writer.record });
  const publish = (patch: Partial<PublishExperienceInput> = {}) => experience.publishExperience({ issueId: focused.issue.issueId, familyId: "unit-reference", owner,
    ...(patch.owner === undefined || patch.owner.kind === "expert" ? { expertIdentity: identity } : {}), situation: "A conversion handoff",
    responsibilities: ["worker"], practice: "Attach original units before downstream work.", sourceRefs: ["report:round"], ...patch });
  const execution = (store = experience, workspace = scope, objective?: CollaborationObjectiveObservations, capabilities = unusedCapabilities()) => createCollaborationExecution({ scope: workspace, taskId: team.runId, team, model: "development-only",
    tools, capabilities, experience: store, now: () => NOW, warn: reason => warnings.push(reason), enabled: enabledNow,
    ...(objective === undefined ? {} : { objective }) });

  return { board, experience, writer, publish, execution, warnings, state: () => state, enabled: enabledNow, withdraw: () => { enabled = false; } };
}

function round(number: number, expert = identity): CollaborationRound {
  return { executionId: `turn-${number}`, teamRunId: team.runId, taskId: "task-round", memberId: "worker-a", role: "worker", round: number,
    assignment: "Convert the assigned artifact", dependencies: [], configuration: { configurationRef: "expert-configuration:units", configurationVersion: "configuration-v1",
      identity: expert, experienceVersionIds: [], ...(team.profileId === undefined ? {} : { profileId: team.profileId }) } };
}

test("the actual member port reloads a revised experience at the next round and records only that round's exact owner versions", async () => {
  const h = await fixture(), first = await h.publish();
  assert.ok(first.ok);
  const execution = h.execution(), signal = new AbortController().signal, one = round(1);
  const guidanceOne = await execution.member.prepare(one, signal);
  assert.match(guidanceOne ?? "", /Attach original units before downstream work/);
  await execution.member.dispatched(one, "provider:round-one", guidanceOne);
  const usage = h.state().collaborationRuntimeReceipts?.find(r => r.phase === "dispatched");
  assert.ok(usage);
  assert.ok((await h.experience.recordUseFeedback({ receiptId: "feedback:round-one", owner, versionIds: [first.versionId], usageReceiptId: usage.receiptId,
    summary: "The downstream member also needed an artifact path and a checkable example.", sourceRefs: ["report:round"], outcome: "not_helped", recordedAt: NOW })).ok);
  const second = await h.publish({ parentVersion: first.versionId, sourceRefs: ["feedback:round-one"], practice: "Send the artifact path, units and a checkable sample." });
  assert.ok(second.ok);
  const two = round(2), guidanceTwo = await execution.member.prepare(two, signal);

  assert.match(guidanceTwo ?? "", /Send the artifact path, units and a checkable sample/);
  assert.doesNotMatch(guidanceTwo ?? "", /Attach original units before downstream work/);
  await execution.member.dispatched(two, "provider:round-two", guidanceTwo);
  const receipts = h.state().collaborationRuntimeReceipts?.filter((r): r is ExperienceBoundaryReceipt => r.phase === "loaded" || r.phase === "dispatched") ?? [];

  assert.deepEqual(receipts.map(r => [r.boundary.round, r.phase, r.versionIds]), [[1, "loaded", [first.versionId]], [1, "dispatched", [first.versionId]],
    [2, "loaded", [second.versionId]], [2, "dispatched", [second.versionId]]]);
  const other = await execution.member.prepare(round(3, { ...identity, expertId: "other", experienceKey: "experience:other" }), signal);

  assert.match(other ?? "", /No trial collaboration experience applies/);
  assert.doesNotMatch(other ?? "", /checkable sample/);
  const foreign = createCollaborationExperienceStore({ board: h.board, scope: "workspace:foreign", now: () => NOW });

  assert.match(await h.execution(foreign, "workspace:foreign").member.prepare(round(4), signal) ?? "", /No trial collaboration experience applies/);
});

test("a PA provider records each stream in one logical attempt and never dispatches a before-header failure", async () => {
  const h = await fixture(), personal = { kind: "personal_agent", experienceKey: "trylo.personal_agent.v1" } as const;
  const first = await h.publish({ owner: personal });
  assert.ok(first.ok);
  let requests = 0, prepares = 0, inspections = 0, pendingReads = 0, currentRound = 1;
  const warnings: string[] = [], contexts: string[] = [];
  const provider: ProviderPort = { async *stream(request) { requests += 1;
  contexts.push(request.messages.map(message => typeof message.content === "string" ? message.content : "").join("\n"));
    yield { type: "stream_start", providerId: "development-only", model: "development-only", warnings: [] };
    if (requests === 1) yield { type: "error", class: "network", retryable: true, phase: "before_headers", message: "development pre-header failure" };
    else yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false }; } };
  let clock = 0;
  const options = { provider, experience: { ...h.experience, async prepareExperience(input: Parameters<typeof h.experience.prepareExperience>[0]) {
    prepares += 1;
    return h.experience.prepareExperience(input);
  } }, scope, taskId: "pa-task", now: () => new Date(Date.parse(NOW) + clock++).toISOString(), warn: (reason: string) => warnings.push(reason),

  inspect: async () => {
    inspections += 1;
    return { ok: true, state: { issues: [] }, resources: { followUp: { totalPending: currentRound, items: [] } } };
  },

  recentFacts: () => [], readSkillPending: async () => {
    pendingReads += 1;
    return { text: `pending:round-${currentRound}`, sourceRefs: [`native:round-${currentRound}`] };
  } };
  const parent = createPersonalAgentProvider({ ...options, turnId: "pa-turn" });
  const request = { attemptId: "attempt-before-headers", model: "development-only", messages: [{ role: "user" as const, content: "user:round-1" }], tools: [] };

  for await (const event of streamPreparedProvider(parent, request, new AbortController().signal)) {
    assert.ok(event.type === "stream_start" || event.type === "error");
  }

  assert.equal(requests, 1);
  assert.deepEqual(h.state().collaborationRuntimeReceipts?.map(r => r.phase), ["loaded"]);
  const revisedPractice = "Attach original units and a separately checkable source example before downstream work.";
  const revised = await h.publish({ owner: personal, parentVersion: first.versionId, practice: revisedPractice });
  assert.ok(revised.ok);

  // The normal loop keeps the logical attempt ID while later tool-result streams advance the PA round.
  for (let round = 2; round <= 3; round += 1) {
    currentRound = round;
    for await (const event of streamPreparedProvider(parent, { ...request, messages: [{ role: "user", content: `user:round-${round}` }] }, new AbortController().signal)) {
      assert.ok(event.type === "stream_start" || event.type === "finish");
    }
  }

  const receipts = h.state().collaborationRuntimeReceipts ?? [];

  assert.deepEqual(receipts.map(r => "boundary" in r ? [r.phase, r.boundary.round] : r.phase),
    [["loaded", 1], ["loaded", 2], ["dispatched", 2], ["loaded", 3], ["dispatched", 3]]);
  assert.equal(new Set(receipts.map(r => r.receiptId)).size, 5);
  assert.equal(requests, 3);
  assert.deepEqual(warnings, []);
  assert.equal(prepares, 1);
  assert.equal(inspections, 3);
  assert.equal(pendingReads, 3);

  for (const receipt of receipts) assert.deepEqual("versionIds" in receipt ? receipt.versionIds : [], [first.versionId]);

  for (let index = 0; index < contexts.length; index += 1) {
    assert.match(contexts[index]!, /Attach original units before downstream work/);
    assert.equal(contexts[index]!.includes(revisedPractice), false);
    assert.ok(contexts[index]!.includes(`user:round-${index + 1}`));
    assert.ok(contexts[index]!.includes(`pending:round-${index + 1}`));
    assert.ok(contexts[index]!.includes(`"pendingUseCount":${index + 1}`), "live compact signals stay fresh while experience admission is frozen");
    if (index > 0) {
      assert.equal(contexts[index]!.includes(`user:round-${index}`), false);
      assert.equal(contexts[index]!.includes(`pending:round-${index}`), false);
    }
  }

  const load = receipts.find((r): r is ExperienceBoundaryReceipt => r.phase === "loaded"),
    dispatch = receipts.find((r): r is ExperienceBoundaryReceipt => r.phase === "dispatched");
  assert.ok(load);
  assert.ok(dispatch);
  const original = JSON.stringify(h.state());

  assert.ok((await h.experience.recordLoad(load)).ok);
  assert.ok((await h.experience.recordDispatch(dispatch)).ok);
  const changed = await h.experience.recordLoad({ ...load, boundary: { ...load.boundary, round: 99 } });

  assert.deepEqual(changed, { ok: false, reason: "command_payload_conflict" });
  assert.equal(JSON.stringify(h.state()), original, "exact replay and a refused conflicting payload preserve every original fact");
  const nextTurn = createPersonalAgentProvider({ ...options, turnId: "pa-next-turn" });
  currentRound = 4;

  for await (const event of streamPreparedProvider(nextTurn, { ...request, messages: [{ role: "user", content: "user:next-turn-same-task" }] }, new AbortController().signal)) {
    assert.ok(event.type === "stream_start" || event.type === "finish");
  }

  assert.equal(prepares, 2, "a new turn re-admits experience even when taskId is unchanged");
  assert.ok(contexts.at(-1)!.includes(revisedPractice));
  const nextReceipts = (h.state().collaborationRuntimeReceipts ?? []).slice(receipts.length);

  assert.deepEqual(nextReceipts.map(receipt => receipt.phase), ["loaded", "dispatched"]);

  for (const receipt of nextReceipts) assert.deepEqual("versionIds" in receipt ? receipt.versionIds : [], [revised.versionId]);

  let entered!: () => void, release!: () => void, cancelledPrepares = 0;
  const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const cancelledContexts: string[] = [], cancellation = new AbortController(), beforeCancelled = JSON.stringify(h.state());
  const cancelledProvider: ProviderPort = { async *stream(input) {
    cancelledContexts.push(input.messages.map(message => typeof message.content === "string" ? message.content : "").join("\n"));
    yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
  } };
  const cancelledParent = createPersonalAgentProvider({ provider: cancelledProvider, experience: { ...h.experience,

    async prepareExperience(input) { cancelledPrepares += 1;
    const actual = await h.experience.prepareExperience(input);
    assert.ok(actual.ok);
      assert.deepEqual(actual.versionIds, [revised.versionId]);
    entered();
    await gate;
    return actual; } }, scope, turnId: "pa-cancelled-admission", taskId: "pa-task",
    now: options.now, warn: options.warn, inspect: async () => ({}), recentFacts: () => [] });
  const pending = (async () => { for await (const _event of streamPreparedProvider(cancelledParent, request, cancellation.signal)) { /* Drain the original request boundary. */ } })();

  await started;
  cancellation.abort();
  release();
  await pending;

  for await (const _event of streamPreparedProvider(cancelledParent, request, new AbortController().signal)) { /* An active retry cannot resurrect the cancelled admission. */ }

  assert.equal(cancelledPrepares, 1);
  assert.equal(cancelledContexts.length, 2);

  for (const context of cancelledContexts) {
    assert.equal(context.includes(revisedPractice), false);
    assert.doesNotMatch(context, /Attach original units before downstream work/);
  }

  assert.equal(JSON.stringify(h.state()), beforeCancelled, "a cancelled first admission and later active stream record no experience exposure");
  assert.deepEqual(warnings, []);
});

test("privacy withdrawal during the member's pending load receipt returns no guidance or dispatch", async () => {
  const h = await fixture();
  assert.ok((await h.publish()).ok);
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const experience = { ...h.experience, async recordLoad(input: Parameters<typeof h.experience.recordLoad>[0]) {
    entered();
    await gate;
    return h.experience.recordLoad(input);
  } };
  const execution = h.execution(experience), current = round(1), pending = execution.member.prepare(current, new AbortController().signal);

  await started;
  h.withdraw();
  release();
  assert.equal(await pending, undefined);
  await execution.member.dispatched(current, "provider-after-withdrawal", "stale guidance");
  assert.deepEqual(h.state().collaborationRuntimeReceipts ?? [], []);
  assert.deepEqual(h.warnings, ["collect_disabled"]);
});

test("completed or ended work rounds release their loaded guidance and reject later exposure callbacks", async () => {
  for (const terminal of ["completed", "ended"] as const) {
    const h = await fixture();
    assert.ok((await h.publish()).ok);
    const execution = h.execution(), current = round(1), guidance = await execution.member.prepare(current, new AbortController().signal);

    await execution.member.dispatched(current, "request:before-retirement", guidance);

    if (terminal === "completed") await execution.member.completed(current, "The original work returned its output.");
    else await execution.member.ended(current, "cancelled", "user_cancelled");

    await execution.member.dispatched(current, "request:late-after-retirement", guidance);
    assert.equal(h.state().collaborationRuntimeReceipts?.filter(receipt => receipt.phase === "dispatched").length, 1);
  }
});

test("completed or ended boundaries fence an awaited experience lookup before it can load or return retired guidance", async () => {
  for (const terminal of ["completed", "ended"] as const) {
    const h = await fixture();
    assert.ok((await h.publish()).ok);
    let entered!: () => void, release!: () => void, loadCalls = 0;
    const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    const experience = { ...h.experience,

      async prepareExperience(input: Parameters<typeof h.experience.prepareExperience>[0]) {
        entered();
        await gate;
        return h.experience.prepareExperience(input);
      },

      async recordLoad(input: Parameters<typeof h.experience.recordLoad>[0]) {
        loadCalls += 1;
        return h.experience.recordLoad(input);
      } };
    const execution = h.execution(experience), current = round(1);
    const pending = execution.member.prepare(current, new AbortController().signal);
    await started;

    if (terminal === "completed") await execution.member.completed(current, "The original round already returned.");
    else await execution.member.ended(current, "cancelled", "execution_retired");

    release();
    assert.equal(await pending, undefined, "a retired round cannot return late loaded guidance");
    assert.equal(loadCalls, 0, "a retired round cannot record a late experience load");
    await execution.member.dispatched(current, `request:late-${terminal}`, "Stale callback after the original round ended.");
    assert.deepEqual(h.state().collaborationRuntimeReceipts ?? [], []);
  }
});

test("an old incarnation's terminal cannot erase the replacement's loaded guidance at the same logical task and round", async () => {
  const h = await fixture();
  assert.ok((await h.publish()).ok);
  const execution = h.execution(), original = round(1), replacement = { ...original, executionId: "execution:replacement" };

  await execution.member.prepare(original, new AbortController().signal);
  const guidance = await execution.member.prepare(replacement, new AbortController().signal);

  await execution.member.ended(original, "cancelled", "replaced");
  await execution.member.dispatched(replacement, "request:replacement", guidance);
  const dispatched = h.state().collaborationRuntimeReceipts?.filter((receipt): receipt is ExperienceBoundaryReceipt & { readonly phase: "dispatched" } => receipt.phase === "dispatched");

  assert.equal(dispatched?.length, 1);
  assert.equal(dispatched?.[0]?.boundary.executionId, replacement.executionId);
});

test("a predecessor terminal cannot invalidate a replacement's still-awaited preparation at the same logical boundary", async () => {
  const h = await fixture();
  assert.ok((await h.publish()).ok);
  let entered!: () => void, release!: () => void, lookups = 0;
  const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const experience = { ...h.experience, async prepareExperience(input: Parameters<typeof h.experience.prepareExperience>[0]) {
    if (++lookups === 2) {
      entered();
      await gate;
    }
    return h.experience.prepareExperience(input);
  } };
  const execution = h.execution(experience), original = round(1), replacement = { ...original, executionId: "execution:pending-replacement" };

  await execution.member.prepare(original, new AbortController().signal);
  const pending = execution.member.prepare(replacement, new AbortController().signal);
  await started;
  await execution.member.ended(original, "cancelled", "replaced");
  release();
  const guidance = await pending;
  assert.match(guidance ?? "", /Attach original units before downstream work/);
  await execution.member.dispatched(replacement, "request:pending-replacement", guidance);
  const dispatched = h.state().collaborationRuntimeReceipts?.filter((receipt): receipt is ExperienceBoundaryReceipt & { readonly phase: "dispatched" } => receipt.phase === "dispatched");

  assert.equal(dispatched?.length, 1);
  assert.equal(dispatched?.[0]?.boundary.executionId, replacement.executionId);
});

test("the actual member prepare and capture hooks expose bounded objective handoff data alongside its own trial experience", async () => {
  const h = await fixture();
  assert.ok((await h.publish()).ok);
  const objective = createCollaborationObjectiveObservations({ scope, turnId: "parent:objective", taskId: team.runId, team,
    goal: "Convert the source while preserving the original units." });
  const execution = h.execution(h.experience, scope, objective), signal = new AbortController().signal;
  const current = { ...round(1), handoff: { scope: "Dependent conversion", artifacts: ["source-units.csv"], evidence: [], pending: ["Confirm source units"], blockers: [] } };
  const guidance = await execution.member.prepare(current, signal);

  assert.match(guidance ?? "", /Objective context/);
  assert.match(guidance ?? "", /source-units.csv/);
  assert.ok(guidance!.length <= 1800);
  assert.ok(guidance!.endsWith("Attach original units before downstream work."));
  await execution.member.dispatched(current, "request:objective", guidance);
  await execution.member.capture?.(current, { protocolVersion: "0.0", eventId: "event:member-tool", sequence: 1,
    timestamp: NOW, turnId: "child:objective", producerId: "loop", producerSequence: 1, kind: "tool_use",
    payload: { toolCallId: "tool:member", name: "read_file" } });
  await execution.member.completed(current, "Member supplied its answer.");
  assert.equal(objective.snapshot().rounds[0]!.phase, "completed");
  assert.equal(objective.snapshot().pendingTools.length, 0);
  assert.equal(objective.snapshot().unreturnedTools.length, 1, "the boundary preserves an unknown result rather than claiming the tool failed or stopped");
  assert.equal(h.state().collaborationRuntimeReceipts?.filter(receipt => receipt.phase === "dispatched").length, 1);
});

test("first configured dispatch retains frozen-duty experience and the next expert replaces only its actual specialty context", async t => {
  const h = await fixture(), originalDuty = team.members[0]!.role.description;
  const firstSpecialty = "Inspect source units", nextSpecialty = "Inspect correlated retries";

  assert.ok((await h.publish({ familyId: "frozen-duty", practice: "FROZEN_DUTY_CARD", conditions: { responsibility: originalDuty } })).ok);
  assert.ok((await h.publish({ familyId: "first-specialty", practice: "FIRST_SPECIALTY_CARD", conditions: { responsibility: firstSpecialty } })).ok);
  assert.ok((await h.publish({ familyId: "next-specialty", expertIdentity: { ...identity, version: 2 }, practice: "NEXT_SPECIALTY_CARD",
    conditions: { responsibility: nextSpecialty } })).ok);
  const execution = h.execution(h.experience, scope, undefined, existingConfigurations([firstSpecialty, nextSpecialty]));
  const requests: string[] = [], provider: ProviderPort = { async *stream(request) {
    requests.push(JSON.stringify(request.messages));
    yield { type: "text_start", blockId: "answer" };
    yield { type: "text_delta", blockId: "answer", text: "Artifact inspected." };
    yield { type: "text_end", blockId: "answer" };
    yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
  } };
  const runtime = new SubagentRuntime({ tools }), controlTools = createSubagentControlTool({ runtime, provider, team,
    permission: { request: unexpected, awaitDecision: unexpected }, collaboration: execution.member, memberConfigurations: execution.memberConfigurations });

  t.after(() => runtime.cancelAll());
  let sequence = 0;
  const call = async (name: string, args: JsonObject) => {
    const result = await controlTools.execute({ name, arguments: args, toolCallId: `responsibility:${++sequence}` }, new AbortController().signal);
    assert.equal(result.outcome, "result");
    if (result.outcome !== "result") throw new Error("Original control tool returned no result");
    return result.value;
  };
  const first = await call("spawn_agent", { member_id: "worker-a", agent_type: "worker", message: "Inspect assigned artifact",
    configuration_ref: execution.reference({ expertId: identity.expertId, version: 1 }, "worker-a") });
  const taskId = String(first.task_id);
  await call("wait_agent", { targets: [taskId], timeout_ms: 1000 });
  assert.match(requests[0] ?? "", /FROZEN_DUTY_CARD/);
  assert.match(requests[0] ?? "", /FIRST_SPECIALTY_CARD/);
  assert.doesNotMatch(requests[0] ?? "", /NEXT_SPECIALTY_CARD/);
  assert.deepEqual(execution.responsibilityContext("worker-a")?.responsibilities, [originalDuty, firstSpecialty, "worker"]);
  const next = await call("reconfigure_agent", { target: taskId,
    configuration_ref: execution.reference({ expertId: identity.expertId, version: 2 }, "worker-a"), message: "Inspect retries next",
    handoff: { scope: "Continue artifact inspection", artifacts: ["artifact.json"], evidence: [], pending: ["Inspect retries"], blockers: [] } });

  assert.equal(next.status, "configured");
  await call("wait_agent", { targets: [taskId], timeout_ms: 1000 });
  assert.match(requests[1] ?? "", /FROZEN_DUTY_CARD/);
  assert.match(requests[1] ?? "", /NEXT_SPECIALTY_CARD/);
  assert.doesNotMatch(requests[1] ?? "", /FIRST_SPECIALTY_CARD/);
  assert.deepEqual(execution.responsibilityContext("worker-a")?.responsibilities, [originalDuty, nextSpecialty, "worker"]);
  assert.equal(execution.responsibilityContext("worker-a")?.identity?.version, 2);
});

test("resolving an unused candidate and a late predecessor load cannot overwrite the current adopted responsibility context", async () => {
  const h = await fixture(), firstSpecialty = "Inspect source units", nextSpecialty = "Inspect correlated retries";

  assert.ok((await h.publish()).ok);
  let entered!: () => void, release!: () => void, calls = 0;
  const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const experience = { ...h.experience, async prepareExperience(input: Parameters<typeof h.experience.prepareExperience>[0]) {
    if (++calls === 1) {
      entered();
      await gate;
    }
    return h.experience.prepareExperience(input);
  } };
  const execution = h.execution(experience, scope, undefined, existingConfigurations([firstSpecialty, nextSpecialty]));
  const signal = new AbortController().signal;
  const resolve = (version: number) => execution.memberConfigurations.resolve({ configurationRef: execution.reference({ expertId: identity.expertId, version }, "worker-a"),
    baseRole: "worker", task: "Inspect artifact", boundary: version === 1 ? "composition" : "handoff",
    teamMember: { teamRunId: team.runId, memberId: "worker-a" }, signal });
  const first = await resolve(1);
  assert.equal(first.kind, "ready");
  assert.equal(execution.responsibilityContext("worker-a"), undefined, "candidate resolution is not an adoption");
  const predecessor = { ...round(1), roleDescription: first.role.description,
    configuration: { ...round(1).configuration!, configurationRef: execution.reference({ expertId: identity.expertId, version: 1 }, "worker-a"),
      configurationVersion: first.configurationVersion } };
  const pending = execution.member.prepare(predecessor, signal);
  await started;
  const next = await resolve(2);
  assert.equal(next.kind, "ready");
  assert.deepEqual(execution.responsibilityContext("worker-a")?.responsibilities, [team.members[0]!.role.description, firstSpecialty, "worker"],
    "a ready candidate without a work boundary must not change the current role");
  const replacement = { ...round(1, next.identity), executionId: "execution:replacement-specialty", roleDescription: next.role.description,
    configuration: { ...round(1, next.identity).configuration!, configurationRef: execution.reference({ expertId: identity.expertId, version: 2 }, "worker-a"),
      configurationVersion: next.configurationVersion } };
  const guidance = await execution.member.prepare(replacement, signal);
  assert.ok(guidance);
  release();
  assert.equal(await pending, undefined, "the superseded preparation must not return stale guidance");
  await execution.member.ended(predecessor, "cancelled", "reconfigured");
  assert.deepEqual(execution.responsibilityContext("worker-a")?.responsibilities, [team.members[0]!.role.description, nextSpecialty, "worker"]);
  assert.equal(execution.responsibilityContext("worker-a")?.executionId, replacement.executionId);
  assert.equal(execution.identities().get("worker-a")?.version, 2);
  assert.notEqual(execution.responsibilityContext("worker-a"), execution.responsibilityContext("worker-a"), "the public view is a read-only copy");
});
