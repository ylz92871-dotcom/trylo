import assert from "node:assert/strict";
import { test } from "node:test";
import { fromJSONSchema } from "zod";
import type { JsonObject } from "../../protocol/envelope.js";
import type { CentralLearningIntentDraft, CentralLearningOperation, CentralLearningWait } from "../../learning/central/runtime/contracts.js";
import { isCentralDeliberationOutput } from "../../learning/central/runtime/validation.js";
import { centralDeliberationResponseSchema } from "./deliberation-schema.js";

const allowance = { schemaVersion: 2, unit: "total_model_tokens", maxTokens: 20000, maxCalls: 2, maxSteps: 2, maxPromptChars: 10000 } as const;
const purpose = { operationId: "op:next", purpose: "Resolve the original boundary question", expectedChange: "Choose a useful next investigation", sourceRefs: ["source:trace"] };
const intent = (continuation: CentralLearningIntentDraft["continuation"]): CentralLearningIntentDraft => ({
  intentId: "intent:boundary", subject: { plane: "agent", domain: "tool", issueId: "issue:boundary" },
  goal: "Learn when the tool contract applies", rationale: "Two failures share a boundary", conditions: ["Original goal remains relevant"],
  knowledge: [{ statement: "The second case differs", conditions: "Existing record only", sourceRefs: ["source:trace"] }],
  residual: ["Does the altered prerequisite explain the failure?"], commitment: { purpose: "Keep the user goal", assumptions: [], reconsiderWhen: ["Contrary evidence"] },
  revisionReason: "Consider the observed prerequisite", sourceRefs: ["source:trace"], continuation,
});
const output = (continuation: CentralLearningIntentDraft["continuation"]): JsonObject => ({ schemaVersion: 1,
  intents: [JSON.parse(JSON.stringify(intent(continuation)))], publicExplanation: "Keep the purpose while changing the research means", sourceRefs: ["source:trace"] });
const wire = <T extends object>(value: T) => ({ ...value, alternatives: [], organizationUse: null, organizationKnowledge: [],
  ...("intents" in value && Array.isArray(value.intents) ? { intents: value.intents.map(item => ({ ...item, derivation: item.derivation ?? null,
    continuation: item.continuation?.kind === "ready" && item.continuation.operation?.kind === "dispatch"
      ? { ...item.continuation, operation: { ...item.continuation.operation, destination: item.continuation.operation.destination ?? null } }
      : item.continuation })) } : {}) });

test("deliberation wire schema admits every domain continuation and both peer subjects", () => {
  const schema = fromJSONSchema(centralDeliberationResponseSchema());
  const operations: CentralLearningOperation[] = [{ ...purpose, kind: "think" }, { ...purpose, kind: "read", refs: ["source:trace"], maximumChars: 8192 },
    { ...purpose, kind: "consult", allowance }, { ...purpose, kind: "dispatch", allowance }];
  const waits: CentralLearningWait[] = ["facts", "use_feedback", "resources"].map(kind => ({ kind, sourceRefs: ["source:trace"], reason: "Await the owning fact" } as CentralLearningWait));

  waits.push({ kind: "until", at: 1_800_000_000_000, sourceRefs: [], reason: "Revisit at an explicit useful time" });
  const continuations: CentralLearningIntentDraft["continuation"][] = [...operations.map(operation => ({ kind: "ready" as const, operation })),
    ...waits.map(wait => ({ kind: "waiting" as const, wait })), ...["open", "answered", "withdrawn"].map(goalState =>
      ({ kind: "ended" as const, goalState, reason: "End this investment" } as CentralLearningIntentDraft["continuation"]))];

  for (const continuation of continuations) {
    const value = output(continuation);
    assert.equal(isCentralDeliberationOutput(value), true);
    assert.equal(schema.safeParse(wire(value)).success, true, JSON.stringify(continuation));
  }

  const user = intent({ kind: "ready", operation: operations[0]! });
  const userOutput = { schemaVersion: 1, intents: [{ ...user, subject: { plane: "user", ledgerRef: "ledger:original", questionRef: "question:original" } }],
    publicExplanation: "User Learning remains a peer", sourceRefs: [] };

  assert.equal(isCentralDeliberationOutput(userOutput), true);
  assert.equal(schema.safeParse(wire(userOutput)).success, true);
});

test("deliberation schema rejects malformed actions before any action is dispatched", () => {
  const schema = fromJSONSchema(centralDeliberationResponseSchema());
  const invalid = [
    { ...purpose, kind: "read", refs: [], maximumChars: 0 },
    { ...purpose, kind: "dispatch", allowance: { ...allowance, unit: "output_tokens" } },
    { ...purpose, kind: "think", permission: "grant" },
    { ...purpose, kind: "unknown_action" },
  ];

  for (const operation of invalid) assert.equal(schema.safeParse(wire({ schemaVersion: 1,
    intents: [{ ...intent({ kind: "ended", goalState: "open", reason: "Open" }), continuation: { kind: "ready", operation } }],
    publicExplanation: "Invalid transport", sourceRefs: [] })).success, false);

  assert.equal(schema.safeParse(wire({ schemaVersion: 1, intents: [], sourceRefs: [] })).success, false);
  assert.equal(schema.safeParse(wire({ schemaVersion: 1, intents: [], publicExplanation: "", sourceRefs: [], hiddenReasoning: "private" })).success, false);
});

test("strict wire fields carry considered alternatives and actual organization-use changes", () => {
  const schema = fromJSONSchema(centralDeliberationResponseSchema());
  const legacy = output({ kind: "ended", goalState: "open", reason: "Await feedback" });

  assert.equal(isCentralDeliberationOutput(legacy), true, "old public checkpoints remain readable");
  const organizationUse = { recallRef: "recall:matching", changes: [{ knowledgeFactId: "knowledge:boundary", choice: "program",
    before: "Repeat the broad search", after: "Compare the missing prerequisite", reason: "The recalled counterexample limits the original method" }] };
  const current = { ...wire(legacy), alternatives: ["Wait for use", "Compare prerequisites"], organizationUse };

  assert.equal(isCentralDeliberationOutput({ ...legacy, alternatives: current.alternatives, organizationUse }), true);
  assert.equal(schema.safeParse(current).success, true);
  assert.equal(schema.safeParse(wire(legacy)).success, true, "no recall has an explicit wire null");
  assert.equal(schema.safeParse(legacy).success, false, "new strict provider output must include the transport fields");
  assert.equal(schema.safeParse({ ...current, organizationUse: { ...organizationUse, changes: [{ ...organizationUse.changes[0], choice: "grant_permission" }] } }).success, false);
  assert.equal(schema.safeParse({ ...current, alternatives: [7] }).success, false);
  assert.equal(schema.safeParse({ ...current, deliveryRef: "forged:delivery" }).success, false);
  const longRef = `source:${"x".repeat(400)}`;

  assert.equal(schema.safeParse({ ...wire(legacy), sourceRefs: [longRef] }).success, true);
});

test("organization knowledge keeps conditions and original support in a closed public shape", () => {
  const schema = fromJSONSchema(centralDeliberationResponseSchema());
  const legacy = output({ kind: "ended", goalState: "open", reason: "Await feedback" });
  const knowledge = { kind: "knowledge", knowledgeId: "knowledge:prerequisite", supersedes: null,
    statement: "Check a missing prerequisite before repeating research", conditions: "The original failure concerns a contract boundary",
    conditionKeys: ["contract_boundary"], exceptions: "Do not apply where the contract is already known", exceptionKeys: ["known_contract"],
    implication: "Compare the prerequisite before commissioning a broad search", supportFactIds: ["feedback:original"],
    counterexampleFactIds: [], state: "proposed" };
  const current = { ...wire(legacy), organizationKnowledge: [knowledge] };

  assert.equal(isCentralDeliberationOutput({ ...legacy, alternatives: [], organizationKnowledge: [knowledge] }), true);
  assert.equal(schema.safeParse(current).success, true);
  assert.equal(schema.safeParse({ ...current, organizationKnowledge: [{ ...knowledge, supportFactIds: [] }] }).success, false);
  assert.equal(schema.safeParse({ ...current, organizationKnowledge: [{ ...knowledge, deliveryRef: "forged:delivery" }] }).success, false);
  assert.equal(schema.safeParse({ ...current, organizationKnowledge: [{ ...knowledge, state: "verified" }] }).success, false);
});

test("grounded central purposes carry derivation and explicit Agent or User dispatch destination", () => {
  const schema = fromJSONSchema(centralDeliberationResponseSchema());
  const destinations = [{ plane: "agent", domain: "workflow" }, { plane: "user" }] as const;
  const derivation = { relation: "The two original cases share a contract prerequisite", whenRelevant: "A future cross-specialty handoff has the same prerequisite",
    parentRefs: ["source:trace"], citations: [{ evidenceRef: "source:trace", quote: "required reviewer is absent" }] };

  for (const destination of destinations) {
    const central: CentralLearningIntentDraft = { ...intent({ kind: "ready", operation: { ...purpose, kind: "dispatch", allowance, destination } }),
      subject: { plane: "central", questionRef: "intent:boundary" }, derivation };
    const canonical = { schemaVersion: 1, intents: [central], publicExplanation: "Investigate the grounded relation", sourceRefs: ["source:trace"] };

    assert.equal(isCentralDeliberationOutput(canonical), true);
    assert.equal(schema.safeParse(wire(canonical)).success, true);
    const malformed = { ...central, derivation: { ...derivation, citations: [{ evidenceRef: "source:trace" }] } };

    assert.equal(schema.safeParse(wire({ ...canonical, intents: [malformed] })).success, false);
    const wrongSubject = { ...central, subject: { ...central.subject, domain: "workflow" } };

    assert.equal(schema.safeParse(wire({ ...canonical, intents: [wrongSubject] })).success, false);
  }

  const think = { ...purpose, kind: "think", destination: { plane: "user" } };
  const invalid = { ...output({ kind: "ended", goalState: "open", reason: "Open" }),
    intents: [{ ...intent({ kind: "ended", goalState: "open", reason: "Open" }), continuation: { kind: "ready", operation: think } }] };

  assert.equal(schema.safeParse(wire(invalid)).success, false, "only dispatch has a destination field");
});
