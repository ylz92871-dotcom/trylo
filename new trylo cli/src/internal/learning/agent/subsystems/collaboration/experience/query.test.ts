import assert from "node:assert/strict";
import test from "node:test";
import { emptyBoardState } from "../../../../control/state.js";
import { reduce } from "../../../../control/reducer.js";
import type { BoardStore } from "../../../../control/store-port.js";
import { createCollaborationControl } from "../control/index.js";
import type { ExpertIdentity } from "../../../../../subagent/experts/index.js";
import { createCollaborationExperienceStore } from "./store.js";
import type { PrepareExperienceInput, PublishExperienceInput } from "./contracts.js";

const NOW = "2026-11-04T00:00:00.000Z", scope = "workspace:experience-query";
const identity: ExpertIdentity = { expertId: "expert:handoff", version: 1, experienceKey: "experience:handoff" };
const owner = { kind: "expert" as const, experienceKey: identity.experienceKey };
const context: PrepareExperienceInput = { owner, expertVersion: 1, maxChars: 600, context: { surface: "code" } };

async function harness() {
  let state = emptyBoardState(), writes = 0;
  const board: Pick<BoardStore, "load" | "apply"> = { async load() { return { ok: true, state, generation: 0 }; }, async apply(command) {
    writes++;
    const result = reduce(state, command);
    if (result.ok) state = result.state;
    return result;
  } };
  const control = createCollaborationControl({ board, now: () => NOW, ownerId: "experience-query-contract-owner" });
  const report = await control.report({ scope, problemKey: "specific-handoff", report: { reportId: "report:handoff",
    source: { teamRunId: "team:query", taskId: "task:query", memberId: "member:query" },
    facts: ["The downstream consumer lacked an artifact contract."], evidenceRefs: ["artifact:contract"] } });

  assert.ok(report.ok);
  const focused = await control.decide({ issueId: report.issue.issueId, expectedRevision: report.issue.revision,
    decision: "focused_learning", reason: "PA is investigating the reusable coordination gap.", sourceRefs: ["report:handoff"] });

  assert.ok(focused.ok);
  const store = createCollaborationExperienceStore({ board, scope, now: () => NOW });
  const publish = async (patch: Partial<PublishExperienceInput> = {}) => {
    const result = await store.publishExperience({ issueId: report.issue.issueId, owner, expertIdentity: identity,
      familyId: "artifact-handoff", situation: "Share an artifact with a consumer", responsibilities: ["artifact producer"],
      practice: "Share the exact input and output contract, pending work, and dependencies.", sourceRefs: ["report:handoff"], ...patch });
    assert.ok(result.ok);
    return result;
  };

  return { board, store, publish, writes: () => writes, state: () => state,
    replaceState: (next: typeof state) => { state = next; } };
}

test("discovery explains missing runtime conditions without loading or adopting a constrained practice", async () => {
  const h = await harness(), published = await h.publish({ conditions: { dependency: "artifact", responsibility: "artifact producer" } });
  const before = h.writes(), selected = await h.store.prepareExperience(context), found = await h.store.inspectExperience(context);

  assert.ok(selected.ok && found.ok);
  assert.deepEqual(selected.versionIds, []);
  assert.equal(found.mode, "discovery_only");
  assert.equal(found.items[0]?.versionId, published.versionId);
  assert.deepEqual(found.items[0]?.applicability, { state: "missing_context", missing: ["dependency", "responsibility"] });
  assert.match(found.items[0]?.card ?? "", /pending work/);
  assert.equal(h.writes(), before);
  assert.deepEqual(h.state().collaborationRuntimeReceipts ?? [], []);
});

test("discovery exposes known contextual conflicts only to the owner and ranks a bounded reusable catalogue", async () => {
  const h = await harness(), matching = await h.publish({ conditions: { dependency: "artifact" } });

  await h.publish({ familyId: "review-boundary", situation: "Independent review", practice: "Use an independent consumer before acceptance." });
  const conflict = await h.store.inspectExperience({ ...context, context: { dependency: "independent" } }, { text: "pending", limit: 1 });

  assert.ok(conflict.ok);
  assert.equal(conflict.items.length, 1);
  assert.equal(conflict.omittedCount, 1);
  assert.equal(conflict.items[0]?.versionId, matching.versionId);
  assert.deepEqual(conflict.items[0]?.applicability, { state: "incompatible", mismatches: ["dependency"], missing: [] });
  const eligibleContext = { ...context, context: { dependency: "artifact" as const } };
  const eligible = await h.store.inspectExperience(eligibleContext, { text: "pending" });
  const selected = await h.store.prepareExperience(eligibleContext);
  assert.ok(eligible.ok && selected.ok);
  assert.equal(eligible.items[0]?.applicability.state, "eligible");
  assert.ok(selected.versionIds.includes(matching.versionId));
  const miss = await h.store.inspectExperience(context, { text: "unrelated natural language question" });

  assert.ok(miss.ok);
  assert.equal(miss.items.length, 2, "lexical mismatch is not proof of an empty owner catalogue");
  const foreign = await h.store.inspectExperience({ ...context, owner: { kind: "expert", experienceKey: "experience:other" } });

  assert.ok(foreign.ok);
  assert.deepEqual(foreign.items, []);
});

test("temporary experience content requires the exact draft and task scope even during discovery", async () => {
  const h = await harness(), saved = await h.publish();
  const draft = { requestId: "request:temporary", revision: 2 }, useScope = { workspaceId: scope, taskId: "task:temporary" };
  const temporary = await h.publish({ expertIdentity: { ...identity, draft },
    conditions: { expertDraft: draft, useScope }, practice: "Temporary artifact contract guidance." });

  for (const input of [context, { ...context, expertDraft: draft },
    { ...context, expertDraft: { ...draft, revision: 3 }, context: { useScope } },
    { ...context, expertDraft: draft, context: { useScope: { ...useScope, taskId: "task:foreign" } } }]) {
    const found = await h.store.inspectExperience(input);
    assert.ok(found.ok);
    assert.deepEqual(found.items.map(item => item.versionId), [saved.versionId]);
  }

  const authorized = await h.store.inspectExperience({ ...context, expertDraft: draft, context: { useScope } });

  assert.ok(authorized.ok);
  assert.ok(authorized.items.some(item => item.versionId === temporary.versionId));
  assert.equal(authorized.items.find(item => item.versionId === temporary.versionId)?.applicability.state, "eligible");
});

test("discovery keeps newest-family and source-validity rules instead of resurrecting broad old advice", async () => {
  const h = await harness(), first = await h.publish(), latest = await h.publish({ parentVersion: first.versionId, conditions: { dependency: "artifact" } });
  const found = await h.store.inspectExperience(context);
  assert.ok(found.ok);
  assert.deepEqual(found.items.map(item => item.versionId), [latest.versionId]);
  h.replaceState({ ...h.state(), learningIssues: [] });
  const invalidSource = await h.store.inspectExperience(context);
  assert.ok(invalidSource.ok);
  assert.deepEqual(invalidSource.items, []);
});

test("query validation and privacy withdrawal fail closed without consulting unrelated stores", async () => {
  const h = await harness();
  await h.publish();

  for (const query of [{ limit: 0 }, { limit: 13 }, { limit: 1.5 }, { text: "x".repeat(2001) }]) {
    assert.deepEqual(await h.store.inspectExperience(context, query), { ok: false, reason: "experience_context_invalid" });
  }

  let enabled = true, release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const delayed = createCollaborationExperienceStore({ scope, now: () => NOW, enabled: () => enabled,
    board: { ...h.board, async load() {
      await wait;
      return h.board.load();
    } } });
  const pending = delayed.inspectExperience(context);
  enabled = false;
  release();
  assert.deepEqual(await pending, { ok: false, reason: "collect_disabled" });
});
