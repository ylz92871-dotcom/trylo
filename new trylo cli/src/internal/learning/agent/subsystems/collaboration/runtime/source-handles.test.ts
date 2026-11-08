import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderPort } from "../../../../../ports/provider.js";
import { reduce } from "../../../../control/reducer.js";
import { emptyBoardState } from "../../../../control/state.js";
import type { BoardStore } from "../../../../control/store-port.js";
import { centralLearningSpent } from "../../../../control/coordination-contract.js";
import { createCollaborationControl, type CollaborationCentralWorker } from "../control/index.js";
import { createCollaborationExperienceStore, isCollaborationExperienceContent, type PublishExperienceInput } from "../experience/index.js";
import { createCollaborationWorker, isCollaborationPlan } from "../orchestration/index.js";
import { createCollaborationDecisionModel } from "./decision-model.js";
import { createSourceHandles, expandActionSourceHandles } from "./source-handles.js";

const scope = "workspace:source-handles", NOW = "2026-11-03T12:00:00.000Z", sourceRef = `artifact:source:${"a".repeat(64)}`;
const allowance = { schemaVersion: 2 as const, unit: "total_model_tokens" as const, maxTokens: 24000, maxCalls: 2, maxSteps: 2, maxPromptChars: 40000 };

async function scenario(invalid: boolean) {
  let state = emptyBoardState(), worker: CollaborationCentralWorker | undefined, calls = 0, supplied: Record<string, string> | undefined;
  const board: Pick<BoardStore, "load" | "apply"> = { load: async () => ({ ok: true, state, generation: 0 }), apply: async command => {
    const result = reduce(state, command);
    if (result.ok) state = result.state;
    return result;
  } };
  const control = createCollaborationControl({ board, now: () => NOW, ownerId: "source-handle-contract",
    worker: { run: input => {
      assert.ok(worker);
      return worker.run(input);
    } } });
  const report = await control.report({ scope, problemKey: "reference-handoff", report: { reportId: "report:source",
    source: { teamRunId: "team", taskId: "task", memberId: "worker" }, facts: ["A source reference was omitted."], evidenceRefs: [sourceRef, "R1"] } });
  assert.ok(report.ok);
  const focused = await control.decide({ issueId: report.issue.issueId, expectedRevision: report.issue.revision,
    decision: "focused_learning", reason: "PA selected this recurring handoff issue.", sourceRefs: ["report:source"] });
  assert.ok(focused.ok);
  const owner = { kind: "legacy_member" as const, workspace: scope, profileId: "profile:references", memberId: "worker" };
  const store = createCollaborationExperienceStore({ board, scope, now: () => NOW });
  const initial = await store.publishExperience({ issueId: report.issue.issueId, owner, familyId: "reference-handoff", situation: "A member needs an upstream source.",
    responsibilities: ["Dependent member"], practice: "Request the original source reference.", sourceRefs: [sourceRef] });
  assert.ok(initial.ok);
  const appended = await control.report({ scope, problemKey: "reference-handoff", issueId: report.issue.issueId, expectedRevision: focused.issue.revision,
    report: { reportId: "report:parent", source: { teamRunId: "team", taskId: "task", memberId: "worker" },
      facts: ["The prior practice is available for revision."], evidenceRefs: [initial.versionId] } });
  assert.ok(appended.ok);
  const funded = await control.fund({ issueId: report.issue.issueId, expectedRevision: appended.issue.revision, grantId: "grant:original", allowance });
  assert.ok(funded.ok);
  const known = appended.issue.reports.flatMap(r => [r.reportId, ...r.evidenceRefs]), expectedHandles = createSourceHandles(known);
  const handle = (ref: string) => Object.keys(expectedHandles).find(key => expectedHandles[key] === ref)!;

  assert.equal(Object.hasOwn(expectedHandles, "R1"), false);
  assert.ok(Object.keys(expectedHandles).every(key => !known.includes(key)));
  const truncated = initial.versionId.slice(initial.versionId.indexOf(":") + 1);
  const unchanged = { kind: "propose", sourceRefs: [sourceRef, "R999999", "R1"], memberId: handle(sourceRef),
    experiences: [{ ownerRef: handle(sourceRef), sourceRefs: [sourceRef], parentVersion: truncated }], summary: handle(sourceRef) };

  assert.deepEqual(expandActionSourceHandles(unchanged, expectedHandles), unchanged, "Unknown aliases, truncated IDs and identity/plain text fields are never guessed or rewritten");
  const stream: ProviderPort["stream"] = async function* (request) {
    calls += 1;
    const material = JSON.parse(request.messages.find(m => m.role === "user")!.content);

    supplied = material.sourceHandles;
    const action = { kind: "propose", familyId: "reference-handoff", title: "Confirm the exact reference", summary: "Keep the upstream reference and obtain acknowledgment.",
      sourceRefs: invalid ? ["R999999"] : [handle(sourceRef)], adjustments: [], needs: [], experiences: [{ ownerRef: "member:worker", familyId: "reference-handoff",
        situation: "A member needs an upstream source.", responsibilities: ["Dependent member"], practice: "Request the exact original source and obtain acknowledgment.",
        sourceRefs: [handle(sourceRef)], parentVersion: invalid ? truncated : handle(initial.versionId) }] };

    yield { type: "stream_start", providerId: "bounded-source-handle-fixture", model: "fixture", warnings: [] };
    yield { type: "text_delta", blockId: "action", text: JSON.stringify(action) };
    yield { type: "usage", usage: { mode: "snapshot", inputTokens: 100, outputTokens: 20, totalTokens: 120, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } };
    yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
  };

  worker = createCollaborationWorker({ board, scope, now: () => NOW,
    model: createCollaborationDecisionModel({ provider: { stream, fork: () => ({ stream }) }, model: "fixture" }),
    resources: { query: async () => { throw new Error("This bounded action needs no additional resource query"); } },
    context: async () => ({ owners: [{ ref: "member:worker", owner }], parentVersion: initial.versionId }),
    async experienceInput(issueId, draft) {
      assert.equal(draft.ownerRef, "member:worker");
      const input: PublishExperienceInput = { issueId, owner, familyId: draft.familyId,
        situation: draft.situation, responsibilities: draft.responsibilities, practice: draft.practice, sourceRefs: draft.sourceRefs,
        ...(draft.parentVersion === undefined ? {} : { parentVersion: draft.parentVersion }) };
      return { ok: true, input };
    }, publishExperience: store.publishExperience });
  const result = await control.dispatch({ scope });
  assert.ok(result.ok);
  assert.equal(calls, 1);
  assert.equal(state.centralLearningGrants!.length, 1);
  assert.deepEqual(state.centralLearningGrants![0]!.allowance, allowance);
  assert.deepEqual(centralLearningSpent(state.centralLearningGrants![0]!), { tokens: 120, calls: 1, steps: 1 });

  return { state, result, initial, supplied, expectedHandles };
}

test("private source handles cross real central funding and publication as canonical references; unknown aliases publish nothing", async () => {
  const valid = await scenario(false);
  assert.equal(valid.result.status, "completed");
  assert.deepEqual(valid.supplied, valid.expectedHandles);
  const revised = valid.state.assets.find(a => a.versionId !== valid.initial.versionId && isCollaborationExperienceContent(a.content));

  assert.ok(revised);
  assert.ok(isCollaborationExperienceContent(revised.content));
  assert.deepEqual(revised.content.sourceRefs, [sourceRef]);
  assert.equal(revised.content.parentVersionId, valid.initial.versionId);
  const plan = valid.state.assets.find(a => isCollaborationPlan(a.content));
  assert.ok(plan);
  assert.ok(isCollaborationPlan(plan.content));
  assert.deepEqual(plan.content.sourceRefs, [sourceRef]);
  assert.deepEqual(plan.content.experienceVersionIds, [revised.versionId]);
  const invalid = await scenario(true);
  assert.equal(invalid.result.status, "failed");
  assert.equal(invalid.state.assets.length, 1);
  assert.equal(invalid.state.assets[0]!.versionId, invalid.initial.versionId);
  assert.equal(invalid.state.jobs[0]!.coordination?.resultRefs, undefined);
});
