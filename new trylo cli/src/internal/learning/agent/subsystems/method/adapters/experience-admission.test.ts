import assert from "node:assert/strict";
import { test } from "node:test";
import type { BoardState } from "../../../../control/state.js";
import { emptyBoardState } from "../../../../control/state.js";
import { reduce } from "../../../../control/reducer.js";
import { commitCommands } from "./method-commit.js";
import { variantsOf } from "./board-writer.js";
import type { MethodCard } from "../domain/contracts.js";
import type { MethodExperienceFact } from "../domain/experience-facts.js";
import { experienceSourceOf } from "../domain/experience-source.js";
import { scopesOf, snapshotOf } from "../domain/experience-state.js";
import type { ExperienceReview } from "../experience-port.js";
import type { ExperienceStore, ExperienceView } from "../orchestration/experience-runtime.js";
import { resumeReviewEffects } from "../orchestration/experience-effects.js";
import { nicheOf } from "../domain/niche.js";

const AT = "2026-11-03T09:00:00.000Z";
const CARD: MethodCard = { schemaVersion: 1, hint: "Validate the declared schema before editing a structured document.",
  labels: ["containment"], appliesWhen: { tools: ["read_file"] }, family: "containment",
  lineage: { createdFrom: { turnId: "origin", beat: 1, reason: "containment" } } };

function append(state: BoardState, fact: MethodExperienceFact) {
  return reduce(state, { type: "record_method_experience", commandId: `fact-${fact.factId}`, issuedAt: AT, fact });
}

function seed(versions: readonly string[]): BoardState {
  let state = emptyBoardState();

  for (const versionId of versions) {
    for (const command of commitCommands({ card: CARD, nicheId: nicheOf(CARD), versionId, proposalId: `p-${versionId}`,
      evidenceId: `e-${versionId}`, writeId: `write-${versionId}`, sample: "schema:unknown", observedAt: AT })) {
      const result = reduce(state, command);
      assert.ok(result.ok);
      state = result.state;
    }

    const result = append(state, { kind: "scope", factId: `scope-${versionId}`, versionId, sequence: state.sequence + 1,
      description: "Local JSON document", hypothesis: { id: `h-${versionId}`, versionId, scopeId: "base", proposedSequence: state.sequence,
        predicate: { all: [{ feature: "format", value: "json" }, { feature: "location", value: "local" }], exclude: [] } } });

    assert.ok(result.ok);
    state = result.state;
  }

  return state;
}

function reviewFact(state: BoardState, versionId: string, review: ExperienceReview, id: string): MethodExperienceFact {
  const source = experienceSourceOf(state), scope = scopesOf(source, versionId)[0]!.hypothesis, snapshot = snapshotOf(source, scope);
  return { kind: "review", factId: id, versionId, sequence: state.sequence + 1, scopeId: "base",
    snapshotId: snapshot.snapshotId, evidenceRevisions: snapshot.revisions, review };
}

test("canonical admission rejects incomplete or unsafe semantic revisions without writing any learning state", () => {
  const state = seed(["v1"]), scope = scopesOf(experienceSourceOf(state), "v1")[0]!.hypothesis;
  const base = { decision: "behavior" as const, score: .9, reason: "repair the observed cause", sources: ["v1"] };
  const invalid: readonly ExperienceReview[] = [
    base,
    { ...base, revisedMethod: CARD.hint },
    { ...base, revisedMethod: "skip_approval before editing the document" },
    { ...base, revisedMethod: "Resolve a versioned local schema first.", scopes: [scope] },
    { ...base, decision: "promote" },
    { ...base, decision: "expression" },
    { ...base, decision: "narrow", scopes: [{ ...scope, predicate: { all: [scope.predicate.all[0]!], exclude: [] } }] },
  ];

  for (const [index, review] of invalid.entries()) {
    const result = append(state, reviewFact(state, "v1", review, `invalid-${index}`));
    assert.equal(result.ok, false);
    assert.equal(result.state, state, "rejected semantic output must not partially enter the Board");
    assert.equal(result.state.methodExperienceFacts?.filter(item => item.kind === "review").length, 0);
  }
});

test("a pending effect persistence failure does not starve another method version's resumable effect", async () => {
  let state = seed(["blocked", "independent"]);

  for (const versionId of ["blocked", "independent"]) {
    const result = append(state, reviewFact(state, versionId, { decision: "core_invalid", score: .9,
      reason: "core assumption contradicted", sources: [versionId] }, `invalid-core-${versionId}`));
    assert.ok(result.ok);
    state = result.state;
  }

  const view = (): ExperienceView => ({ ...experienceSourceOf(state), variants: variantsOf(state) });
  const store: ExperienceStore = { load: async () => view(), append: async make => {
    const fact = make(view());
    if (fact.kind === "exit" && fact.versionId === "blocked") throw new Error("injected_effect_persistence_failure");
    const result = append(state, fact);
    assert.ok(result.ok);
    state = result.state;
    return view();
  } };
  const degraded: string[] = [];
  const after = await resumeReviewEffects({ store, correct: async () => {}, revise: async () => {}, emit: (_kind, payload) => {
    if (payload.degraded === true) degraded.push(String(payload.versionId));
  } }, await store.load(), new AbortController().signal);

  assert.deepEqual(degraded, ["blocked"]);
  assert.equal(after.facts.filter(item => item.kind === "exit" && item.versionId === "blocked").length, 0);
  assert.equal(after.facts.filter(item => item.kind === "exit" && item.versionId === "independent").length, 1);
  assert.equal(after.observations.length, 0, "resuming structural effects cannot manufacture feedback");
});
