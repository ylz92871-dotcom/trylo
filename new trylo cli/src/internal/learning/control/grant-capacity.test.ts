import assert from "node:assert/strict";
import test from "node:test";
import { MAX_LEARNING_GRANT_FACTS, type LearningGrantDraft, type LearningGrantFact } from "./grant-contract.js";
import { learningGrantSnapshots } from "./grant-state.js";
import { reduce } from "./reducer.js";
import { emptyBoardState, type BoardState } from "./state.js";

const open = (grantId: string): LearningGrantDraft => ({ schemaVersion: 1, kind: "open", grantId, subsystem: "skill",
  workspaceId: "workspace-a", sourceRef: `skill-command:${grantId}`, allowance: { maxCalls: 1, maxOutputTokens: 10 } });
const reserve = (grantId: string): LearningGrantDraft => ({ schemaVersion: 1, kind: "reserve", grantId, reservationId: "r1", maxOutputTokens: 10 });

function nearCapacity(seed: readonly LearningGrantDraft[], count: number): BoardState {
  const facts: LearningGrantFact[] = seed.map((fact, index) => ({ ...fact, boardSequence: index + 1 }));
  while (facts.length < count) facts.push({ ...open(`padding-${facts.length}`), boardSequence: facts.length + 1 });
  return { ...emptyBoardState(), sequence: count, learningGrantFacts: facts };
}

const apply = (state: BoardState, fact: LearningGrantDraft) => reduce(state, { type: "record_learning_grant_fact", fact,
  commandId: `${fact.grantId}:${fact.kind}`, issuedAt: "2026-11-03T00:00:00Z" });

test("reserve cannot consume the final fact slot needed for its own durable settlement", () => {
  const state = nearCapacity([open("grant-a")], MAX_LEARNING_GRANT_FACTS - 1);
  const result = apply(state, reserve("grant-a"));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "learning_grant_capacity");
  assert.equal(state.learningGrantFacts?.length, MAX_LEARNING_GRANT_FACTS - 1);
});

test("open reserve and close cannot consume another in-flight settlement slot; final reported cost still persists", () => {
  let state = nearCapacity([open("grant-a"), reserve("grant-a"), open("grant-b")], MAX_LEARNING_GRANT_FACTS - 2);
  const another = apply(state, reserve("grant-b"));
  assert.equal(another.ok, false);

  if (!another.ok) assert.equal(another.reason, "learning_grant_capacity");

  const admitted = apply(state, open("last-open"));
  assert.ok(admitted.ok);
  state = admitted.state;

  for (const fact of [open("cannot-open"), { schemaVersion: 1, kind: "close", grantId: "grant-a", reason: "completed" } satisfies LearningGrantDraft]) {
    const blocked = apply(state, fact);
    assert.equal(blocked.ok, false);
    if (!blocked.ok) assert.equal(blocked.reason, "learning_grant_capacity");
  }

  const settled = apply(state, { schemaVersion: 1, kind: "settle", grantId: "grant-a", reservationId: "r1",
    usage: { kind: "reported", inputTokens: 2, outputTokens: 4, totalTokens: 6 } });

  assert.ok(settled.ok);
  assert.equal(settled.state.learningGrantFacts?.length, MAX_LEARNING_GRANT_FACTS);
  const snapshot = learningGrantSnapshots(settled.state.learningGrantFacts ?? [])?.get("grant-a");

  assert.equal(snapshot?.reportedOutputTokens, 4);
  assert.equal(snapshot?.status, "open");
});
