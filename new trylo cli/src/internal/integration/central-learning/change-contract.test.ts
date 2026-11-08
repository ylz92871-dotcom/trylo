import { testScratchPath } from "../../testing/scratch.js";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import type { CentralDeliberationRequest, CentralLearningIntentDraft } from "../../learning/central/runtime/contracts.js";
import { buildOrganizationRecord } from "../../learning/central/organization/records.js";
import type { OrganizationFeedback, OrganizationKnowledge } from "../../learning/central/organization/contracts.js";
import { withBoardWriter } from "../../adapters/learning-store/file-event-store.js";
import { contentHashOf } from "../../learning/control/hash.js";
import { createCentralRuntimeAgentExecution } from "./runtime-agent-execution.js";
import { compileCentralLearningChange, type CentralChangeDictionary } from "./change-compile.js";
import type { CentralIntentChange, CentralLearningChange } from "./change-contract.js";
import { createCentralChangeView } from "./change-input.js";
import { C18_CENTRAL_CHANGE_INPUT_VERSION } from "./change-input-contract.js";
import { decodeCentralDeliberation } from "./deliberation-prompt.js";

const scope = "workspace:change-contract", source = "source:original-handoff", quote = "Reviewer confirmation happened after handoff.";
const navigation = "central-source-navigation:unread-original", recall = "organization:actual-recall", checkpoint = "checkpoint:test";
const allowance = { schemaVersion: 2 as const, unit: "total_model_tokens" as const,
  maxTokens: 32000, maxCalls: 4, maxSteps: 4, maxPromptChars: 60000 };
const subject = { plane: "agent" as const, domain: "workflow" as const, issueId: "issue:original-handoff" };
const feedback: OrganizationFeedback = { kind: "feedback", decisionRef: "decision:original", unitRef: "unit:original", supersedes: null,
  sourceRefs: [source], result: { kind: "progress", summary: "Source inspection identified one missing premise.", remaining: [], resultRefs: [source] } };
const feedbackId = buildOrganizationRecord(scope, feedback).id;
const knowledge: OrganizationKnowledge = { kind: "knowledge", knowledgeId: "knowledge:original", supersedes: null,
  statement: "Inspect the original contract before changing the handoff.", conditions: "Cross-specialty handoffs.", conditionKeys: ["domain:workflow"],
  exceptions: "Same-team cases remain uncertain.", exceptionKeys: ["same-team"], implication: "Read the contract before further investment.",
  supportFactIds: [feedbackId], counterexampleFactIds: [], state: "proposed" };
const knowledgeId = buildOrganizationRecord(scope, knowledge).id;

function request(intents: readonly CentralLearningIntentDraft[] = []): CentralDeliberationRequest {
  return { schemaVersion: 1, scope, budgetId: "budget:original", stateRef: "state:original", boardSequence: 0,
    configuration: { schemaVersion: 1, configurationRef: "configuration:original", authorizationRef: "authorization:original", allowance },
    resources: { boardSequence: 0, budgetId: "budget:original", limits: { tokens: 32000, calls: 4, steps: 4 },
      occupied: { tokens: 0, calls: 0, steps: 0 }, available: { tokens: 32000, calls: 4, steps: 4 }, status: "available", holdReason: null },
    state: { schemaVersion: 1, scope, intents, completed: [], running: [], materials: [], consumedSourceRefs: [] },
    operation: { kind: "think", operationId: "thought:current", purpose: "Choose the next useful inquiry", expectedChange: "Revise only supported commitments", sourceRefs: [source] },
    opportunities: [{ subject, sourceRef: source, description: "The original handoff condition is unresolved.", constraints: [] }],
    materials: [{ ref: source, kind: "source", text: `The source preserves the original PA decision. ${quote}`, sourceRefs: [source] },
      { ref: navigation, kind: "source", text: JSON.stringify({ role: "central_source_body_not_delivered", originalRef: "source:unread",
        readRef: "central-known:unread", description: "The original body has not been delivered." }), sourceRefs: ["source:unread"] }],
    organization: [{ ref: recall, kind: "organization", sourceRefs: [source], text: JSON.stringify({
      role: "organization_hypotheses_not_business_evidence", entries: [{ factId: knowledgeId, knowledge,
        evidence: [{ factId: feedbackId, sequence: 1, value: feedback }] }] }) }] };
}

/** These fixed aliases exercise the historical v3 compiler contract. Current
 * provider tests select their checkpoint and handles from the delivered view. */
function dictionary(input: CentralDeliberationRequest): CentralChangeDictionary {
  const delivered = structuredClone(input), binding = contentHashOf(delivered);
  return Object.freeze({ checkpoint,
    assertRequest: (candidate: CentralDeliberationRequest) => { assert.equal(contentHashOf(candidate), binding, "test_dictionary_request_mismatch"); },
    source: (handle: string) => handle === "S" ? source : handle === "N" ? navigation : undefined,
    read: (handle: string) => handle === "R" ? source : undefined,
    intent: (handle: string) => handle === "I1" ? delivered.state.intents[0] : handle === "I2" ? delivered.state.intents[1] : undefined,
    opportunity: (handle: string) => handle === "O" ? delivered.opportunities[0] : undefined,
    citation: (handle: string, supplied?: string) => handle === "S" ? { evidenceRef: source, quote: supplied ?? quote }
      : handle === "N" ? { evidenceRef: navigation, quote: supplied ?? "The original body has not been delivered." } : undefined,
    recall: (handle: string) => handle === "G" ? recall : undefined,
    knowledge: (handle: string) => handle === "K" ? { factId: knowledgeId, knowledge } : undefined,
    feedback: (handle: string) => handle === "F" ? feedbackId : undefined });
}

const submission = (changes: readonly CentralIntentChange[]): CentralLearningChange => ({ changes,
  explanation: "Use the delivered original condition to revise only the selected commitments.", sources: ["S"] });

function create(key: string, next: Extract<CentralIntentChange, { kind: "create" }>["next"], target = "central"): CentralIntentChange {
  return { kind: "create", key, subject: target, goal: `Understand ${key}`, why: "The original source leaves an applicable uncertainty.",
    grounding: { relation: "The confirmation timing may explain a handoff condition.", whenRelevant: "A later cross-specialty handoff.",
      parents: ["S"], citations: [{ source: "S", quote }] }, conditions: ["The original source is applicable"], knowledge: [],
    residual: ["The timing condition remains unknown"], commitment: { purpose: "Resolve the original uncertainty", assumptions: ["The source is authoritative"],
      reconsiderWhen: ["A contrary source arrives"] }, sources: ["S"], next };
}

function existing(intentId: string): CentralLearningIntentDraft {
  return { intentId, subject, goal: `Original goal ${intentId}`, rationale: "An earlier source-bound purpose", conditions: ["Preserve the earlier condition"],
    knowledge: [{ statement: "Only the observed source condition is established", conditions: "This original source", sourceRefs: [source] }],
    residual: ["A comparison remains useful"], commitment: { purpose: "Resolve the earlier condition", assumptions: ["The source remains applicable"],
      reconsiderWhen: ["The premise changes"] }, revisionReason: "Original commitment", sourceRefs: [source],
    continuation: { kind: "waiting", wait: { kind: "facts", sourceRefs: [source], reason: "Await a discriminating original fact" } } };
}

function compile(value: unknown, input = request(), handles = dictionary(input)) {
  return decodeCentralDeliberation(compileCentralLearningChange(value, input, handles, C18_CENTRAL_CHANGE_INPUT_VERSION),
    input, [], C18_CENTRAL_CHANGE_INPUT_VERSION);
}

test("one submission creates grounded read and dispatch purposes and resolves its selected local key without model-owned IDs", () => {
  const wire = { ...submission([
    create("read-purpose", { kind: "read", purpose: "Inspect the original contract", expectedChange: "Identify its missing premise", sources: ["S"], refs: ["R"], maximumChars: 2048 }),
    create("dispatch-purpose", { kind: "dispatch", purpose: "Compare the observed handoff conditions", expectedChange: "Bound their applicability", sources: ["S"],
      allowance: { maxTokens: 2000, maxCalls: 1, maxSteps: 1, maxPromptChars: 4000 }, destination: { plane: "agent", domain: "workflow" } }),
  ]), next: "dispatch-purpose" };
  const result = compile(wire);
  assert.equal(result.intents.length, 2);
  assert.equal(result.intents[0]!.goal, "Understand dispatch-purpose");
  const read = result.intents[1]!, dispatch = result.intents[0]!;

  assert.notEqual(read.intentId, dispatch.intentId);
  assert.notEqual(read.intentId, "read-purpose");
  assert.deepEqual(read.derivation?.citations, [{ evidenceRef: source, quote }]);
  assert.ok(read.continuation.kind === "ready" && read.continuation.operation.kind === "read");
  assert.deepEqual(read.continuation.operation.refs, [source]);
  assert.deepEqual(read.continuation.operation.sourceRefs, [source]);
  assert.ok(dispatch.continuation.kind === "ready" && dispatch.continuation.operation.kind === "dispatch");
  assert.deepEqual(dispatch.continuation.operation.destination, { plane: "agent", domain: "workflow" });
  assert.notEqual(dispatch.continuation.operation.operationId, read.continuation.operation.operationId);
});

test("sparse revision preserves the other purpose, untouched semantic fields and the original runtime input", () => {
  const input = request([existing("intent:one"), existing("intent:two")]);
  const completed = { kind: "think" as const, operationId: "thought:prior", purpose: "Inspect prior evidence", expectedChange: "Identify a premise", sourceRefs: [source] };
  const original = { ...input, state: { ...input.state, completed: [{ intentId: "intent:one", operation: completed, outcome: "unknown" as const,
    resultRefs: [source], publicResult: "The original output remains unconfirmed" }], running: [{ intentId: "intent:two", workRef: "work:original",
      operation: { ...completed, kind: "dispatch" as const, operationId: "operation:running", allowance }, frame: { originalReceipt: "receipt:original" } }],
    materials: [{ ref: "result:retained", kind: "work_result" as const, text: "Original public result", sourceRefs: [source] }] } };
  const before = structuredClone(original), result = compile(submission([{ kind: "revise", target: "I1", why: "A new source narrows this one question", set: { goal: "A narrower source-bound question" } }]), original);

  assert.equal(result.intents[0]!.goal, "A narrower source-bound question");
  assert.deepEqual(result.intents[1], before.state.intents[1]);

  for (const field of ["conditions", "knowledge", "residual", "commitment", "sourceRefs", "continuation"] as const) {
    assert.deepEqual(result.intents[0]![field], before.state.intents[0]![field]);
  }

  assert.deepEqual(original, before);
});

test("withdrawal preserves the original purpose identity and cannot revive that ID", () => {
  const original = request([existing("intent:withdrawn")]);
  const ended = compile(submission([{ kind: "end", target: "I1", goalState: "withdrawn", why: "The owner withdrew this original investment" }]), original);

  assert.equal(ended.intents[0]!.intentId, "intent:withdrawn");
  assert.deepEqual(ended.intents[0]!.continuation,
    { kind: "ended", goalState: "withdrawn", reason: "The owner withdrew this original investment" });
  const later = { ...original, state: { ...original.state, intents: ended.intents } };

  assert.throws(() => compile(submission([{ kind: "revise", target: "I1", why: "Attempt to reuse the withdrawn identity", set: {
    next: { kind: "think", purpose: "Resume the old investment", expectedChange: "Continue it", sources: ["S"] } } }]), later), /withdrawn|requires_new/);
});

test("organization adoption and proposed knowledge retain original recall, knowledge and feedback provenance", () => {
  const input = request(), handles = dictionary(input);
  const wire: CentralLearningChange = { ...submission([]), organizationUse: { recall: "G", changes: [{ knowledge: "K", choice: "program",
    before: "Change the handoff order", after: "Read the original contract first", reason: "The prior conditional evidence warrants source inspection" }] },
    organizationKnowledge: [{ kind: "propose", key: "source-inspection", statement: "Inspect the original premise before further investment",
      conditions: "An original handoff source is missing", implication: "Read the source before changing coordination", support: ["F"],
      exceptions: "The wider applicability remains unmeasured" }] };
  const result = compile(wire, input, handles);
  assert.equal(result.organizationUse?.recallRef, recall);
  assert.equal(result.organizationUse?.changes[0]!.knowledgeFactId, knowledgeId);
  assert.deepEqual(result.organizationKnowledge?.[0]!.supportFactIds, [feedbackId]);
  const missingRecall = { ...input, organization: [] };

  assert.throws(() => compile(wire, missingRecall, dictionary(missingRecall)), /organization_use_unbound|organization_support_unbound/);
});

test("typed handles, unread grounding and the new facade boundary cannot bypass the original guards", () => {
  const read = create("wrong-kind", { kind: "read", purpose: "Read a source", expectedChange: "Inspect it", sources: ["S"], refs: ["K"], maximumChars: 2048 });

  assert.throws(() => compile(submission([read])), /central_learning_change_handle_unbound/);
  const unread = create("unread", { kind: "wait", for: "facts", reason: "The source body is unread", sources: ["N"] });

  assert.ok(unread.kind === "create");
  const raw = { ...unread, sources: ["N"], grounding: { relation: "A suggested relation is unverified", whenRelevant: "After reading the original body",
    parents: ["N"], citations: [{ source: "N", quote: "The original body has not been delivered." }] } };

  assert.throws(() => compile(submission([raw])), /citation_unread|unread_navigation/);
  const input = request();

  assert.throws(() => compileCentralLearningChange({ schemaVersion: 1, intents: [], publicExplanation: "A complete old agenda is not the advertised new facade", sourceRefs: [] },
    input, dictionary(input), C18_CENTRAL_CHANGE_INPUT_VERSION), /central_learning_change_invalid/);
  assert.throws(() => compile({ ...submission([]), checkpoint: "checkpoint:other-delivery" }));
  const actual = createCentralChangeView(input, C18_CENTRAL_CHANGE_INPUT_VERSION);

  assert.throws(() => compileCentralLearningChange(submission([]), { ...input, stateRef: "state:another-delivery" }, actual.dictionary, C18_CENTRAL_CHANGE_INPUT_VERSION),
    /central_input_checkpoint_mismatch/);
});

test("an explicit oversized dispatch remains unchanged by compilation and is refused by the original runtime funding guard", { timeout: 15000 }, async t => {
  const input = request(), explicit = { maxTokens: 64000, maxCalls: 4, maxSteps: 4, maxPromptChars: 60000 };
  const result = compile(submission([create("oversized", { kind: "dispatch", purpose: "Compare original handoffs", expectedChange: "Resolve their condition",
    sources: ["S"], allowance: explicit, destination: { plane: "agent", domain: "workflow" } }, "O")]), input);
  const selected = result.intents[0]!;
  assert.ok(selected.continuation.kind === "ready" && selected.continuation.operation.kind === "dispatch");
  assert.deepEqual(selected.continuation.operation.allowance, { schemaVersion: 2, unit: "total_model_tokens", ...explicit });
  const parent = testScratchPath("central-change-budget");
  await mkdir(parent, { recursive: true });
  const boardRoot = await mkdtemp(path.join(parent, "case-"));

  t.after(async () => {
    assert.equal(path.dirname(path.resolve(boardRoot)), parent);
    await rm(boardRoot, { recursive: true, force: true });
  });
  const seeded = await withBoardWriter(boardRoot, async board => {
    const report = await board.apply({ type: "coordinate_learning", commandId: "report:original", issuedAt: "2026-11-05T06:00:00.000Z", action: {
      kind: "report", scope, issueId: subject.issueId, problemKey: "original-handoff", report: { reportId: source,
        source: { subsystem: "workflow", taskId: "task:original", versionId: "workflow:original" }, facts: ["The original source is unresolved"], evidenceRefs: [source] } } });

    assert.ok(report.ok);
    const loaded = await board.load();
    assert.ok(loaded.ok);

    return board.apply({ type: "coordinate_learning", commandId: "budget:original", issuedAt: "2026-11-05T06:00:00.000Z", action: {
      kind: "open_budget", expectedSequence: loaded.state.sequence, budget: { schemaVersion: 1, budgetId: input.budgetId, scope,
        unit: "total_model_tokens", limits: input.resources.limits, authorizationRef: input.configuration.authorizationRef } } });
  });
  assert.ok(seeded.ok, JSON.stringify(seeded));
  const runtime = createCentralRuntimeAgentExecution({ boardRoot, scope, ports: [], enabled: () => true, now: () => "2026-11-05T06:00:00.000Z",
    rootAllowance: allowance, authorizationRef: input.configuration.authorizationRef,
    control: { async decide() { assert.fail("An oversized operation cannot focus or fund its original issue"); } } });

  await assert.rejects(runtime.prepare({ scope, intent: selected, operation: selected.continuation.operation,
    configuration: input.configuration, signal: new AbortController().signal }), /allowance_exceeds_authorization/);
});
