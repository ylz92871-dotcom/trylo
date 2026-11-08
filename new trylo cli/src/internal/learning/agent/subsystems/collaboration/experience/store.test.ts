import assert from "node:assert/strict";
import test from "node:test";
import type { BoardCommand } from "../../../../control/commands.js";
import { reduce } from "../../../../control/reducer.js";
import { emptyBoardState, normalizeBoardState } from "../../../../control/state.js";
import type { BoardStore } from "../../../../control/store-port.js";
import type { ExpertIdentity } from "../../../../../subagent/experts/index.js";
import { createCollaborationControl } from "../control/central.js";
import { createCollaborationRuntimeReceiptWriter } from "../runtime/receipts/index.js";
import type { CollaborationResourceReceipt } from "../../../../../protocol/collaboration-resource.js";
import { createCollaborationExperienceStore } from "./store.js";
import { createExpertExperiencePort } from "./expert-port.js";
import type { ExperienceOwner, PublishExperienceInput } from "./contracts.js";
import { selectExperience } from "./policy.js";
import { isCollaborationExperienceContent } from "./parse.js";

const NOW = "2026-11-03T12:00:00.000Z", scope = "workspace:experience";
const identity: ExpertIdentity = { expertId: "expert:units", version: 1, experienceKey: "experience:units" };
const owner: ExperienceOwner = { kind: "expert", experienceKey: identity.experienceKey };
const boundary = { executionId: "execution:1", taskId: "task:2", round: 2, role: "worker", memberId: "member:1" };

async function harness() {
  let state = emptyBoardState();
  const commands: BoardCommand[] = [];
  const board: Pick<BoardStore, "load" | "apply"> = { async load() { return { ok: true, state, generation: 0 }; }, async apply(command) {
    const result = reduce(state, command);
    if (result.ok) {
      state = result.state;
      if (!result.idempotent) commands.push(command);
    }
    return result;
  } };
  const control = createCollaborationControl({ board, now: () => NOW, ownerId: "boot:1" });
  const reported = await control.report({ scope, problemKey: "unit-handoff", report: { reportId: "report:1",
    source: { teamRunId: "team:1", taskId: "task:1", memberId: "member:1" }, facts: ["The conversion handoff omitted its input unit."], evidenceRefs: ["artifact:missing-unit"] } });

  assert.ok(reported.ok);
  const focused = await control.decide({ issueId: reported.issue.issueId, expectedRevision: reported.issue.revision,
    decision: "focused_learning", reason: "PA selected the recurring coordination problem.", sourceRefs: ["report:1"] });

  assert.ok(focused.ok);
  const funded = await control.fund({ issueId: focused.issue.issueId, expectedRevision: focused.issue.revision, grantId: "grant:1",
    allowance: { schemaVersion: 2, unit: "total_model_tokens", maxTokens: 100, maxCalls: 1, maxSteps: 1, maxPromptChars: 600 } });

  assert.ok(funded.ok);
  const writer = createCollaborationRuntimeReceiptWriter({ board, scope });
  const store = createCollaborationExperienceStore({ board, scope, now: () => NOW, recordRuntimeReceipt: writer.record });
  const input = (patch: Partial<PublishExperienceInput> = {}): PublishExperienceInput => ({ issueId: focused.issue.issueId,
    owner, ...(patch.owner === undefined || patch.owner.kind === "expert" ? { expertIdentity: identity } : {}), familyId: "unit-handoff", situation: "When handing a conversion artifact to a downstream member",
    responsibilities: ["State input and output units"], practice: "Include the source reference, units and one independently checkable example.", sourceRefs: ["report:1"], ...patch });

  return { board, store, writer, control, input, issueId: focused.issue.issueId, jobId: funded.jobId, state: () => state,
    reopen() { state = commands.reduce((s, c) => {
      const result = reduce(s, c);
      assert.ok(result.ok);
      return result.ok ? result.state : s;
    }, emptyBoardState()); } };
}

const prepared = (h: Awaited<ReturnType<typeof harness>>, target: ExperienceOwner = owner, extra = {}) =>
  h.store.prepareExperience({ owner: target, ...(target.kind === "expert" ? { expertVersion: 1 } : {}), maxChars: 600, ...extra });

test("publication preflight is read-only, owns its input, and reuses canonical shape, focus and same-owner family provenance", async () => {
  const h = await harness(), candidate = { ...h.input(), sourceRefs: ["report:1"] }, before = JSON.stringify(h.state());
  const checked = await h.store.preflightExperience(candidate);
  assert.ok(checked.ok);
  assert.equal(JSON.stringify(h.state()), before);
  candidate.practice = "Changed by the caller after preflight.";
  candidate.sourceRefs.push("source:invented");
  assert.notEqual(checked.input.practice, candidate.practice);
  assert.deepEqual(checked.input.sourceRefs, ["report:1"]);
  const base = await h.store.publishExperience(h.input());
  assert.ok(base.ok);
  const wrongFamily = h.input({ familyId: "another-family", parentVersion: base.versionId });

  assert.deepEqual(await h.store.preflightExperience(wrongFamily), { ok: false, reason: "experience_sources_invalid" });
  assert.deepEqual(await h.store.publishExperience(wrongFamily), { ok: false, reason: "experience_sources_invalid" });
  const wrongOwner = h.input({ owner: { kind: "legacy_member", workspace: scope, profileId: "profile:another", memberId: "member:another" }, parentVersion: base.versionId });

  assert.deepEqual(await h.store.preflightExperience(wrongOwner), { ok: false, reason: "experience_sources_invalid" });
  const closed = createCollaborationExperienceStore({ board: h.board, scope, now: () => NOW, enabled: () => false });

  assert.deepEqual(await closed.preflightExperience(h.input({ practice: "x".repeat(1000) })), { ok: false, reason: "collect_disabled" });
  const issue = h.state().learningIssues!.find(value => value.issueId === h.issueId)!;

  assert.ok((await h.control.decide({ issueId: issue.issueId, expectedRevision: issue.revision, decision: "resolved",
    reason: "The current coordination issue is resolved.", sourceRefs: [] })).ok);
  assert.deepEqual(await h.store.preflightExperience(h.input()), { ok: false, reason: "issue_no_longer_focused" });
  assert.equal(h.state().assets.length, 1);
});

test("equal roles do not cross expert, PA, workspace or cloned-profile ownership", async () => {
  const h = await harness(), published = await h.store.publishExperience(h.input());
  assert.ok(published.ok);
  const own = await prepared(h);
  assert.ok(own.ok);
  if (own.ok && published.ok) assert.deepEqual(own.versionIds, [published.versionId]);

  for (const target of [{ kind: "expert", experienceKey: "experience:other" }, { kind: "personal_agent", experienceKey: identity.experienceKey },
    { kind: "legacy_member", workspace: scope, profileId: "profile:1", memberId: "member:1" }] as const) {
    const result = await prepared(h, target);
    assert.ok(result.ok);
    if (result.ok) assert.equal(result.text, "", "same role is not the same owner");
  }

  const legacy = { kind: "legacy_member", workspace: scope, profileId: "profile:1", memberId: "member:1" } as const;

  assert.ok((await h.store.publishExperience(h.input({ owner: legacy }))).ok);
  const clone = await prepared(h, { ...legacy, profileId: "profile:2" });
  assert.ok(clone.ok);
  if (clone.ok) assert.equal(clone.text, "");

  assert.equal((await prepared(h, { ...legacy, workspace: "workspace:other" })).ok, false);
});

test("temporary experts require their exact authorized draft and task scope, and saved versions cannot receive draft experience", async () => {
  const h = await harness(), draft = { requestId: "expert-request:1", revision: 2 }, useScope = { workspaceId: scope, taskId: "task:2" };

  assert.equal((await h.store.publishExperience(h.input({ expertIdentity: { ...identity, draft } }))).ok, false);
  const published = await h.store.publishExperience(h.input({ expertIdentity: { ...identity, draft }, conditions: { expertDraft: draft, useScope } }));
  assert.ok(published.ok);

  for (const extra of [{}, { expertDraft: { ...draft, revision: 3 }, context: { useScope } },
    { expertDraft: draft, context: { useScope: { ...useScope, taskId: "other-task" } } }]) {
    const result = await prepared(h, owner, extra);
    assert.ok(result.ok);
    if (result.ok) assert.equal(result.text, "");
  }

  const result = await prepared(h, owner, { expertDraft: draft, context: { useScope } });
  assert.ok(result.ok);
  if (result.ok) assert.equal(result.versionIds.length, 1);
});

test("a scoped temporary draft cannot shadow the saved expert's family or another authorized draft branch", async () => {
  const h = await harness(), saved = await h.store.publishExperience(h.input());
  assert.ok(saved.ok);
  const draft = { requestId: "expert-request:branch", revision: 2 }, useScope = { workspaceId: scope, taskId: "task:draft" };
  const temporary = await h.store.publishExperience(h.input({ expertIdentity: { ...identity, draft },
    conditions: { expertDraft: draft, useScope }, practice: "Use the temporary specialist's scoped handoff." }));
  assert.ok(temporary.ok);
  const stable = await prepared(h);
  assert.ok(stable.ok);
  assert.deepEqual(stable.versionIds, [saved.versionId], "temporary publication must not hide saved family guidance");
  const scoped = await prepared(h, owner, { expertDraft: draft, context: { useScope } });
  assert.ok(scoped.ok);
  assert.deepEqual(scoped.versionIds, [temporary.versionId]);
  const nextDraft = { ...draft, revision: 3 };
  const next = await h.store.publishExperience(h.input({ expertIdentity: { ...identity, draft: nextDraft },
    conditions: { expertDraft: nextDraft, useScope }, practice: "Use the revised temporary specialist's scoped handoff." }));
  assert.ok(next.ok);
  const original = await prepared(h, owner, { expertDraft: draft, context: { useScope } });
  assert.ok(original.ok);
  assert.deepEqual(original.versionIds, [temporary.versionId]);
  const revised = await prepared(h, owner, { expertDraft: nextDraft, context: { useScope } });
  assert.ok(revised.ok);
  assert.deepEqual(revised.versionIds, [next.versionId]);
  const foreignTask = await prepared(h, owner, { expertDraft: draft, context: { useScope: { ...useScope, taskId: "other-task" } } });
  assert.ok(foreignTask.ok);
  assert.equal(foreignTask.text, "");
});

test("saved experience follows a stable expert key across configuration versions unless explicitly version-restricted", async () => {
  const h = await harness(), published = await h.store.publishExperience(h.input());
  assert.ok(published.ok);
  const upgraded = await prepared(h, owner, { expertVersion: 2 });
  assert.ok(upgraded.ok);
  assert.deepEqual(upgraded.versionIds, [published.versionId], "same expert configuration upgrade must retain stable-key experience");
  const content = h.state().assets.find(a => a.versionId === published.versionId)?.content;

  assert.ok(isCollaborationExperienceContent(content));
  assert.deepEqual(content.sourceExpert, identity);
  assert.equal(content.expertVersion, undefined);
  const other = await prepared(h, { kind: "expert", experienceKey: "experience:other" }, { expertVersion: 2 });
  assert.ok(other.ok);
  assert.equal(other.text, "");
  const limited = await h.store.publishExperience(h.input({ familyId: "configuration-specific", expertVersion: 1 }));
  assert.ok(limited.ok);
  const versionTwo = await prepared(h, owner, { expertVersion: 2 });
  assert.ok(versionTwo.ok);
  assert.deepEqual(versionTwo.versionIds, [published.versionId]);
  const versionOne = await prepared(h);
  assert.ok(versionOne.ok);
  assert.equal(versionOne.versionIds.length, 2);
  assert.equal((await h.store.publishExperience(h.input({ expertVersion: 2 }))).ok, false, "an explicit restriction must match the actual source identity version");
});

test("historical focused evidence remains usable after resolution; new publication still requires focus and owner-correct lineage", async () => {
  const h = await harness(), first = await h.store.publishExperience(h.input());
  assert.ok(first.ok);
  if (!first.ok) return;

  assert.equal((await h.store.publishExperience(h.input({ owner: { kind: "personal_agent", experienceKey: "pa:1" },
    parentVersion: first.versionId }))).ok, false);
  const issue = h.state().learningIssues![0]!;

  assert.ok((await h.control.decide({ issueId: issue.issueId, expectedRevision: issue.revision, decision: "resolved", reason: "Current problem resolved.", sourceRefs: ["report:1"] })).ok);
  assert.equal((await h.store.publishExperience(h.input({ practice: "Another practice." }))).ok, false);
  const result = await prepared(h);
  assert.ok(result.ok);
  if (result.ok) assert.equal(result.versionIds.length, 1);

  h.reopen();
  assert.ok(normalizeBoardState(h.state()));
  const replayed = await prepared(h);
  assert.ok(replayed.ok);
  if (replayed.ok) assert.equal(replayed.versionIds.length, 1);
});

test("a restrictive latest revision cannot fall back to an older broad card, and cards never truncate", async () => {
  const h = await harness(), first = await h.store.publishExperience(h.input());
  assert.ok(first.ok);
  if (!first.ok) return;
  const next = await h.store.publishExperience(h.input({ parentVersion: first.versionId, conditions: { dependency: "artifact" } }));
  assert.ok(next.ok);
  const unknown = await prepared(h);
  assert.ok(unknown.ok);
  if (unknown.ok) assert.equal(unknown.text, "");
  const match = await prepared(h, owner, { context: { dependency: "artifact" } });
  assert.ok(match.ok);
  if (match.ok && next.ok) assert.deepEqual(match.versionIds, [next.versionId]);
  const tiny = await prepared(h, owner, { context: { dependency: "artifact" }, maxChars: 20 });
  assert.ok(tiny.ok);
  if (tiny.ok) assert.deepEqual([tiny.text, tiny.versionIds], ["", []]);
});

test("historical ownerless cards remain readable data and never enter the owner-specific loader", async () => {
  const h = await harness();
  assert.ok((await h.store.publishExperience(h.input())).ok);
  const current = h.state().assets[0]!;
  const legacyContent = { schema: "collaboration-practice/v1", object: "handoff", problem: "handoff_missing_context", dependency: "artifact",
    requiredFields: ["artifacts", "evidence", "pending", "blockers"], sourceEpisodeIds: ["historical:1"], sourceOutcomeIds: [] };
  const state = { ...h.state(), assets: [{ ...current, versionId: "historical-unowned", content: legacyContent }] };

  assert.ok(normalizeBoardState(state));
  assert.equal(state.assets[0]!.content.schema, "collaboration-practice/v1");
  assert.equal(selectExperience(state, scope, { owner, expertVersion: 1, maxChars: 600 }).text, "");
});

test("load and acknowledged dispatch are distinct; attributed feedback is single-use, owner-bound and replayable", async () => {
  const h = await harness(), published = await h.store.publishExperience(h.input());
  assert.ok(published.ok);
  if (!published.ok) return;

  const base = { owner, versionIds: [published.versionId], receiptId: "load:1", boundary, recordedAt: NOW };

  assert.ok((await h.store.recordLoad(base)).ok);
  assert.equal((await h.store.recordDispatch({ ...base, receiptId: "dispatch:missing-ack" })).ok, false);
  assert.ok((await h.store.recordDispatch({ ...base, receiptId: "dispatch:1", boundary: { ...boundary, configurationRef: "config:1", requestId: "provider:1" } })).ok);
  const feedback = { owner, versionIds: [published.versionId], receiptId: "feedback:1", usageReceiptId: "dispatch:1",
    summary: "The unit reference was useful; artifact quality is still unverified.", sourceRefs: ["report:1"], outcome: "helped" as const, recordedAt: NOW };

  assert.equal((await h.store.recordUseFeedback({ ...feedback, owner: { kind: "personal_agent", experienceKey: identity.experienceKey } })).ok, false);
  assert.ok((await h.store.recordUseFeedback(feedback)).ok);
  assert.ok((await h.store.recordUseFeedback(feedback)).ok);
  assert.equal((await h.store.recordUseFeedback({ ...feedback, receiptId: "feedback:2", outcome: "not_helped" })).ok, false);
  h.reopen();
  assert.ok(normalizeBoardState(h.state()));
  assert.equal(h.state().collaborationRuntimeReceipts!.length, 3);
});

test("real resource query/result receipts share central grant identity and become traceable experience sources", async () => {
  const h = await harness();
  const query: CollaborationResourceReceipt = { schemaVersion: 1, receiptId: "query:1", phase: "resource_query", scope,
    issueId: h.issueId, jobId: h.jobId, grantId: "grant:1", requestId: "resource-call:1", owner: "expert", query: "conversion unit expertise",
    resultRefs: [], summary: "Query the actual expert library.", boundary, recordedAt: NOW };

  assert.ok((await h.writer.record(query)).ok);
  assert.equal((await h.writer.record({ ...query, phase: "resource_result", receiptId: "result:wrong-request", requestId: "other", status: "available", resultRefs: ["expert:found"] })).ok, false);
  const result = { ...query, phase: "resource_result" as const, receiptId: "result:1", status: "available" as const, resultRefs: ["expert:found"] };

  assert.ok((await h.writer.record(result)).ok);
  assert.ok((await h.store.publishExperience(h.input({ sourceRefs: ["result:1", "expert:found"] }))).ok);
  assert.equal((await h.writer.record({ ...result, summary: "Changed result under the same receipt ID." })).ok, false);
});

test("a delayed read cannot return guidance after privacy withdrawal; a missing receipt port stays unavailable", async () => {
  const h = await harness();
  assert.ok((await h.store.publishExperience(h.input())).ok);
  let enabled = true, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const store = createCollaborationExperienceStore({ scope, now: () => NOW, enabled: () => enabled,
    board: { ...h.board, async load() {
      await gate;
      return h.board.load();
    } } });
  const pending = store.prepareExperience({ owner, expertVersion: 1, maxChars: 600 });
  enabled = false;
  release();
  assert.deepEqual(await pending, { ok: false, reason: "collect_disabled" });
  const noPort = createCollaborationExperienceStore({ board: h.board, scope, now: () => NOW });

  assert.deepEqual(await noPort.recordLoad({ owner, versionIds: ["missing"], receiptId: "load:missing", boundary, recordedAt: NOW }), { ok: false, reason: "runtime_receipt_unavailable" });
  const aborted = new AbortController();
  aborted.abort();
  assert.deepEqual(await createExpertExperiencePort({ store: h.store }).load({ ...identity, task: "actual task", maxChars: 600, signal: aborted.signal }), { text: "", versionIds: [] });
});
