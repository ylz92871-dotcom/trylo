import assert from "node:assert/strict";
import test from "node:test";
import { reduce } from "../../../../control/reducer.js";
import { emptyBoardState } from "../../../../control/state.js";
import type { BoardStore } from "../../../../control/store-port.js";
import { centralLearningSpent } from "../../../../control/coordination-contract.js";
import { createCollaborationControl } from "../control/index.js";
import { createCollaborationExperienceStore } from "../experience/index.js";
import type { PublishExperienceInput } from "../experience/contracts.js";
import type { ExperienceDraft, LearningAction } from "./contracts.js";
import { createCollaborationWorker } from "./worker.js";

const scope = "workspace:proposal-preflight", NOW = "2026-11-04T00:00:00.000Z";
const owner = { kind: "legacy_member", workspace: scope, profileId: "profile:one", memberId: "worker" } as const;

type Mode = "card" | "owner" | "source" | "io" | "withdrawn" | "board";

const draft = (familyId: string): ExperienceDraft => ({ ownerRef: "member:worker", familyId, situation: "A dependent handoff",
  responsibilities: ["Supply sources"], practice: "Name the artifact and its pending dependencies.", sourceRefs: ["report:preflight"] });

async function fixture(mode: Mode, maxCalls = 2, canonicalPreflight = true) {
  let state = emptyBoardState(), calls = 0, publications = 0, enabled = true;
  const materials: unknown[] = [];
  const board: Pick<BoardStore, "load" | "apply"> = { async load() { return { ok: true, state, generation: 0 }; }, async apply(command) {
    const result = reduce(state, command);
    if (result.ok) state = result.state;
    return result;
  } };
  const store = createCollaborationExperienceStore({ board, scope, now: () => NOW, enabled: () => enabled });
  const worker = createCollaborationWorker({ board, scope, now: () => NOW, context: async () => ({ owners: ["member:worker"] }),
    resources: { async query() { throw new Error("This preflight candidate does not query resources."); } },
    model: { async decide(input) {
      calls += 1;
      materials.push(structuredClone(input.material));

      if (calls > 1) assert.equal(state.assets.length, 0, "all invalid candidates must be rejected before the first experience write");

      const reservationId = `model:${input.claimId}:${calls}`;

      assert.ok((await input.funding.reserve({ reservationId, maxTokens: 100 })).ok);
      assert.ok((await input.funding.settle({ reservationId, usage: { kind: "reported", totalTokens: 40 } })).ok);
      let second = draft("review-handoff");

      if (calls === 1 && mode === "card") second = { ...second, practice: "INVALID_CANDIDATE_BODY_MUST_NOT_REPEAT" + "x".repeat(650) };

      if (calls === 1 && mode === "owner") second = { ...second, ownerRef: "member:invented" };

      if (calls === 1 && mode === "source") second = { ...second, sourceRefs: ["source:invented"] };

      const action: LearningAction = { kind: "propose", familyId: "handoff", title: "A conditional handoff trial", summary: "Observe a concrete handoff repair.",
        sourceRefs: ["report:preflight"], adjustments: [], needs: [], experiences: [draft("source-handoff"), second] };

      return { ok: true, action };
    } },
    async experienceInput(issueId, value) {
      if (value.ownerRef !== "member:worker") return { ok: false, reason: "experience_owner_unknown" };
      const input: PublishExperienceInput = { issueId, owner, familyId: value.familyId, situation: value.situation,
        responsibilities: value.responsibilities, practice: value.practice, sourceRefs: value.sourceRefs };
      return { ok: true, input };
    },
    ...(canonicalPreflight ? { async preflightExperience(input: PublishExperienceInput) {
      if (mode === "withdrawn") enabled = false;
      if (mode === "board") return { ok: false as const, reason: "board_unavailable" };
      return store.preflightExperience(input);
    } } : {}),
    async publishExperience(input) {
      publications += 1;
      if (mode === "io" && publications === 2) return { ok: false, reason: "board_unavailable" };
      return store.publishExperience(input);
    } });
  const control = createCollaborationControl({ board, worker, now: () => NOW, ownerId: "preflight-owner" });
  const reported = await control.report({ scope, problemKey: "handoff", report: { reportId: "report:preflight",
    source: { teamRunId: "team:preflight", taskId: "task:one", memberId: "worker" }, facts: ["The handoff lacked source and pending references."], evidenceRefs: [] } });
  assert.ok(reported.ok);
  const focused = await control.decide({ issueId: reported.issue.issueId, expectedRevision: reported.issue.revision,
    decision: "focused_learning", reason: "PA selected a reusable coordination improvement.", sourceRefs: ["report:preflight"] });
  assert.ok(focused.ok);
  assert.ok((await control.fund({ issueId: focused.issue.issueId, expectedRevision: focused.issue.revision, grantId: "grant:original-preflight",
    allowance: { schemaVersion: 2, unit: "total_model_tokens", maxCalls, maxSteps: maxCalls, maxTokens: 1000, maxPromptChars: 40000 } })).ok);

  return { control, state: () => state, calls: () => calls, publications: () => publications, materials };
}

test("a bad second draft is diagnosed before any publication and regenerated only inside its original claim", async () => {
  const h = await fixture("card"), result = await h.control.dispatch({ scope });
  assert.ok(result.ok);
  assert.equal(result.status, "completed");
  assert.equal(h.calls(), 2);
  assert.equal(h.publications(), 2);
  assert.equal(h.state().assets.length, 3);
  const grant = h.state().centralLearningGrants![0]!;

  assert.equal(h.state().centralLearningGrants!.length, 1);
  assert.equal(h.state().jobs.length, 1);
  assert.equal(grant.grantId, "grant:original-preflight");
  assert.deepEqual(centralLearningSpent(grant), { tokens: 80, calls: 2, steps: 2 });
  assert.equal(new Set(grant.reservations.map(item => item.claimId)).size, 1);
  const feedback = JSON.stringify(h.materials[1]);
  assert.match(feedback, /experience_input_invalid/);
  assert.match(feedback, /experiences\[1\]/);
  assert.match(feedback, /renderedCardChars/);
  assert.match(feedback, /maxCardChars":600/);
  assert.doesNotMatch(feedback, /INVALID_CANDIDATE_BODY_MUST_NOT_REPEAT/);
});

test("unknown owners and references receive bounded repair without constructing owners, and legacy callers still reject oversized cards first", async () => {
  for (const mode of ["owner", "source"] as const) {
    const h = await fixture(mode), result = await h.control.dispatch({ scope });
    assert.ok(result.ok);
    assert.equal(result.status, "completed");
    assert.equal(h.calls(), 2);
    assert.equal(h.publications(), 2);
    assert.equal(h.state().centralLearningGrants!.length, 1);
  }
  const legacy = await fixture("card", 2, false), result = await legacy.control.dispatch({ scope });
  assert.ok(result.ok);
  assert.equal(result.status, "completed");
  assert.equal(legacy.calls(), 2);
  assert.equal(legacy.publications(), 2);
});

test("exhausted grants and collection or Board failures never turn into a fresh repair allowance", async () => {
  const exhausted = await fixture("card", 1), failed = await exhausted.control.dispatch({ scope });
  assert.ok(failed.ok);
  assert.equal(failed.status, "failed");
  assert.equal(failed.result?.kind, "failed");
  if (failed.result?.kind === "failed") assert.equal(failed.result.reason, "experience_input_invalid");

  assert.equal(exhausted.calls(), 1);
  assert.equal(exhausted.publications(), 0);
  assert.equal(exhausted.state().assets.length, 0);

  for (const mode of ["withdrawn", "board"] as const) {
    const h = await fixture(mode), result = await h.control.dispatch({ scope });
    assert.ok(result.ok);
    assert.equal(result.status, "failed");
    assert.equal(h.calls(), 1);
    assert.equal(h.publications(), 0);
    assert.equal(h.state().centralLearningGrants!.length, 1);
    if (result.result?.kind === "failed") assert.equal(result.result.reason, mode === "withdrawn" ? "collect_disabled" : "board_unavailable");
  }
});

test("an IO failure after the first valid publication preserves that history and never retries the whole batch", async () => {
  const h = await fixture("io"), result = await h.control.dispatch({ scope });
  assert.ok(result.ok);
  assert.equal(result.status, "failed");
  assert.equal(h.calls(), 1);
  assert.equal(h.publications(), 2);
  assert.equal(h.state().assets.length, 1);
  assert.equal(h.state().proposals.length, 1);
  assert.equal(h.state().tombstones.length, 0);
  if (result.result?.kind === "failed") assert.equal(result.result.reason, "board_unavailable");
});
