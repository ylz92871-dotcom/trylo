import assert from "node:assert/strict";
import test from "node:test";
import { toExecutionFact } from "./adapter.js";
import { createJournal } from "./index.js";
import { observationLeaksForbidden, projectFacts, type ExecutionFact } from "./projection.js";

const SECRET = "sk-secret-value-123";
const BODY = "user private transcript body";

function fact(extra: Partial<ExecutionFact> = {}): ExecutionFact {
  const base: ExecutionFact = {
    eventId: extra.eventId ?? "e1",
    kind: extra.kind ?? "turn_end",
    occurredAt: extra.occurredAt ?? "2026-09-12T00:00:00.000Z",
    scope: extra.scope ?? "user",
    taskFamily: extra.taskFamily ?? "edit",
    snapshotId: extra.snapshotId ?? "snap-1",
    assetVersions: extra.assetVersions ?? { user_rule: "v1" },
    outcome: extra.outcome ?? "completed",
    latencyMs: extra.latencyMs ?? 10,
    tokenCost: extra.tokenCost ?? 3,
    causalRefs: extra.causalRefs ?? ["e1"],
    rawBody: extra.rawBody ?? BODY,
    secret: extra.secret ?? SECRET,
  };

  if (extra.verdict === undefined && !("verdict" in extra)) {
    return { ...base, verdict: "pass" };
  }

  if (extra.verdict === undefined) {
    return base;
  }

  return { ...base, verdict: extra.verdict };
}

test("collect=false never emits a learning observation", () => {
  const journal = createJournal();

  journal.recordFact(fact());
  const projected = journal.projectLearning({ collect: false });

  assert.equal(projected.ok, true);

  if (projected.ok) {
    assert.deepEqual(projected.observations, []);
  }
});

test("collect=true keeps whitelist fields and drops body/secret", () => {
  const projected = projectFacts([fact()], true);

  assert.equal(projected.ok, true);

  if (!projected.ok) {
    return;
  }

  const observation = projected.observations[0];

  assert.ok(observation);
  assert.equal(observation.outcome, "completed");
  assert.equal(observation.verdict, "pass");
  assert.equal(observation.snapshotRef, "snap-1");
  assert.equal(observationLeaksForbidden(observation, fact()), false);
  assert.equal(JSON.stringify(observation).includes(SECRET), false);
  assert.equal(JSON.stringify(observation).includes(BODY), false);
});

test("tombstone removes the observation without replaying the body", () => {
  const journal = createJournal();

  journal.recordFact(fact());
  journal.tombstone("e1");
  const projected = journal.projectLearning({ collect: true });

  assert.equal(projected.ok, true);

  if (projected.ok) {
    assert.deepEqual(projected.observations, []);
  }
});

test("completed outcome is not rewritten into a verifier pass by the projector", () => {
  const projected = projectFacts([fact({ outcome: "completed", verdict: undefined })], true);
  assert.equal(projected.ok, true);
  if (projected.ok) {
    assert.equal(projected.observations[0]?.outcome, "completed");
    assert.equal("verdict" in (projected.observations[0] ?? {}), false);
  }
});

test("canonical adapter copies whitelist fields and drops raw body", () => {
  const fact = toExecutionFact({
    eventId: "e9",
    kind: "turn_end",
    occurredAt: "2026-09-12T00:00:00.000Z",
    snapshotId: "snap-9",
    outcome: "completed",
    verdict: "fail",
    rawBody: BODY,
    secret: SECRET,
    reason: "exit 1",
  });

  assert.equal(fact.snapshotId, "snap-9");
  assert.equal(fact.outcome, "completed");
  assert.equal(fact.reason, "exit 1");
  assert.equal("rawBody" in fact, false);
  assert.equal("secret" in fact, false);
  const projected = projectFacts([fact], true);

  assert.equal(projected.ok, true);

  if (projected.ok) {
    assert.equal(projected.observations[0]?.reason, "exit 1");
    assert.equal(projected.observations[0]?.inputRef, "e9");
    assert.equal(projected.observations[0]?.privacyClass, "summary");
    assert.equal(JSON.stringify(projected.observations[0]).includes(BODY), false);
  }
});

test("retention tombstones overflow observations", () => {
  const journal = createJournal({ maxObservations: 1 });

  journal.recordFact(fact({ eventId: "old" }));
  journal.recordFact(fact({ eventId: "new" }));
  const projected = journal.projectLearning({ collect: true });

  assert.equal(projected.ok, true);

  if (projected.ok) {
    assert.equal(projected.observations.length, 1);
    assert.equal(projected.observations[0]?.observationId, "obs:new");
  }
});

test("projection failure is a structured degraded result", () => {
  const exploding: ExecutionFact[] = [];

  Object.defineProperty(exploding, "map", {
    value: () => {
      throw new Error("boom");
    },
  });
  const projected = projectFacts(exploding, true);

  assert.equal(projected.ok, false);

  if (!projected.ok) {
    assert.equal(projected.reason, "board_unavailable");
  }
});
