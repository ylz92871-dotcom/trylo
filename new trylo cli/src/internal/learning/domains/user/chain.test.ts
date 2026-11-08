import assert from "node:assert/strict";
import test from "node:test";
import { compileBehaviorCommitments } from "./behavior-commitment.js";
import { discoverEvidenceRelations, synthesizeConclusions } from "./conclusion.js";
import type {
  BehaviorCommitment,
  BundlePointerState,
  ConclusionRecord,
  UserEvidence,
  UserModelRecord,
} from "./contracts.js";
import { classifyEligibility } from "./eligibility.js";
import { extractEvidence } from "./evidence.js";
import { appendReceiptsForNewCommitments, createLearningReceipt } from "./learning-receipt.js";
import { commitBundle, compilePolicyBundle, verifyBundleChecksum } from "./policy-compile.js";
import { evaluateOutcome } from "./outcome-evaluator.js";
import { fingerprintScopeV2 } from "./scope-v2.js";
import { reasonUserModels } from "./user-model.js";

const TEXT = "以后周报都先说结论，再展开依据";
const SCOPE = fingerprintScopeV2({ projectId: "repo-a" });

function runChain() {
  const evidence = extractEvidence({
    text: TEXT,
    source: { sessionId: "session-1", turnId: "turn-1" },
  }) as UserEvidence;
  const eligibility = classifyEligibility({ evidence, speechAct: "future_directive" });
  const relations = discoverEvidenceRelations({ userId: "local-user", fresh: [evidence], existing: [] });
  const conclusions = synthesizeConclusions({
    userId: "local-user",
    fresh: [evidence],
    existing: [],
    relations,
    scopeFingerprint: SCOPE,
  });
  const { models } = reasonUserModels({ userId: "local-user", conclusions });
  const commitments = compileBehaviorCommitments({
    userId: "local-user",
    models,
    evidence: [evidence],
    eligibility: [eligibility],
  });

  return { evidence, eligibility, relations, conclusions, models, commitments };
}

test("the full chain runs evidence to bundle with no skipped step", () => {
  const { evidence, eligibility, conclusions, models, commitments } = runChain();

  assert.equal(eligibility.classification, "personalization_candidate");
  assert.equal(conclusions.length, 1);
  const conclusion = conclusions[0] as ConclusionRecord;

  assert.ok(conclusion.supporting.includes(evidence.id));
  assert.equal(models.length, 1);
  const model = models[0] as UserModelRecord;

  assert.deepEqual(model.derivedFromConclusionIds, [conclusion.id]);
  assert.equal(commitments.length, 1);
  const commitment = commitments[0] as BehaviorCommitment;

  assert.deepEqual(commitment.provenanceEvidenceIds, [evidence.id]);
  assert.equal(commitment.userModelId, model.id);

  const compiled = compilePolicyBundle({
    userId: "local-user",
    commitments,
    models,
  });

  assert.equal(compiled.rules.length, 1);
  assert.deepEqual(compiled.bundle.ruleIds, compiled.rules.map((rule) => rule.id));
  assert.equal(verifyBundleChecksum(compiled), true);
  assert.deepEqual(compiled.rules[0]?.sourceCommitmentIds, [commitment.id]);
  assert.deepEqual(compiled.rules[0]?.sourceEvidenceIds, [evidence.id]);
});

test("every active commitment traces back to evidence", () => {
  const { commitments } = runChain();

  for (const commitment of commitments) {
    assert.ok(commitment.provenanceEvidenceIds.length > 0);
  }

  const orphan = compileBehaviorCommitments({
    userId: "local-user",
    models: runChain().models,
    evidence: [],
    eligibility: [],
  });

  assert.equal(orphan.length, 0);
});

test("models without a decision point grow no commitment", () => {
  const { models, evidence, eligibility } = runChain();
  const auditModel: UserModelRecord = {
    ...(models[0] as UserModelRecord),
    id: "um_audit",
    dimension: "verification_audit",
  };
  const commitments = compileBehaviorCommitments({
    userId: "local-user",
    models: [auditModel],
    evidence: [evidence],
    eligibility: [eligibility],
  });

  assert.equal(commitments.length, 0);
});

test("recompiling supersedes the prior commitment instead of duplicating", () => {
  const first = runChain();
  const second = compileBehaviorCommitments({
    userId: "local-user",
    models: first.models,
    evidence: [first.evidence],
    eligibility: [first.eligibility],
    existing: first.commitments,
  });
  const live = second.filter((item) => item.state !== "superseded");

  assert.equal(live.length, 1);
  assert.equal((live[0] as BehaviorCommitment).version, 2);
  assert.equal((live[0] as BehaviorCommitment).supersedes, (first.commitments[0] as BehaviorCommitment).id);
});

test("bundle compilation has no render or inject surface", () => {
  const { commitments, models } = runChain();
  const compiled = compilePolicyBundle({ userId: "local-user", commitments, models });
  const serialized = JSON.stringify({ bundle: compiled.bundle, rules: compiled.rules });

  assert.equal(serialized.includes("promptMessages"), false);
  assert.equal(serialized.includes("render"), false);
  assert.equal(serialized.includes("inject"), false);
  assert.equal("instruction" in (compiled.rules[0] as object), true);
});

test("current pointer switches atomically and retires the old bundle", () => {
  const { commitments, models } = runChain();
  const first = compilePolicyBundle({ userId: "local-user", commitments, models });
  let state: BundlePointerState = { bundles: [] };

  state = commitBundle(state, first);
  assert.equal(state.currentBundleId, first.bundle.id);
  const second = compilePolicyBundle({
    userId: "local-user",
    commitments,
    models,
    previousBundle: first.bundle,
  });

  state = commitBundle(state, second);
  assert.equal(state.currentBundleId, second.bundle.id);
  assert.equal(
    state.bundles.find((item) => item.id === first.bundle.id)?.status,
    "retired",
  );
  assert.equal(second.bundle.previousBundleId, first.bundle.id);
  assert.equal(second.bundle.version, first.bundle.version + 1);
});

test("a tampered bundle fails verification and never becomes current", () => {
  const { commitments, models } = runChain();
  const compiled = compilePolicyBundle({ userId: "local-user", commitments, models });
  const tampered = {
    bundle: { ...compiled.bundle, ruleIds: [...compiled.bundle.ruleIds, "pol_forged"] },
    rules: compiled.rules,
  };

  assert.equal(verifyBundleChecksum(tampered), false);
  const state: BundlePointerState = { bundles: [] };

  assert.deepEqual(commitBundle(state, tampered), state);
});

test("candidate commitments compile to nothing", () => {
  const { commitments, models } = runChain();
  const candidate = { ...(commitments[0] as BehaviorCommitment), state: "candidate" as const };
  const compiled = compilePolicyBundle({ userId: "local-user", commitments: [candidate], models });
  assert.equal(compiled.rules.length, 0);
  assert.deepEqual(compiled.bundle.ruleIds, []);
  assert.equal(verifyBundleChecksum(compiled), true);
});

test("receipts show scope, effect, and revoke paths without claiming enforcement", () => {
  const { commitments, evidence } = runChain();
  const commitment = commitments[0] as BehaviorCommitment;
  const receipt = createLearningReceipt({
    commitment,
    evidence: [evidence],
    reason: "created",
  });

  assert.notEqual(receipt, null);
  assert.match((receipt as { message: string }).message, /已记录，尚未用于执行/);
  assert.deepEqual((receipt as { revokeActions: readonly string[] }).revokeActions, [
    "this_time_only",
    "change_scope",
    "pause",
    "retract",
  ]);
  const again = createLearningReceipt({
    commitment,
    evidence: [evidence],
    existing: receipt === null ? [] : [receipt],
    reason: "created",
  });

  assert.equal(again, null);
  const receipts = appendReceiptsForNewCommitments({
    before: [],
    after: commitments,
    evidence: [evidence],
  });

  assert.equal(receipts.length, 1);
});

test("task completion never raises preference confidence", () => {
  const { commitments } = runChain();
  const id = (commitments[0] as BehaviorCommitment).id;
  const { observations, pauseCommitmentIds } = evaluateOutcome({
    commitmentIds: [id],
    events: [],
    taskOutcome: "completed",
  });

  assert.equal(observations.length, 1);
  assert.equal(observations[0]?.signal, "task_completed");
  assert.equal(observations[0]?.attribution, "unknown");
  assert.deepEqual(pauseCommitmentIds, []);
});

test("missing feedback leaves the effect unknown", () => {
  const { commitments } = runChain();
  const { observations } = evaluateOutcome({
    commitmentIds: [(commitments[0] as BehaviorCommitment).id],
    events: [],
  });
  assert.equal(observations.length, 0);
});

test("explicit rejection pauses the commitment", () => {
  const { commitments } = runChain();
  const id = (commitments[0] as BehaviorCommitment).id;
  const bad = evaluateOutcome({
    commitmentIds: [id],
    events: [{ kind: "feedback_text", text: "不对，不是这样，别再这样" }],
  });

  assert.equal(bad.observations[0]?.signal, "explicit_unhelpful");
  assert.deepEqual(bad.pauseCommitmentIds, [id]);
  const good = evaluateOutcome({
    commitmentIds: [id],
    events: [{ kind: "feedback_text", text: "这样很好，以后就这样" }],
  });

  assert.equal(good.observations[0]?.signal, "explicit_helpful");
  assert.deepEqual(good.pauseCommitmentIds, []);
});
