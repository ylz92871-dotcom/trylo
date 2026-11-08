import test from "node:test";
import assert from "node:assert/strict";
import type { CentralLearningGrant } from "../coordination-contract.js";
import type { CentralResponseCost } from "./prediction-input.js";
import { projectCentralStageCost, summarizeCentralStageCosts } from "./prediction-cost.js";

function grant(): CentralLearningGrant {
  return { schemaVersion: 2, grantId: "grant:one", issueId: "issue:one", scope: "scope:one", jobId: "job:one", domain: "tool",
    focusRevision: 1, allowance: { schemaVersion: 2, unit: "total_model_tokens", maxTokens: 1000,
      maxCalls: 4, maxSteps: 4, maxPromptChars: 1000 }, steps: 3, status: "open", reservations: [
      { reservationId: "old", claimId: "claim:old", maxTokens: 500, state: "settled", usage: { kind: "unknown", reason: "missing" } },
      { reservationId: "stage:one", claimId: "claim:new", maxTokens: 100, state: "settled", usage: { kind: "reported", totalTokens: 20 } },
      { reservationId: "stage:two", claimId: "claim:new", maxTokens: 100, state: "settled", usage: { kind: "reported", totalTokens: 30 } },
    ] };
}

function projection(boundary: Parameters<typeof projectCentralStageCost>[0]["boundary"]) {
  return projectCentralStageCost({ grant: grant(), reservationIds: ["stage:one", "stage:two"], boundary, sourceRef: "usage:stage" });
}

test("complete stage projection uses actual selected bills and excludes lifetime commitments", () => {
  const source = grant(), original = JSON.stringify(source);
  const result = projectCentralStageCost({ grant: source, reservationIds: ["stage:one", "stage:two"],
    boundary: { kind: "complete" }, sourceRef: "usage:stage" });
  assert.deepEqual(result, { status: "ready", cost: { status: "reported", grantId: "grant:one", sourceRef: "usage:stage",
    resources: { tokens: 50, calls: 2, steps: 2 } } });
  assert.equal(JSON.stringify(source), original);
});

test("pending, unknown and overrun cannot turn settled reported tokens into a final bill", () => {
  for (const boundary of [{ kind: "pending" }, { kind: "overrun" }, { kind: "unknown", reason: "tail_missing" }] as const) {
    const result = projection(boundary);
    assert.equal(result.status, "ready");
    if (result.status === "ready") assert.equal(result.cost.status, "unknown");
  }

  const source = grant(), overrun: CentralLearningGrant = { ...source, reservations: source.reservations.map(row =>
    row.reservationId === "stage:two" ? { ...row, usage: { kind: "reported", totalTokens: 101 } } : row) };
  const result = projectCentralStageCost({ grant: overrun, reservationIds: ["stage:two"], boundary: { kind: "complete" }, sourceRef: "usage:overrun" });

  assert.equal(result.status === "ready" && result.cost.status, "unknown");
});

test("complete boundary still requires every selected reservation to be settled and reported", () => {
  const unknown = projectCentralStageCost({ grant: grant(), reservationIds: ["old", "stage:one"],
    boundary: { kind: "complete" }, sourceRef: "usage:stage" });

  assert.equal(unknown.status === "ready" && unknown.cost.status, "unknown");
  const source = grant(), pending: CentralLearningGrant = { ...source, reservations: source.reservations.map(row =>
    row.reservationId === "stage:two" ? { reservationId: row.reservationId, claimId: row.claimId, maxTokens: row.maxTokens, state: "reserved" } : row) };
  const result = projectCentralStageCost({ grant: pending, reservationIds: ["stage:one", "stage:two"],
    boundary: { kind: "complete" }, sourceRef: "usage:stage" });

  assert.equal(result.status === "ready" && result.cost.status, "unknown");
});

test("invalid reservation identities are engineering failures while a closed empty stage costs zero", () => {
  for (const reservationIds of [["stage:one", "stage:one"], ["missing"], [""]]) {
    assert.equal(projectCentralStageCost({ grant: grant(), reservationIds, boundary: { kind: "complete" }, sourceRef: "usage:stage" }).status, "invalid");
  }
  const empty = projectCentralStageCost({ grant: grant(), reservationIds: [], boundary: { kind: "complete" }, sourceRef: "usage:empty" });
  assert.equal(empty.status, "ready");
  if (empty.status === "ready" && empty.cost.status === "reported") assert.deepEqual(empty.cost.resources, { tokens: 0, calls: 0, steps: 0 });
});

function cost(tokens: number): CentralResponseCost {
  return { status: "reported", grantId: "grant:one", sourceRef: `usage:${tokens}`, resources: { tokens, calls: 1, steps: 1 } };
}

test("integer receipt moments retain unknown counts and respect the selected stratum", () => {
  const result = summarizeCentralStageCosts({ stratumRef: "stratum:a", history: [
    { unitId: "a", stratumRef: "stratum:a", cost: cost(10) },
    { unitId: "b", stratumRef: "stratum:a", cost: cost(30) },
    { unitId: "c", stratumRef: "stratum:a", cost: { status: "unknown", grantId: "grant:one", sourceRef: "usage:unknown", reason: "pending" } },
    { unitId: "d", stratumRef: "stratum:b", cost: cost(900) },
  ] });

  assert.equal(result.status, "ready");

  if (result.status !== "ready") return;

  assert.deepEqual(result.value.mean, { tokens: 20, calls: 1, steps: 1 });
  assert.deepEqual(result.value.sampleVariance, { tokens: 200, calls: 0, steps: 0 });
  assert.equal(result.value.reportedCount, 2);
  assert.equal(result.value.unknownCount, 1);
  assert.deepEqual(result.value.unitIds, ["a", "b"]);
  assert.deepEqual(result.value.unknownUnitIds, ["c"]);
  assert.deepEqual(result.value.sourceRefs, ["usage:10", "usage:30", "usage:unknown"]);
});

test("absent and single cost samples never fabricate zero variance or missing zero bills", () => {
  const empty = summarizeCentralStageCosts({ stratumRef: "s", history: [] });
  assert.equal(empty.status, "ready");
  if (empty.status === "ready") {
    assert.equal(empty.value.status, "no_data");
    assert.equal(empty.value.mean, null);
    assert.equal(empty.value.sampleVariance, null);
  }
  const one = summarizeCentralStageCosts({ stratumRef: "s", history: [{ unitId: "a", stratumRef: "s", cost: cost(0) }] });
  if (one.status !== "ready") assert.fail(one.reason);
  assert.deepEqual(one.value.mean, { tokens: 0, calls: 1, steps: 1 });
  assert.equal(one.value.sampleVariance, null);
});

test("duplicate episode costs and malformed integer receipts are rejected", () => {
  const row = { unitId: "a", stratumRef: "s", cost: cost(10) };
  assert.equal(summarizeCentralStageCosts({ stratumRef: "s", history: [row, row] }).status, "invalid");
  assert.equal(summarizeCentralStageCosts({ stratumRef: "s", history: [{ ...row, cost: cost(0.5) }] }).status, "invalid");
});
