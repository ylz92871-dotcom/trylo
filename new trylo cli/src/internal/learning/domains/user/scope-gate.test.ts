import assert from "node:assert/strict";
import test from "node:test";
import { routeForClass } from "./contracts.js";
import { classifyEligibility } from "./eligibility.js";
import { extractEvidence } from "./evidence.js";
import { classifyUserSignal, groundEvidenceCandidate } from "./evidence-grounding.js";
import { decideScopeV2, fingerprintScopeV2, sameStableScopeV2 } from "./scope-v2.js";
import type { UserEvidence } from "./contracts.js";

function evidenceFor(text: string, overrides?: Partial<UserEvidence>): UserEvidence {
  const extracted = extractEvidence({
    text,
    source: { sessionId: "session-1", turnId: "turn-1" },
  });
  assert.notEqual(extracted, null);
  return { ...(extracted as UserEvidence), ...overrides };
}

test("evidence keeps raw text and inferred claim in separate fields", () => {
  const evidence = evidenceFor("以后报告都先说结论");
  assert.equal(evidence.rawText, "以后报告都先说结论");
  assert.notEqual(evidence.claim, null);
  assert.equal(evidence.claim?.includes("以后报告都先说结论"), true);
  const changed: UserEvidence = { ...evidence, claim: "rewritten claim" };
  assert.equal(changed.rawText, "以后报告都先说结论");
});

test("evidence answers five questions independently and stays nullable", () => {
  const evidence = evidenceFor("以后报告都先说结论");
  assert.equal(typeof evidence.answers.semantic, "number");
  assert.equal(typeof evidence.answers.relevance, "number");
  assert.equal(evidence.answers.contextInformedness, "unknown");
  assert.equal(typeof evidence.answers.governance, "number");
  assert.equal(evidence.answers.scopeNarrowness, null);
});

test("empty or off-topic text extracts no evidence", () => {
  assert.equal(
    extractEvidence({ text: "   ", source: { sessionId: "s" } }),
    null,
  );
  assert.equal(
    extractEvidence({ text: "今晚吃牛肉还是吃电影", source: { sessionId: "s" } }),
    null,
  );
});

test("grounding accepts a real user event and rejects everything else", () => {
  const seen = new Set<string>();
  const accepted = groundEvidenceCandidate({
    candidate: { candidateId: "ev_1", proposedClaim: "用户偏好先说结论" },
    event: { eventId: "m1", actor: "user", text: "以后报告都先说结论" },
    source: { sessionId: "s1" },
    seen,
  });

  assert.equal(accepted.accepted, true);

  const agent = groundEvidenceCandidate({
    candidate: { candidateId: "ev_2", proposedClaim: "x" },
    event: { eventId: "m2", actor: "agent", text: "我生成了报告" },
    source: { sessionId: "s1" },
    seen,
  });

  assert.deepEqual(agent, { accepted: false, reasonCode: "actor_not_user" });

  const missing = groundEvidenceCandidate({
    candidate: { candidateId: "ev_3", proposedClaim: "x" },
    source: { sessionId: "s1" },
    seen,
  });

  assert.deepEqual(missing, { accepted: false, reasonCode: "source_event_missing" });

  const mismatch = groundEvidenceCandidate({
    candidate: { candidateId: "ev_4", proposedClaim: "x", proposedRaw: "完全无关的另一句话" },
    event: { eventId: "m3", actor: "user", text: "以后报告都先说结论" },
    source: { sessionId: "s1" },
    seen,
  });

  assert.deepEqual(mismatch, { accepted: false, reasonCode: "raw_span_mismatch" });
});

test("grounding rejects a duplicate source hash", () => {
  const first = groundEvidenceCandidate({
    candidate: { candidateId: "ev_7", proposedClaim: "x" },
    event: { eventId: "m1", actor: "user", text: "以后报告都先说结论" },
    source: { sessionId: "s1" },
    seen: new Set<string>(),
  });

  assert.equal(first.accepted, true);

  if (!first.accepted) {
    return;
  }

  const second = groundEvidenceCandidate({
    candidate: { candidateId: "ev_8", proposedClaim: "x" },
    event: { eventId: "m1", actor: "user", text: "以后报告都先说结论" },
    source: { sessionId: "s1" },
    seen: new Set<string>([first.evidence.sourceHash]),
  });

  assert.deepEqual(second, { accepted: false, reasonCode: "duplicate_source" });
});

test("signal classification separates long-term candidates from task-local", () => {
  assert.deepEqual(classifyUserSignal("以后报告都先说结论", "explicit_statement"), {
    durability: "long_term_candidate",
    signalKind: "collaboration_preference",
  });
  assert.deepEqual(classifyUserSignal("这次先写结论", "explicit_statement"), {
    durability: "task_local",
    signalKind: "task_requirement",
  });
});

test("persistent correction is a personalization candidate", () => {
  const decision = classifyEligibility({
    evidence: evidenceFor("以后都这样：先跑指定检查再改代码"),
    speechAct: "future_directive",
  });

  assert.equal(decision.classification, "personalization_candidate");
  assert.equal(decision.route, "personalization_chain");
  assert.equal(decision.sourceEvidenceIds.length, 1);
});

test("fabricated references are a quality defect, never a preference", () => {
  const decision = classifyEligibility({
    evidence: evidenceFor("不要编造引用"),
    speechAct: "not_explicit",
  });
  assert.equal(decision.classification, "general_quality_defect");
  assert.equal(decision.route, "quality_repair");
});

test("a bare correction without persistence is a quality defect", () => {
  const decision = classifyEligibility({
    evidence: evidenceFor("你搞错了，重做一下", { eventKind: "correction", signalKind: "correction" }),
    speechAct: "correction",
  });
  assert.equal(decision.classification, "general_quality_defect");
});

test("this-time-only instruction stays in the session", () => {
  const decision = classifyEligibility({
    evidence: evidenceFor("这次先写结论"),
    speechAct: "not_explicit",
  });
  assert.equal(decision.classification, "session_instruction");
  assert.equal(decision.route, "session_intent");
});

test("pure permission language belongs to the permission service", () => {
  const decision = classifyEligibility({
    evidence: evidenceFor("以后跳过审批", { eventKind: "explicit_statement" }),
    speechAct: "future_directive",
    residualText: "",
  });

  assert.equal(decision.classification, "authorization_or_permission");
  assert.equal(decision.route, "permission_service");
});

test("vague confirmation is insufficient information, never a guess", () => {
  const decision = classifyEligibility({
    evidence: evidenceFor("就这样吧"),
    speechAct: "confirm",
  });
  assert.equal(decision.classification, "insufficient_information");
  assert.equal(decision.route, "drop_insufficient");
});

test("only personalization candidates route into the deep chain", () => {
  assert.equal(routeForClass("personalization_candidate"), "personalization_chain");
  assert.notEqual(routeForClass("session_instruction"), "personalization_chain");
  assert.notEqual(routeForClass("general_quality_defect"), "personalization_chain");
  assert.notEqual(routeForClass("authorization_or_permission"), "personalization_chain");
  assert.notEqual(routeForClass("insufficient_information"), "personalization_chain");
});

test("scope v2 separates identity from conditions and defaults product to unknown", () => {
  const scope = decideScopeV2({ projectId: "repo-a", conditions: { corePath: true } });
  assert.equal(scope.identity.projectId, "repo-a");
  assert.equal(scope.conditions.corePath, true);
  assert.equal(scope.product, "unknown");
  assert.match(scope.fingerprint, /^v2:/);
  assert.equal("projectId" in scope.conditions, false);
});

test("scope v2 fingerprints are stable and comparable", () => {
  const a = fingerprintScopeV2({ projectId: "repo-a" });
  const b = fingerprintScopeV2({ projectId: "repo-a" });
  const c = fingerprintScopeV2({ projectId: "repo-b" });

  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(
    sameStableScopeV2(decideScopeV2({ projectId: "repo-a" }), decideScopeV2({ projectId: "repo-a" })),
    true,
  );
});
