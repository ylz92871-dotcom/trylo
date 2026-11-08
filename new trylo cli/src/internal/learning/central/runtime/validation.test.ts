import assert from "node:assert/strict";
import test from "node:test";
import type { CentralLearningIntentDraft, CentralLearningOperation, CentralLearningRuntimeState } from "./contracts.js";
import { emptyCentralRuntimeState } from "./records.js";
import { isCentralDeliberationOutput, isCentralLearningOperation, isCentralLearningRuntimeState, isCentralRuntimeWork } from "./validation.js";

const allowance = { schemaVersion: 2 as const, unit: "total_model_tokens" as const, maxTokens: 100, maxCalls: 1, maxSteps: 1, maxPromptChars: 1000 };
const operation: Extract<CentralLearningOperation, { kind: "dispatch" }> = { operationId: "operation:one", kind: "dispatch",
  purpose: "Find the missing condition", expectedChange: "A narrower reusable method", sourceRefs: ["source:one"], allowance };
const intent: CentralLearningIntentDraft = { intentId: "intent:one", subject: { plane: "agent", domain: "prompt", issueId: "issue:one" },
  goal: "Understand the condition", rationale: "The result differs", conditions: [], knowledge: [{ statement: "An earlier answer",
    conditions: "Earlier scope", sourceRefs: ["knowledge:one"] }], residual: ["Which condition matters?"], commitment: {
    purpose: "Resolve the difference", assumptions: [], reconsiderWhen: ["A contradictory receipt arrives"] }, revisionReason: "",
  sourceRefs: ["source:one"], continuation: { kind: "ready", operation } };
const frame = { source: "original-owner", nested: { selected: ["a", 1, null, true] } };

test("all operation variants require exact fields and keep allowance owned by the existing schema", () => {
  const common = { operationId: "op", purpose: "", expectedChange: "", sourceRefs: [] };

  for (const value of [{ ...common, kind: "think" }, { ...common, kind: "read", refs: ["material:1"], maximumChars: 100 },
    { ...common, kind: "consult", allowance }, operation]) {
    assert.equal(isCentralLearningOperation(value), true);
    assert.equal(isCentralLearningOperation({ ...value, allowNetwork: true }), false);
  }

  assert.equal(isCentralLearningOperation({ ...operation, allowance: { ...allowance, permission: "allow" } }), false);
  assert.equal(isCentralLearningOperation({ ...operation, kind: "install" }), false);
  assert.equal(isCentralLearningOperation({ ...common, kind: "read", refs: ["a", "a"], maximumChars: 100 }), false);
  assert.equal(isCentralLearningOperation({ ...common, kind: "read", refs: [], maximumChars: Infinity }), false);
});

test("deliberation accepts open ended goals and exact waits without evaluating their content", () => {
  const base = { schemaVersion: 1, intents: [intent], publicExplanation: "", sourceRefs: [] };

  assert.equal(isCentralDeliberationOutput(base), true);
  const user = { ...intent, subject: { plane: "user", ledgerRef: "user:ledger", questionRef: "user:question" } };

  for (const wait of [{ kind: "facts", reason: "", sourceRefs: [] }, { kind: "use_feedback", reason: "", sourceRefs: [] },
    { kind: "resources", reason: "", sourceRefs: [] }, { kind: "until", at: 123, reason: "", sourceRefs: [] }]) {
    assert.equal(isCentralDeliberationOutput({ ...base, intents: [{ ...user, continuation: { kind: "waiting", wait } }] }), true);
    assert.equal(isCentralDeliberationOutput({ ...base, intents: [{ ...user, continuation: { kind: "waiting", wait: { ...wait, automaticApproval: true } } }] }), false);
  }

  for (const goalState of ["open", "answered", "withdrawn"]) {
    assert.equal(isCentralDeliberationOutput({ ...base, intents: [{ ...user, continuation: { kind: "ended", goalState, reason: "" } }] }), true);
  }

  assert.equal(isCentralDeliberationOutput({ ...base, intents: [{ ...user, subject: { ...user.subject, issueId: "agent:issue" } }] }), false);
  assert.equal(isCentralDeliberationOutput({ ...base, intents: [intent, intent] }), false);
  assert.equal(isCentralDeliberationOutput({ ...base, extra: 1 }), false);
  assert.equal(isCentralDeliberationOutput({ ...base, intents: [{ ...intent, goal: "\ud800" }] }), false);
});

test("runtime snapshots preserve materials, receipts and opaque JSON recovery frames with unique identities", () => {
  const work = { intentId: intent.intentId, operation, workRef: "work:one", frame };

  assert.equal(isCentralRuntimeWork(work), true);
  assert.equal(isCentralRuntimeWork({ ...work, frame: { nonFinite: NaN } }), false);
  assert.equal(isCentralRuntimeWork({ ...work, frame: new Date(0) }), false);
  assert.equal(isCentralRuntimeWork({ ...work, operation: { ...operation, kind: "consult" } }), false);
  const state: CentralLearningRuntimeState = { ...emptyCentralRuntimeState("scope:one"), intents: [intent], running: [work],
    completed: [{ intentId: "intent:historical", operation: { kind: "think", operationId: "op:historical", purpose: "",
      expectedChange: "", sourceRefs: [] }, outcome: "unknown", resultRefs: [], publicResult: "Unconfirmed" }],
    materials: [{ ref: "source:one", kind: "source", text: "Grounded material", sourceRefs: [] }], consumedSourceRefs: ["source:one"] };

  assert.equal(isCentralLearningRuntimeState(state), true);
  const wait = { kind: "resources", reason: "The original allowance cannot cover the next operation", sourceRefs: ["budget:original"] };

  assert.equal(isCentralLearningRuntimeState({ ...state, completed: [{ ...state.completed[0], wait }] }), true);
  assert.equal(isCentralLearningRuntimeState({ ...state, completed: [{ ...state.completed[0], wait: { ...wait, increaseBudget: true } }] }), false);
  assert.equal(isCentralLearningRuntimeState({ ...state, completed: [{ ...state.completed[0], wait: undefined }] }), false);
  assert.equal(isCentralLearningRuntimeState({ ...state, running: [work, work] }), false);
  assert.equal(isCentralLearningRuntimeState({ ...state, completed: [{ ...state.completed[0], operation }] }), false);
  assert.equal(isCentralLearningRuntimeState({ ...state, materials: [...state.materials, ...state.materials] }), false);
  assert.equal(isCentralLearningRuntimeState({ ...state, consumedSourceRefs: ["a", "a"] }), false);
  assert.equal(isCentralLearningRuntimeState({ ...state, materials: [{ ...state.materials[0], text: "x".repeat(32769) }] }), false);
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.equal(isCentralRuntimeWork({ ...work, frame: cyclic }), false);
});

test("optional organization outputs use the organization's own exact knowledge and experience contracts", () => {
  const knowledge = { kind: "knowledge", knowledgeId: "knowledge:one", supersedes: null, statement: "A learning hypothesis",
    conditions: "When the original result is delayed", conditionKeys: ["late-feedback"], exceptions: "Not established otherwise",
    exceptionKeys: [], implication: "Wait for the existing receipt", supportFactIds: ["organization:feedback"], counterexampleFactIds: [], state: "proposed" };
  const change = { knowledgeFactId: "knowledge-fact:one", choice: "wait", before: "Repeat the worker", after: "Observe the existing worker", reason: "Its receipt is unresolved" };
  const output = { schemaVersion: 1, intents: [intent], publicExplanation: "Learning continues", sourceRefs: ["source:one"],
    alternatives: ["Wait for evidence"], organizationUse: { recallRef: "recall:one", changes: [change] }, organizationKnowledge: [knowledge] };

  assert.equal(isCentralDeliberationOutput(output), true);
  assert.equal(isCentralDeliberationOutput({ ...output, organizationUse: { ...output.organizationUse, permission: "allow" } }), false);
  assert.equal(isCentralDeliberationOutput({ ...output, organizationUse: { ...output.organizationUse, changes: [{ ...change, choice: "grant_permission" }] } }), false);
  assert.equal(isCentralDeliberationOutput({ ...output, organizationKnowledge: [{ ...knowledge, verified: true }] }), false);
  assert.equal(isCentralDeliberationOutput({ ...output, organizationKnowledge: [knowledge, knowledge] }), false);
  assert.equal(isCentralDeliberationOutput({ ...output, alternatives: undefined }), false);
});

test("central questions, grounded-derivation envelopes and explicit dispatch destinations remain closed shapes", () => {
  const central = { ...intent, subject: { plane: "central", questionRef: intent.intentId }, derivation: { relation: "A relationship supported by existing material",
    whenRelevant: "When the original conditions differ", parentRefs: ["source:one"], citations: [{ evidenceRef: "source:one", quote: "Original material" }] } };
  const base = { schemaVersion: 1, intents: [central], publicExplanation: "A grounded new learning purpose", sourceRefs: ["source:one"] };

  assert.equal(isCentralDeliberationOutput(base), true);
  assert.equal(isCentralDeliberationOutput({ ...base, intents: [{ ...central, subject: { ...central.subject, domain: "prompt" } }] }), false);
  assert.equal(isCentralDeliberationOutput({ ...base, intents: [{ ...central, derivation: { ...central.derivation, grantPermission: true } }] }), false);
  assert.equal(isCentralDeliberationOutput({ ...base, intents: [{ ...central, derivation: { ...central.derivation,
    citations: [{ evidenceRef: "source:one", quote: "Original material", verified: true }] } }] }), false);

  for (const destination of [{ plane: "agent", domain: "workflow" }, { plane: "user" }]) assert.equal(isCentralLearningOperation({ ...operation, destination }), true);

  assert.equal(isCentralLearningOperation({ ...operation, destination: { plane: "agent", domain: "routing" } }), false);
  assert.equal(isCentralLearningOperation({ ...operation, destination: { plane: "user", ledgerRef: "undeclared" } }), false);
  assert.equal(isCentralLearningOperation({ ...operation, kind: "consult", destination: { plane: "user" } }), false);
});
