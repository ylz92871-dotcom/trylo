import assert from "node:assert/strict";
import test from "node:test";
import { reduce, reduceAll } from "./reducer.js";
import { emptyBoardState, normalizeBoardState } from "./state.js";

/**
 * M1 控制板记账合同：上场/反馈的形状守卫、幂等与旧快照兼容。
 */
function fielding(commandId: string, extra: Record<string, unknown> = {}) {
  return {
    type: "record_method_fielding" as const,
    commandId,
    issuedAt: "2026-09-21T00:00:00.000Z",
    exposureId: "exp-1",
    versionId: "ver:w1",
    proposalId: "prop:w1",
    turnId: "turn-a",
    beat: 1,
    requestId: "req-1",
    scope: "ws",
    ...extra,
  };
}

function feedback(commandId: string, extra: Record<string, unknown> = {}) {
  return {
    type: "record_method_feedback" as const,
    commandId,
    issuedAt: "2026-09-21T00:00:00.000Z",
    versionId: "ver:w1",
    turnId: "turn-a",
    helped: true,
    ...extra,
  };
}

test("M1: fielding with an empty identity is refused, not stored", () => {
  const result = reduce(emptyBoardState(), fielding("c1", { exposureId: "" }));
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "invalid_fielding");
  }
});

test("M1: fielding with a non-positive beat is refused", () => {
  const result = reduce(emptyBoardState(), fielding("c1", { beat: 0 }));
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "invalid_fielding");
  }
});

test("M1: the same fielding command replays idempotent", () => {
  const first = reduce(emptyBoardState(), fielding("c1"));

  assert.equal(first.ok, true);

  if (!first.ok) {
    return;
  }

  assert.equal(first.events.length, 1);
  const second = reduce(first.state, fielding("c1"));

  assert.equal(second.ok, true);

  if (second.ok) {
    assert.equal(second.idempotent, true);
    assert.deepEqual(second.events, []);
    assert.equal(second.state.fieldings.length, 1);
  }
});

test("M1: feedback records helped and survives a second turn", () => {
  // Each turn's feedback attributes against a real fielding of that turn (P1-3:
  // a feedback with no matching fielding is an orphan and is now refused).
  const applied = reduceAll(emptyBoardState(), [
    fielding("c1"),
    fielding("c1b", { exposureId: "exp-b", turnId: "turn-b" }),
    feedback("c2", { helped: true }),
    feedback("c3", { helped: false, turnId: "turn-b" }),
  ]);

  assert.equal(applied.ok, true, JSON.stringify(applied));

  if (applied.ok) {
    assert.equal(applied.state.fieldings.length, 2);
    assert.equal(applied.state.feedbacks.length, 2);
    assert.equal(applied.state.feedbacks[0]?.helped, true);
    assert.equal(applied.state.feedbacks[1]?.helped, false);
  }
});

test("P1-3: an orphan feedback (no matching fielding) is refused by the reducer, not stored", () => {
  // The external review's probe: reduce(emptyBoardState(), orphanFeedback) used to
  // return ok:true. The canonical reducer must reject a feedback that corresponds to
  // no real exposure, so a late/forged/misattributed verdict cannot become a fact.
  const result = reduce(emptyBoardState(), feedback("c2", { helped: true }));

  assert.equal(result.ok, false);

  if (!result.ok) {
    assert.equal(result.reason, "feedback_unattributable");
  }

  assert.equal(result.state.feedbacks.length, 0);
});

test("P1-3: a feedback naming an exposureId that never fielded is refused", () => {
  const withFielding = reduce(emptyBoardState(), fielding("c1"));

  assert.equal(withFielding.ok, true);

  if (!withFielding.ok) {
    return;
  }

  const result = reduce(
    withFielding.state,
    feedback("c2", { helped: true, exposureId: "does-not-exist" }),
  );

  assert.equal(result.ok, false);

  if (!result.ok) {
    assert.equal(result.reason, "feedback_unattributable");
  }
});

test("P1-3: a second feedback for the same exposure is a conflict, even when it agrees", () => {
  const base = reduceAll(emptyBoardState(), [fielding("c1"), feedback("c2", { helped: true })]);

  assert.equal(base.ok, true);

  if (!base.ok) {
    return;
  }

  assert.equal(base.state.feedbacks.length, 1);
  // One exposure carries exactly one verdict: a distinct commandId for the same
  // exposure is refused rather than appending a second, possibly divergent row.
  const again = reduce(base.state, feedback("c3", { helped: true }));

  assert.equal(again.ok, false);

  if (!again.ok) {
    assert.equal(again.reason, "feedback_conflict");
  }

  const opposite = reduce(base.state, feedback("c4", { helped: false }));

  assert.equal(opposite.ok, false);

  if (!opposite.ok) {
    assert.equal(opposite.reason, "feedback_conflict");
  }

  assert.equal(base.state.feedbacks.length, 1, "neither conflicting write is stored");
});

test("P1-3: the exact same feedback command replays idempotent, not as a conflict", () => {
  const base = reduceAll(emptyBoardState(), [fielding("c1"), feedback("c2", { helped: true })]);

  assert.equal(base.ok, true);

  if (!base.ok) {
    return;
  }

  // commandId dedup runs before the relation guard, so a genuine replay of the same
  // command is idempotent success, while a *different* commandId would be a conflict.
  const replayed = reduce(base.state, feedback("c2", { helped: true }));

  assert.equal(replayed.ok, true);

  if (replayed.ok) {
    assert.equal(replayed.idempotent, true);
    assert.equal(replayed.state.feedbacks.length, 1);
  }
});

test("P1-3: two exposures for one version+turn make an exposure-less feedback ambiguous", () => {
  // Two beats fielded the same version in the same turn under different exposures.
  const base = reduceAll(emptyBoardState(), [
    fielding("c1", { exposureId: "exp-1" }),
    fielding("c1b", { exposureId: "exp-2", beat: 2, requestId: "req-2" }),
  ]);

  assert.equal(base.ok, true);

  if (!base.ok) {
    return;
  }

  // Without an exposureId the reducer cannot choose which exposure to attribute to;
  // the old .find() silently took the first. It must now refuse as ambiguous.
  const ambiguous = reduce(base.state, feedback("c2", { helped: true }));

  assert.equal(ambiguous.ok, false);

  if (!ambiguous.ok) {
    assert.equal(ambiguous.reason, "feedback_ambiguous");
  }

  // Naming one exposure disambiguates and is accepted.
  const pinned = reduce(base.state, feedback("c3", { helped: true, exposureId: "exp-2" }));

  assert.equal(pinned.ok, true, JSON.stringify(pinned));

  if (pinned.ok) {
    assert.equal(pinned.state.feedbacks[0]?.exposureId, "exp-2");
  }
});

test("P1-3: an exposure-less feedback against a single fielding resolves and stores the exposureId", () => {
  const base = reduce(emptyBoardState(), fielding("c1"));

  assert.equal(base.ok, true);

  if (!base.ok) {
    return;
  }

  const result = reduce(base.state, feedback("c2", { helped: true }));

  assert.equal(result.ok, true, JSON.stringify(result));

  if (result.ok) {
    // The stored feedback is always traceable to one real exposure, even though the
    // command carried no exposureId.
    assert.equal(result.state.feedbacks[0]?.exposureId, "exp-1");
  }
});

test("M1: old snapshots without fieldings still load as empty ledgers", () => {
  const legacy = {
    ...emptyBoardState(),
    fieldings: undefined,
    feedbacks: undefined,
  } as unknown as ReturnType<typeof emptyBoardState>;
  const normalized = normalizeBoardState(legacy);

  assert.notEqual(normalized, undefined, "missing fields are legacy-empty, not corrupt");

  if (normalized === undefined) {
    return;
  }

  assert.deepEqual(normalized.fieldings, []);
  assert.deepEqual(normalized.feedbacks, []);
  const result = reduce(normalized, fielding("c1"));

  assert.equal(result.ok, true);
});

test("P2-4: a snapshot with an illegal fielding element is rejected, never blind-cast", () => {
  // Each element fails a different guard clause; none may be asserted as legal.
  const illegalFieldings: ReadonlyArray<Record<string, unknown>> = [
    { exposureId: "", versionId: "v", proposalId: "p", turnId: "t", beat: 1, requestId: "r", scope: "s", recordedAt: "x" },
    { exposureId: "e", versionId: "v", proposalId: "p", turnId: "t", beat: 0, requestId: "r", scope: "s", recordedAt: "x" },
    { exposureId: "e", versionId: "v", proposalId: "p", turnId: "t", beat: 1.5, requestId: "r", scope: "s", recordedAt: "x" },
    { exposureId: "e", versionId: "v", proposalId: "p", turnId: "t", requestId: "r", scope: "s", recordedAt: "x" },
  ];
  for (const bad of illegalFieldings) {
    const snapshot = { ...emptyBoardState(), fieldings: [bad] } as unknown as ReturnType<typeof emptyBoardState>;
    assert.equal(normalizeBoardState(snapshot), undefined, JSON.stringify(bad));
  }
});

test("P2-4: a snapshot with an illegal feedback element is rejected, never blind-cast", () => {
  const illegalFeedbacks: ReadonlyArray<Record<string, unknown>> = [
    { versionId: "v", turnId: "t", helped: "yes", recordedAt: "x" },
    { versionId: "", turnId: "t", helped: true, recordedAt: "x" },
    { versionId: "v", turnId: "t", helped: true },
  ];
  for (const bad of illegalFeedbacks) {
    const snapshot = { ...emptyBoardState(), feedbacks: [bad] } as unknown as ReturnType<typeof emptyBoardState>;
    assert.equal(normalizeBoardState(snapshot), undefined, JSON.stringify(bad));
  }
});

test("P2-4: a non-array fieldings value is corrupt, and a legal snapshot still decodes", () => {
  const nonArray = { ...emptyBoardState(), fieldings: {} } as unknown as ReturnType<typeof emptyBoardState>;

  assert.equal(normalizeBoardState(nonArray), undefined);

  const legal = {
    ...emptyBoardState(),
    fieldings: [{
      exposureId: "e", versionId: "v", proposalId: "p", turnId: "t",
      beat: 1, requestId: "r", scope: "s", recordedAt: "x",
    }],
    feedbacks: [{ versionId: "v", turnId: "t", helped: true, recordedAt: "x" }],
  } as unknown as ReturnType<typeof emptyBoardState>;
  const decoded = normalizeBoardState(legal);

  assert.notEqual(decoded, undefined);
  assert.equal(decoded?.fieldings.length, 1);
  assert.equal(decoded?.feedbacks.length, 1);
});
