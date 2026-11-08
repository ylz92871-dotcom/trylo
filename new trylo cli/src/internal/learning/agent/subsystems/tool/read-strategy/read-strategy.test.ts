import assert from "node:assert/strict";
import test from "node:test";
import { emptyBoardState, type BoardState } from "../../../../control/state.js";
import { contentHashOf } from "../../../../control/hash.js";
import type { RewardExposure, RewardFeedback, RewardRecords } from "../../../../reward/contracts.js";
import { READ_STRATEGY_COST_METRIC, READ_STRATEGY_DECISION_POINT, learnReadStrategy, selectReadStrategy,
  parseReadStrategyPolicy, latestReadStrategyAsset, readStrategyEnvironment, type ReadStrategyConditions,
  type ReadStrategyPath, type ReadStrategyPolicy } from "./index.js";

const small: ReadStrategyConditions = { schemaVersion: 1, fileSize: "small", range: "bounded", streaming: true };
const large: ReadStrategyConditions = { ...small, fileSize: "large" };
const request = { domain: "tool" as const, scope: "tool-read-contract", requestId: "checked-read", issuedAt: "2026-11-03T00:00:00.000Z",
  budget: { maxObservations: 100 } };

function sample(id: string, conditions: ReadStrategyConditions, path: ReadStrategyPath, cost: number): RewardRecords {
  const source = { sessionId: "checked-file", turnId: `turn-${id}`, attemptId: "attempt", eventId: id };
  const target = { kind: "tool_read_path", id: path, version: "1" };
  const exposure: RewardExposure = { schemaVersion: 1, id: `exposure-${id}`, source, occurredAt: 1, targets: [target],
    context: { scope: request.scope, taskFamily: READ_STRATEGY_DECISION_POINT, environment: readStrategyEnvironment(conditions), metric: READ_STRATEGY_COST_METRIC },
    predictions: [{ target, estimate: { mean: 0, variance: 1 } }] };
  const feedback: RewardFeedback = { schemaVersion: 1, id: `feedback-${id}`, exposureId: exposure.id, source: { ...source, eventId: `check-${id}` },
    origin: "environment", evidenceIds: [`tool-read:verified:${id}`], observedAt: 2,
    outcome: { kind: "measured", value: cost, confidence: 1, noiseVariance: 0.01 }, attribution: { kind: "linked", shares: [{ target, share: 1 }] } };

  return { exposures: [exposure], feedbacks: [feedback] };
}

function stateOf(...rows: RewardRecords[]): BoardState {
  return { ...emptyBoardState(), sequence: 20, rewardExposures: rows.flatMap(row => row.exposures), rewardFeedbacks: rows.flatMap(row => row.feedbacks) };
}

const records = (state: BoardState): RewardRecords => ({ exposures: state.rewardExposures ?? [], feedbacks: state.rewardFeedbacks ?? [] });

function checked() {
  return stateOf(sample("sw1", small, "whole", 10), sample("sw2", small, "whole", 12), sample("ss1", small, "stream", 90), sample("ss2", small, "stream", 100),
    sample("lw1", large, "whole", 900), sample("lw2", large, "whole", 950), sample("ls1", large, "stream", 80), sample("ls2", large, "stream", 90));
}

function policy(state = checked()): ReadStrategyPolicy {
  const learned = learnReadStrategy(state, request);
  assert.equal(learned.status, "learned");
  assert.ok(learned.policy);
  return learned.policy;
}

test("tool read learning uses its owned schema and transfers checked choices to matching conditions", () => {
  const state = checked(), learned = policy(state);
  assert.equal(learned.schemaVersion, 2);
  assert.equal(learned.owner, "tool.read-strategy");
  assert.equal(READ_STRATEGY_COST_METRIC.id, "tool.read.cost");
  assert.equal(READ_STRATEGY_COST_METRIC.version, "2");
  assert.equal(selectReadStrategy(learned, { scope: request.scope, conditions: small }, records(state)).path, "whole");
  assert.equal(selectReadStrategy(learned, { scope: request.scope, conditions: large }, records(state)).path, "stream");
  assert.deepEqual(parseReadStrategyPolicy(JSON.stringify(learned)), learned);
});

test("legacy routing policy formats, unrelated owners and permission fields never parse as tool strategies", () => {
  const current = policy(), legacy: Record<string, unknown> = { ...current, schemaVersion: 1 };
  delete legacy.owner;
  for (const invalid of [legacy, { ...current, owner: "routing" }, { ...current, schemaVersion: 1 },
    { ...current, allowNetwork: true }, { ...current, owner: undefined }]) assert.equal(parseReadStrategyPolicy(JSON.stringify(invalid)), undefined);
});

test("legacy routing metrics and completion or model assertions do not establish checked tool quality", () => {
  const current = checked();
  const oldMetric = current.rewardExposures!.map(row => ({ ...row, context: { ...row.context,
    metric: { ...READ_STRATEGY_COST_METRIC, id: "routing.read.cost", version: "1" } } }));

  assert.equal(learnReadStrategy({ ...current, rewardExposures: oldMetric }, request).status, "waiting_evidence");
  const completed = current.rewardFeedbacks!.map(row => ({ ...row, evidenceIds: row.evidenceIds.map(id => id.replace("verified", "completed")) }));

  assert.equal(learnReadStrategy({ ...current, rewardFeedbacks: completed }, request).status, "waiting_evidence");
  assert.equal(learnReadStrategy({ ...current, rewardFeedbacks: current.rewardFeedbacks!.map(row => ({ ...row, origin: "model" as const })) }, request).status, "waiting_evidence");
});

test("scope, condition and explicit correction prevent misuse of a previously checked tool strategy", () => {
  const state = checked(), learned = policy(state);

  assert.equal(selectReadStrategy(learned, { scope: "other-project", conditions: small }, records(state)).path, undefined);
  assert.equal(selectReadStrategy(learned, { scope: request.scope, conditions: { ...small, range: "all" } }, records(state)).path, undefined);
  const previous = state.rewardFeedbacks![0]!, corrected: RewardFeedback = { ...previous, id: "checked-correction",
    evidenceIds: ["tool-read:failed:sw1"], supersedes: previous.id, observedAt: 3 };
  const updated = { ...state, rewardFeedbacks: [...state.rewardFeedbacks!, corrected] };

  assert.equal(selectReadStrategy(learned, { scope: request.scope, conditions: small }, records(updated)).path, undefined);
  assert.equal(selectReadStrategy(learned, { scope: request.scope, conditions: large }, records(updated)).path, "stream");
});

test("historical routing assets remain archived while only tool-owned version families are eligible", () => {
  const current = policy(), content = JSON.stringify(current), proposalId = "tool-owned-proposal";
  const asset = { versionId: "tool-read-policy:current", kind: "routing_policy" as const, schemaVersion: 2, content,
    contentHash: contentHashOf(content), source: "inferred" as const, scope: request.scope, createdAt: request.issuedAt, createdFromProposalId: proposalId };
  const proposal = { proposalId, domain: "tool" as const, assetKind: "routing_policy" as const, scope: request.scope, candidateRef: asset.versionId,
    hypothesis: "Checked tool strategy", observationRefs: [], requiredVerifiers: [], requestedAuthorities: [], risk: "low" as const,
    source: "inferred" as const, lifecycle: "evaluating" as const };
  const state = { ...emptyBoardState(), assets: [asset], proposals: [proposal] };

  assert.equal(latestReadStrategyAsset(state, request.scope)?.versionId, asset.versionId);
  assert.equal(latestReadStrategyAsset({ ...state, assets: [{ ...asset, versionId: "routing:historical" }] }, request.scope), undefined);
  assert.equal(latestReadStrategyAsset({ ...state, proposals: [{ ...proposal, domain: "routing" }] }, request.scope), undefined);
  assert.equal(latestReadStrategyAsset(state, "other-project"), undefined);
});
