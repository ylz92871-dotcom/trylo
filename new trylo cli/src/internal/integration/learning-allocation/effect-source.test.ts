import test from "node:test";
import assert from "node:assert/strict";
import { projectCentralEffectSupportFromBoard } from "./effect-source.js";
import { createCentralResponseWindowDraft } from "./response-registration.js";
import { emptyBoardState } from "../../learning/control/state.js";
import { reduce } from "../../learning/control/reducer.js";
import type { CoordinationAction } from "../../learning/control/coordination-contract.js";
import type { RewardV2Draft } from "../../learning/reward/v2-facts.js";
import type { EmpiricalTopicPolicy } from "../../learning/domains/shared/topics/empirical-model.js";

const scope = "workspace:effect-source";
const target = { key: "target:effect-source", utilityUnit: "paired-window-effect", referenceKey: "population:registered-stage-windows",
  baselineRuleKey: "rule:frozen-baseline", windowRef: "window:two-registered-uses" };
const policy: EmpiricalTopicPolicy = { scope, experimentRef: "experiment:effect-source", experimentVersion: "v1",
  conditionHash: "c".repeat(64), utilityUnit: target.utilityUnit, futureUses: 1, utilityScale: 1, experimentUnits: 1,
  deltaBounds: { minimum: -1, maximum: 1 }, priorStrength: 2, priorWeights: [.25, .25, .25, .25] };
const date = "2026-11-04T14:00:00.000Z";

function fixture() {
  let board = emptyBoardState();
  const coordinate = (action: CoordinationAction) => {
    const result = reduce(board, { type: "coordinate_learning", commandId: `test:coordinate:${board.sequence}`, issuedAt: date, action });
    if (!result.ok) throw new Error(result.reason);
    board = result.state;
  };

  coordinate({ kind: "report", scope, issueId: "issue:history", problemKey: "problem:history", report: { reportId: "report:history",
    source: { subsystem: "tool", taskId: "task:history", versionId: "v1" }, facts: ["Synthetic source contract"], evidenceRefs: ["source:history"] } });
  coordinate({ kind: "decide", issueId: "issue:history", expectedRevision: 1, decision: "focused_learning",
    reason: "Bounded contract stage", sourceRefs: ["source:history"] });
  coordinate({ kind: "fund", issueId: "issue:history", expectedRevision: 2, grantId: "grant:history", domain: "tool",
    allowance: { schemaVersion: 2, unit: "total_model_tokens", maxTokens: 1000, maxCalls: 2, maxSteps: 2, maxPromptChars: 4000 } });
  const append = (fact: RewardV2Draft) => {
    const result = reduce(board, { type: "record_reward_v2_fact", commandId: `test:record:${board.sequence}`, issuedAt: date,
      expectedSequence: board.sequence, fact });
    if (!result.ok) throw new Error(result.reason);
    board = result.state;
  };

  return {
    get board() { return board; },

    register(unitId: string, measurementIds: readonly string[], qualification: "linked" | "unqualified" = "linked") {
      const draft = createCentralResponseWindowDraft({ unitId, grantId: "grant:history", measurementIds,
        opportunity: { opportunityId: `opportunity:${unitId}`, scope, targetRef: target.key, instanceRef: `stage:${unitId}`,
          sourceRef: `source:${unitId}`, stage: "initial", conditionRef: policy.conditionHash, baselineRef: `baseline:${unitId}`,
          windowRef: target.windowRef, offer: { offerId: `offer:${unitId}`, owner: { plane: "agent", domain: "tool" },
            policyRef: "policy:tool-research-v1", reserve: { tokens: 1000, calls: 2, steps: 2 }, maxPromptChars: 4000 } },
        comparison: qualification === "unqualified" ? { kind: "unqualified", reason: "deployment_link_missing" }
          : { kind: "deployed_learning_vs_frozen_baseline", resultRef: `result:${unitId}`, adoptionRef: `adoption:${unitId}`,
            registrationRef: `registration:${unitId}`, baselineRuleKey: target.baselineRuleKey } }, target);
      if (draft.status !== "ready") throw new Error(draft.reason);

      append(draft.value);
    },

    measure(id: string, candidateUtility: number, supersedes?: string, conditionHash = policy.conditionHash) {
      const measurement = { id, scope, experimentRef: policy.experimentRef, experimentVersion: policy.experimentVersion,
        conditionHash, utilityUnit: policy.utilityUnit, sourceRef: `checker:${id}`, kind: "measured", baselineUtility: 0,
        candidateUtility, fullStudyCost: 100, ...(supersedes === undefined ? {} : { supersedes }) };
      append({ id, scope, algorithmVersion: "ws1-paired-measurement-v1", kind: "feedback", payloadJson: JSON.stringify({
        schemaVersion: 1, type: "ws1_paired_measurement", measurement, observationBinding: null }) });
    },
  };
}

function projection(source: ReturnType<typeof fixture>) {
  const result = projectCentralEffectSupportFromBoard({ board: source.board, target, measurementPolicy: policy });
  if (result.status !== "ready") throw new Error(`${result.status}:${result.reason}`);
  return result;
}

test("the original Board registrations and partial feedback produce a nonempty bounded effect population", () => {
  const source = fixture();

  assert.equal(projection(source).effectSupport, null);
  source.register("unit:one", ["pair:one", "pair:two"]);
  source.measure("pair:one", .5);
  const result = projection(source);

  assert.deepEqual(result.qualifiedWindowIds, ["unit:one"]);
  assert.equal(result.effectSupport!.population, 1);
  assert.equal(result.effectSupport!.knownComparisons, 1);
  assert.equal(result.effectSupport!.unknownComparisons, 1);
  assert.deepEqual(result.effectSupport!.actualMeanSupport, [-.5, 1.5]);
});

test("a real effective revision changes the support without adding a second window", () => {
  const source = fixture();

  source.register("unit:one", ["pair:one", "pair:two"]);
  source.measure("pair:one", .5);
  const original = projection(source);

  source.measure("pair:one:revised", -.5, "pair:one");
  const revised = projection(source);

  assert.equal(revised.effectSupport!.population, 1);
  assert.equal(revised.effectSupport!.knownComparisons, 1);
  assert.deepEqual(revised.effectSupport!.actualMeanSupport, [-1.5, .5]);
  assert.notEqual(revised.sourceRef, original.sourceRef);
  assert.ok(revised.effectSupport!.sourceRefs.includes("checker:pair:one:revised"));
});

test("unqualified raw strategy pairs remain explicit but do not become learning-effect labels", () => {
  const source = fixture();

  source.register("unit:unqualified", ["pair:one", "pair:two"], "unqualified");
  source.measure("pair:one", .5);
  source.measure("pair:two", .5);
  const result = projection(source);

  assert.equal(result.registeredWindowCount, 1);
  assert.equal(result.effectSupport, null);
  assert.deepEqual(result.qualifiedWindowIds, []);
  assert.equal(result.unqualifiedWindows[0]!.reason, "deployment_link_missing");
});

test("unqualified windows are counted separately while every qualified pending window remains in support", () => {
  const source = fixture();

  source.register("unit:pending", ["pending:a", "pending:b"]);
  source.register("unit:unqualified", ["unqualified:a", "unqualified:b"], "unqualified");
  source.measure("pending:a", .5);
  const result = projection(source);

  assert.equal(result.registeredWindowCount, 2);
  assert.equal(result.unqualifiedWindows.length, 1);
  assert.equal(result.effectSupport!.population, 1);
  assert.equal(result.effectSupport!.pendingWindows, 1);
  assert.deepEqual(result.effectSupport!.actualMeanSupport, [-.5, 1.5]);
});

test("a comparison observed before registration is still rejected after a late correction", () => {
  const source = fixture();
  source.measure("pair:one", .5);
  source.register("unit:one", ["pair:one", "pair:two"]);
  source.measure("pair:one:revised", -.5, "pair:one");
  const result = projectCentralEffectSupportFromBoard({ board: source.board, target, measurementPolicy: policy });
  assert.deepEqual(result, { status: "invalid", reason: "response_window_postselected" });
});

test("other-family measurements cannot leak known values into the current source family", () => {
  const source = fixture();
  source.register("unit:one", ["pair:one", "pair:two"]);
  source.measure("pair:one", .5, undefined, "d".repeat(64));
  const result = projection(source);
  assert.equal(result.effectSupport!.knownComparisons, 0);
  assert.deepEqual(result.effectSupport!.actualMeanSupport, [-2, 2]);
});

test("a minimal selector and source bounds need no unrelated prior or future-use DTO", () => {
  const source = fixture();

  source.register("unit:one", ["pair:one", "pair:two"]);
  source.measure("pair:one", .5);
  const result = projectCentralEffectSupportFromBoard({ board: source.board, target, measurementPolicy: {
    scope: policy.scope, experimentRef: policy.experimentRef, experimentVersion: policy.experimentVersion,
    conditionHash: policy.conditionHash, utilityUnit: policy.utilityUnit,
    deltaBounds: { ...policy.deltaBounds, sourceRef: "protocol:per-comparison-effect-support" } } });

  assert.equal(result.status, "ready");

  if (result.status === "ready") {
    assert.deepEqual(result.effectSupport!.actualMeanSupport, [-.5, 1.5]);
    assert.ok(result.effectSupport!.sourceRefs.includes("protocol:per-comparison-effect-support"));
  }
});
