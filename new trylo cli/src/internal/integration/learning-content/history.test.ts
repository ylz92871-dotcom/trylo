import test from "node:test";
import assert from "node:assert/strict";
import { projectContentLearningHistory } from "./history.js";
import type { ContentHistorySourceBinding, ContentLearningHistoryInput } from "./history.js";
import type { RewardV2Fact } from "../../learning/reward/v2-facts.js";
import { createCentralResponseWindowDraft } from "../learning-allocation/response-registration.js";
import type { CentralResponseWindow } from "../learning-allocation/response-source.js";

function fixture(comparison?: CentralResponseWindow["comparison"]): ContentLearningHistoryInput {
  const policy = { scope: "project:content", experimentRef: "compare:one", experimentVersion: "v1", conditionHash: "c".repeat(64),
    utilityUnit: "registered-window-utility", futureUses: 1, utilityScale: 1, experimentUnits: 1,
    deltaBounds: { minimum: -1, maximum: 1 }, priorStrength: 2, priorWeights: [.25, .25, .25, .25] };
  const target = { key: "target:content", utilityUnit: policy.utilityUnit, referenceKey: "window-population:one",
    baselineRuleKey: "keep-existing:one", windowRef: "registered-window:one",
    ...(comparison?.kind === "learning_policy_vs_frozen_baseline" ? { estimand: "learning_policy_response" as const } : {}) };
  const source: ContentHistorySourceBinding = {
    window: { unitId: "unit:one", grantId: "grant:one", registeredAtSequence: 1, measurementIds: ["pair:one"], boundary: "complete",
      comparison: comparison ?? { kind: "deployed_learning_vs_frozen_baseline", resultRef: "result:one", adoptionRef: "adoption:one",
        registrationRef: "registered:one", baselineRuleKey: target.baselineRuleKey },
      opportunity: { opportunityId: "opportunity:one", scope: policy.scope, targetRef: target.key, instanceRef: "stage:one",
        sourceRef: "source:one", stage: "initial", conditionRef: policy.conditionHash, baselineRef: "baseline:one", windowRef: target.windowRef,
        offer: { offerId: "offer:one", owner: { plane: "agent", domain: "tool" }, policyRef: "policy:one",
          reserve: { tokens: 1000, calls: 1, steps: 1 }, maxPromptChars: 4000 } } },
    chain: { kind: "traced", issueId: "issue:one", grantId: "grant:one",
      result: { ref: "result:one", artifactRef: "asset:one", version: "v1" },
      adoption: { ref: "adoption:one", artifactRef: "asset:one", version: "v1", unitId: "unit:one", windowRef: target.windowRef },
      registration: { ref: "registered:one", unitId: "unit:one", windowRef: target.windowRef },
      sourceRefs: ["result:one", "adoption:one", "registered:one"] },
    usage: { reservationIds: ["reservation:stage"], boundary: { kind: "complete" }, sourceRef: "usage-tail:one" },
  };
  const facts: RewardV2Fact[] = [["pair:one", 5, .3, undefined], ["pair:revision", 10, -.2, "pair:one"]].map(row => {
    const [id, sequence, candidateUtility, supersedes] = row;
    const measurement = { id, scope: policy.scope, experimentRef: policy.experimentRef, experimentVersion: policy.experimentVersion,
      conditionHash: policy.conditionHash, utilityUnit: policy.utilityUnit, sourceRef: `checker:${id}`, kind: "measured",
      baselineUtility: 0, candidateUtility, fullStudyCost: 1, ...(supersedes === undefined ? {} : { supersedes }) };
    return { id: String(id), scope: policy.scope, sequence: Number(sequence), algorithmVersion: "ws1-paired-measurement-v1", kind: "feedback",
      payloadJson: JSON.stringify({ schemaVersion: 1, type: "ws1_paired_measurement", measurement, observationBinding: null }) };
  });
  const { registeredAtSequence: _birth, boundary: _boundary, ...registration } = source.window;
  const registered = createCentralResponseWindowDraft(registration, target);
  assert.equal(registered.status, "ready");

  if (registered.status !== "ready") throw new Error("fixture_registration");

  facts.unshift({ ...registered.value, sequence: 1 });

  return { target, measurementPolicy: policy, sources: [source], board: { sequence: 20, appliedCommands: [], proposals: [], assets: [],
    activations: [], evidence: [], approvals: [], jobs: [], tombstones: [], fieldings: [], feedbacks: [], rewardV2Facts: facts,
    centralLearningGrants: [{ schemaVersion: 2, grantId: "grant:one", issueId: "issue:one", jobId: "job:one", scope: policy.scope, domain: "tool",
      focusRevision: 1, allowance: { schemaVersion: 2, unit: "total_model_tokens", maxTokens: 1000, maxCalls: 2, maxSteps: 2, maxPromptChars: 4000 },
      steps: 2, reservations: [{ reservationId: "reservation:stage", claimId: "claim:one", maxTokens: 100, state: "settled",
        usage: { kind: "reported", totalTokens: 30 } }, { reservationId: "reservation:other-stage", claimId: "claim:two", maxTokens: 100,
        state: "settled", usage: { kind: "reported", totalTokens: 70 } }], status: "closed", closedReason: "completed" }] } };
}

test("source lineage delegates revision resolution and stage spend without relabelling raw comparisons", () => {
  const input = fixture(), before = JSON.stringify(input), result = projectContentLearningHistory(input);

  assert.equal(result.status, "ready");

  if (result.status !== "ready") throw new Error("history_not_ready");

  assert.deepEqual(result.history[0]!.outcome, { kind: "paired_window", candidateUtility: -.2, baselineUtility: 0 });
  assert.equal(result.pairedRecords.length, 2);
  assert.deepEqual(result.costs[0]!.cost, { status: "reported", grantId: "grant:one", sourceRef: "usage-tail:one",
    resources: { tokens: 30, calls: 1, steps: 1 } });
  assert.equal(result.evidence[0]!.chain.kind, "traced");
  assert.equal(JSON.stringify(input), before);
});

test("missing adoption lineage and usage tails stay unknown despite measured success", () => {
  const input = fixture(), result = projectContentLearningHistory({ ...input, sources: input.sources.map(source => ({ ...source,
    chain: { kind: "unknown", issueId: "issue:one", reason: "adoption_source_missing", sourceRefs: [] }, usage: null })) });

  assert.equal(result.status, "ready");

  if (result.status !== "ready") throw new Error("history_not_ready");

  assert.deepEqual(result.history[0]!.outcome, { kind: "unknown", reason: "adoption_source_missing" });
  assert.equal(result.costs[0]!.cost.status, "unknown");
  assert.equal(result.pairedRecords[0]!.kind, "measured");
});

test("mismatched adopted artifact and repeated bills cannot create learning history", () => {
  const input = fixture(), source = input.sources[0]!;
  if (source.chain.kind !== "traced") throw new Error("fixture_chain");

  const mismatch = projectContentLearningHistory({ ...input, sources: [{ ...source, chain: { ...source.chain,
    adoption: { ...source.chain.adoption, version: "v2" } } }] });

  assert.deepEqual(mismatch, { status: "invalid", reason: "content_history_lineage_conflict" });
  const repeated = projectContentLearningHistory({ ...input, sources: [source, source] });

  assert.deepEqual(repeated, { status: "invalid", reason: "content_history_reused_reservation" });
  const backdated = projectContentLearningHistory({ ...input, sources: [{ ...source, window: { ...source.window, registeredAtSequence: 0 } }] });

  assert.deepEqual(backdated, { status: "invalid", reason: "content_history_window_unregistered" });
});

test("a legacy result/adoption chain cannot qualify the newer policy-assignment contrast", () => {
  const input = fixture({ kind: "learning_policy_vs_frozen_baseline", assignmentRef: "assignment:prospective",
    registrationRef: "registered:one", baselineRuleKey: "keep-existing:one" });
  const before = JSON.stringify(input), result = projectContentLearningHistory(input);
  assert.deepEqual(result, { status: "invalid", reason: "content_history_policy_assignment_lineage_required" });
  assert.equal(JSON.stringify(input), before);
});
