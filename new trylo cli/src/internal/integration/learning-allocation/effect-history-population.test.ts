import assert from "node:assert/strict";
import test from "node:test";
import { emptyBoardState } from "../../learning/control/state.js";
import { reduce } from "../../learning/control/reducer.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { validRewardV2Prefix } from "../../learning/reward/v2-facts.js";
import type { RewardV2Draft } from "../../learning/reward/v2-facts.js";
import type { CentralEffectSupportInput } from "../../learning/control/decision/effect-support-contract.js";
import { summarizeCentralEffectSupport } from "../../learning/control/decision/effect-support.js";
import { createCentralResponseWindowDraft, centralResponseRegistrationsOf } from "./response-registration.js";
import { buildCentralResponseHistoryFromBoard } from "./response-source.js";
import type { CentralResponseWindow } from "./response-source.js";
import { projectCentralEffectSupportFromBoard } from "./effect-source.js";

const scope = "workspace:effect-history-population", date = "2026-11-04T15:00:00.000Z";
const target = { key: "target:history", utilityUnit: "utility:window-effect", referenceKey: "population:registered",
  baselineRuleKey: "rule:frozen", windowRef: "window:one-comparison" };
const protocol = { scope, experimentRef: "experiment:history", experimentVersion: "1",
  conditionHash: contentHashOf({ scope, condition: "declared-history-population" }),
  utilityUnit: target.utilityUnit, deltaBounds: { minimum: -1, maximum: 1, sourceRef: "objective:bounds" },
  policyFamilyRef: "family:history", familySourceRef: "source:history-family" };

function history() {
  let board = emptyBoardState();
  const actions = [
    { kind: "report" as const, scope, issueId: "issue:history", problemKey: "problem:history", report: { reportId: "report:history",
      source: { subsystem: "tool" as const, taskId: "task:history", versionId: "source:history" }, facts: ["Synthetic immutable history contract"], evidenceRefs: ["source:history"] } },
    { kind: "decide" as const, issueId: "issue:history", expectedRevision: 1, decision: "focused_learning" as const,
      reason: "Explicit bounded source contract", sourceRefs: ["source:history"] },
    { kind: "fund" as const, issueId: "issue:history", expectedRevision: 2, grantId: "grant:history", domain: "tool" as const,
      allowance: { schemaVersion: 2 as const, unit: "total_model_tokens" as const, maxTokens: 1000, maxCalls: 1, maxSteps: 1, maxPromptChars: 4000 } },
  ];

  for (const action of actions) {
    const result = reduce(board, { type: "coordinate_learning", commandId: `setup:${board.sequence}`, issuedAt: date, action });
    if (!result.ok) assert.fail(JSON.stringify(result));
    board = result.state;
  }

  const windows: CentralResponseWindow[] = [], facts: RewardV2Draft[] = [];

  for (let index = 0; index < 513; index++) {
    const registration = { unitId: `unit:${index}`, grantId: "grant:history", measurementIds: [`pair:${index}`],
      comparison: { kind: "deployed_learning_vs_frozen_baseline" as const, resultRef: `result:${index}`, adoptionRef: `adoption:${index}`,
        registrationRef: `registered:${index}`, baselineRuleKey: target.baselineRuleKey },
      opportunity: { opportunityId: `opportunity:${index}`, scope, targetRef: target.key, instanceRef: `stage:${index}`, sourceRef: `source:${index}`,
        stage: "initial" as const, conditionRef: protocol.conditionHash, baselineRef: `baseline:${index}`, windowRef: target.windowRef,
        offer: { offerId: `offer:${index}`, owner: { plane: "agent" as const, domain: "tool" as const }, policyRef: "policy:history",
          reserve: { tokens: 1000, calls: 1, steps: 1 }, maxPromptChars: 4000 } } };
    const draft = createCentralResponseWindowDraft(registration, target, protocol);
    if (draft.status !== "ready") assert.fail(draft.reason);

    facts.push(draft.value);
    windows.push({ ...registration, registeredAtSequence: board.sequence + facts.length, boundary: "complete" });
  }

  facts.push({ id: "pair:512", scope, algorithmVersion: "ws1-paired-measurement-v1", kind: "feedback", payloadJson: canonicalJson({
    schemaVersion: 1, type: "ws1_paired_measurement", observationBinding: null, measurement: { id: "pair:512", scope,
      experimentRef: protocol.experimentRef, experimentVersion: protocol.experimentVersion, conditionHash: protocol.conditionHash,
      utilityUnit: target.utilityUnit, sourceRef: "checker:tail", kind: "measured", baselineUtility: 0, candidateUtility: .5, fullStudyCost: 100 } }) });
  // A canonical immutable prefix of the original writer's real draft format.
  // Population growth is not another funded stage or a newly allocated work graph.
  const state = { ...board, sequence: board.sequence + facts.length,
    rewardV2Facts: facts.map((fact, index) => ({ ...fact, sequence: board.sequence + index + 1 })) };

  assert.ok(validRewardV2Prefix(state.rewardV2Facts, state.sequence));

  return { board: state, windows };
}

test("a valid target remains readable after its 513th independent registration", () => {
  const source = history(), decoded = centralResponseRegistrationsOf(source.board, scope);
  if (decoded.status !== "ready") assert.fail(decoded.reason);
  assert.equal(decoded.value.length, 513);
  assert.equal(decoded.value[512]?.window.unitId, "unit:512");
});

test("history qualification consumes every valid window without a retained-population cutoff", () => {
  const source = history(), result = buildCentralResponseHistoryFromBoard({ ...source, target, measurementPolicy: protocol });
  if (result.status !== "ready") assert.fail(result.reason);
  assert.equal(result.history.length, 513);
  assert.equal(result.history.filter(row => row.outcome.kind === "unknown").length, 512);
  assert.deepEqual(result.history[512]?.outcome, { kind: "paired_window", candidateUtility: .5, baselineUtility: 0 });
});

test("selected source populations beyond 512 retain their observed tail and all missing denominators", () => {
  const source = history(), before = JSON.stringify(source.board), result = projectCentralEffectSupportFromBoard({
    board: source.board, target, measurementPolicy: protocol, windowIds: source.windows.map(window => window.unitId) });
  if (result.status !== "ready") assert.fail(result.reason);

  assert.equal(result.registeredWindowCount, 513);
  assert.equal(result.effectSupport?.population, 513);
  assert.equal(result.effectSupport?.knownComparisons, 1);
  assert.equal(result.effectSupport?.unknownComparisons, 512);
  assert.deepEqual(result.effectSupport?.totalGrossSupport, [-511.5, 512.5]);
  assert.equal(JSON.stringify(source.board), before);
});

test("more than 4096 accumulated comparisons preserve safe counts while each protocol window stays bounded", () => {
  const input: CentralEffectSupportInput = { target, comparisonsPerWindow: 512, deltaBounds: protocol.deltaBounds,
    windows: Array.from({ length: 9 }, (_, index) => ({ unitId: `unit:${index}`, sourceRef: `source:${index}`, revisionRef: `revision:${index}`,
      comparisonIds: Array.from({ length: 512 }, (_, comparison) => `pair:${index}:${comparison}`), measurements: [] })) };
  const result = summarizeCentralEffectSupport(input);
  if (result.status !== "ready") assert.fail(result.reason);

  assert.equal(result.value.population, 9);
  assert.equal(result.value.registeredComparisons, 4608);
  assert.equal(result.value.knownComparisons, 0);
  assert.equal(result.value.unknownComparisons, 4608);
  assert.ok(Number.isSafeInteger(result.value.registeredComparisons));
  assert.deepEqual(result.value.actualMeanSupport, [-512, 512]);
  assert.equal(summarizeCentralEffectSupport({ ...input, comparisonsPerWindow: 513 }).status, "invalid");
});
