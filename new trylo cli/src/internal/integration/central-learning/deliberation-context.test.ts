import assert from "node:assert/strict";
import test from "node:test";
import type { CentralDeliberationRequest, CentralRuntimeMaterial } from "../../learning/central/runtime/contracts.js";
import { emptyCentralRuntimeState } from "../../learning/central/runtime/records.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { buildOrganizationRecord } from "../../learning/central/organization/records.js";
import { createOrganizationFeedbackMaterial } from "./organization-feedback-material.js";
import { createOrganizationPublicationCondition } from "./organization-publication-material.js";
import { centralDeliveredSourceRefs, packCentralDeliberationContext } from "./deliberation-context.js";
import { isCentralUnreadNavigationMaterial } from "../../learning/central/runtime/material-role.js";
import { centralMaterialNavigation } from "./deliberation-navigation.js";
import { readActivePurposeDelivery } from "./active-purpose-delivery.js";
import { centralAgendaReadReviewId } from "../../learning/central/runtime/working-set.js";
import { nativeChangeCatalog, nativeChangeReadRef } from "./runtime-source-changes.js";
import { centralMaterialReadInventory } from "./deliberation-read-inventory.js";
import { validateCentralDeliberationSources } from "./deliberation-prompt.js";
import { isCentralDeliberationReceiptRequest } from "./deliberation-receipts.js";

const scope = "workspace:delivery-budget";

function request(): CentralDeliberationRequest {
  return { schemaVersion: 1, scope, budgetId: "budget:delivery",
    configuration: { schemaVersion: 1, configurationRef: "config:delivery", authorizationRef: "auth:delivery",
      allowance: { schemaVersion: 2, unit: "total_model_tokens", maxTokens: 100000, maxCalls: 4, maxSteps: 4, maxPromptChars: 7000 } },
    boardSequence: 1, resources: { boardSequence: 1, budgetId: "budget:delivery", limits: { tokens: 100000, calls: 4, steps: 4 },
      occupied: { tokens: 0, calls: 0, steps: 0 }, available: { tokens: 100000, calls: 4, steps: 4 }, status: "available", holdReason: null },
    stateRef: "state:delivery", state: emptyCentralRuntimeState(scope), opportunities: [], organization: [], materials: [],
    operation: { kind: "think", operationId: "operation:delivery", purpose: "Inspect the returned interface contract.",
      expectedChange: "Reconsider the old handoff premise.", sourceRefs: [] } };
}

const all = (value: CentralDeliberationRequest) => [...value.materials, ...value.organization, ...value.state.materials];

test("host recall beyond one wire collection is validated and packed without losing the required original", () => {
  const original = request(), organization = Array.from({ length: 262 }, (_, index) => ({ ref: `recalled-original:${index}`,
    kind: "source" as const, text: `The original recalled condition ${index}.`, sourceRefs: [`evidence:${index}`] }));
  const required = organization.at(-1)!;
  const input = { ...original, organization, operation: { ...original.operation,
    operationId: "central-agenda-read-review:oversized-recall", sourceRefs: [required.ref] } };
  assert.equal(isCentralDeliberationReceiptRequest(input), false, "262 original rows are not a legal serialized delivery");
  validateCentralDeliberationSources(input, []);
  const packed = packCentralDeliberationContext(input, candidate => {
    assert.ok(isCentralDeliberationReceiptRequest(candidate), "every candidate sent for quotation satisfies the wire row capacity");
    return true;
  });
  assert.ok(isCentralDeliberationReceiptRequest(packed));
  assert.deepEqual(all(packed).find(row => row.ref === required.ref), required);
  assert.equal(input.organization.length, 262, "packing does not delete original recall records");
  assert.throws(() => validateCentralDeliberationSources({ ...input, organization: [...organization.slice(0, -1),
    { ...required, text: 1 } as unknown as CentralRuntimeMaterial] }, []), /central_deliberation_input_invalid/);
  assert.throws(() => validateCentralDeliberationSources({ ...input, organization: [...organization.slice(0, -1),
    { ...required, text: "private-source-collection-value" }] }, ["private-source-collection-value"]), /central_deliberation_input_invalid/,
  "original bodies are checked for credentials even if a wire collection would omit them");
});

test("returned-original review carries its actual body or refuses before funding", () => {
  const returned = { ref: "original-return:actual-method-body", kind: "source" as const,
    text: "The actual returned method body, not its directory or an owned-purpose summary.", sourceRefs: ["source:method"] };
  const original = request(), input = { ...original, materials: [returned], operation: { ...original.operation,
    operationId: "central-agenda-read-review:actual-return", sourceRefs: ["read:original", returned.ref] } };
  const packed = packCentralDeliberationContext(input, () => true);
  assert.deepEqual(all(packed).find(row => row.ref === returned.ref), returned);
  assert.throws(() => packCentralDeliberationContext(input,
    candidate => !all(candidate).some(row => row.ref === returned.ref)), /central_deliberation_context_capacity/,
  "a cheaper directory-only input is not permission to buy an original-body review");
  const read = { intentId: "central:agenda", operation: { kind: "read" as const, operationId: "read:original",
    purpose: "Read the original", expectedChange: "Review its actual body", sourceRefs: [], refs: [returned.ref], maximumChars: 2048 },
    outcome: "returned" as const, resultRefs: [returned.ref], publicResult: "The original read returned" };
  const recovery = { ...input, operation: { ...input.operation, operationId: "central-recover-thought:original-review" },
    state: { ...input.state, completed: [read] } };
  assert.deepEqual(all(packCentralDeliberationContext(recovery, () => true)).find(row => row.ref === returned.ref), returned);
  assert.throws(() => packCentralDeliberationContext(recovery,
    candidate => !all(candidate).some(row => row.ref === returned.ref)), /central_deliberation_context_capacity/,
  "a new recovery identity cannot turn the same original dependency into a directory-only call");
  const fragment = { ...returned, ref: "original-return:last-fragment", text: "The last actually returned page has a different condition." };
  const interrupted = { intentId: "central:agenda", operation: { ...input.operation, sourceRefs: [...input.operation.sourceRefs, fragment.ref] },
    outcome: "unknown" as const, resultRefs: [], publicResult: "The original review response is unconfirmed" };
  const cold = { ...recovery, materials: [returned, fragment],
    operation: { ...recovery.operation, sourceRefs: [interrupted.operation.operationId, ...interrupted.operation.sourceRefs] },
    state: { ...recovery.state, completed: [interrupted] } };
  assert.throws(() => packCentralDeliberationContext(cold,
    candidate => !all(candidate).some(row => row.ref === fragment.ref)), /central_deliberation_context_capacity/,
  "compacting the settled read cannot allow recovery to omit just its last returned fragment");
});

test("focused PA coordination advertises the original report read without claiming its body", () => {
  const originalRef = "central-runtime-issue:original-focused-report";
  const body = { role: "PA_current_constraint_not_business_evidence", issueId: "issue:focused",
    decision: { kind: "focused_learning" }, readRef: originalRef };
  const text = canonicalJson(body), material = { ref: `central-runtime-constraint:${contentHashOf(text)}`,
    kind: "source" as const, text, sourceRefs: [] };
  const input = { ...request(), materials: [material] };
  assert.ok(centralMaterialReadInventory(input, all(input)).advertised.has(originalRef));
  assert.ok(!centralDeliveredSourceRefs(input).includes(originalRef), "a read locator is not delivery of its report");
  const { readRef: _read, ...oldBody } = body, oldText = canonicalJson(oldBody);
  const legacy = { ...material, ref: `central-runtime-constraint:${contentHashOf(oldText)}`, text: oldText };
  assert.ok(!centralMaterialReadInventory(input, [legacy]).advertised.has(originalRef), "historical constraints keep their exact old menu");
  assert.ok(!centralMaterialReadInventory(input, [{ ...material, text: text + " " }]).advertised.has(originalRef));
});

test("native feedback navigation delivers selected change notices without claiming feedback bodies", () => {
  const change = { domain: "prompt" as const, issueId: "issue:method", factRef: "method-observation:one",
    unitRef: "method-exposure:one", revisionRef: "method-observation:one:revision:0", kind: "quality" as const,
    sourceRefs: ["method-version:one", "method-exposure:one"] };
  const other = { ...change, factRef: "method-observation:two", revisionRef: "method-observation:two:revision:0" };
  const source = nativeChangeCatalog([change, other])[0]!;
  const input = { ...request(), materials: [source], operation: { ...request().operation, sourceRefs: [change.revisionRef] } };
  const packed = packCentralDeliberationContext(input, candidate => !all(candidate).some(row => row.ref === source.ref));
  const shown = all(packed).find(row => row.sourceRefs.includes(change.revisionRef));
  assert.ok(shown);
  const body = JSON.parse(shown.text);

  assert.equal(body.role, "central_source_body_not_delivered");
  assert.deepEqual(body.nativeChangeReads, [{ noticeRef: change.revisionRef, readRef: nativeChangeReadRef(change),
    issueId: change.issueId, domain: change.domain, kind: change.kind }]);
  assert.ok(centralDeliveredSourceRefs(packed).includes(change.revisionRef));
  assert.ok(!centralDeliveredSourceRefs(packed).includes(other.revisionRef));
  assert.ok(!centralDeliveredSourceRefs(packed).includes(change.factRef));
  assert.ok(!all(packed).some(row => row.ref === nativeChangeReadRef(change)));
  assert.equal(isCentralUnreadNavigationMaterial(shown), true);
  assert.ok(centralMaterialReadInventory(packed, all(packed)).advertised.has(nativeChangeReadRef(change)),
    "a displayed feedback address must also be an actual selectable read");
  const { nativeChangeReads, ...priorBody } = body;
  const legacyBody = { ...priorBody, nativeChangeNotices: nativeChangeReads };
  const legacy = { ...shown, ref: `central-source-navigation:${contentHashOf(legacyBody)}`, text: canonicalJson(legacyBody) };

  assert.ok(!centralMaterialReadInventory(packed, [legacy]).advertised.has(nativeChangeReadRef(change)),
    "the earlier frozen navigation had no native read choices; do not reinterpret its receipt handles");
  const value = JSON.parse(source.text);

  value.entries[0].readRef = nativeChangeReadRef(other);
  const badText = canonicalJson(value), bad = { ...source, ref: `central-runtime-native-catalog:${contentHashOf(badText)}`, text: badText };

  for (const invalid of [bad, { ...source, sourceRefs: [...source.sourceRefs, "notice:unproven"] }, { ...source, text: source.text + " " }]) {
    const rejected = packCentralDeliberationContext({ ...input, materials: [invalid] }, () => true);
    assert.ok(!centralDeliveredSourceRefs(rejected).includes(change.revisionRef));
  }

  const opaque = packCentralDeliberationContext(input, candidate => !all(candidate).some(row => row.text.includes('"nativeChangeReads"')));

  assert.ok(!centralDeliveredSourceRefs(opaque).includes(change.revisionRef));
});

test("selected native adoption and outcome feedback require original bodies before paid reconsideration", () => {
  const results = [{ kind: "adoption" as const, state: "used" as const, artifactRefs: ["advisory:original-version"], exposureRef: "exposure:actual-delivery" },
    { kind: "outcome" as const, state: "unknown" as const, attribution: "unknown" as const,
      summary: "An actual use was reported; its benefit remains unknown.", exposureRef: null }];
  for (const result of results) {
    const original = request(), value = { kind: "feedback" as const, decisionRef: "decision:original", unitRef: `unit:${result.kind}`,
      supersedes: null, sourceRefs: ["session:original-use"], result };
    const factId = buildOrganizationRecord(scope, value).id, body = createOrganizationFeedbackMaterial(scope, factId, value);
    const input = { ...original, materials: [body], operation: { ...original.operation, sourceRefs: [factId] } };
    const packed = packCentralDeliberationContext(input, candidate => canonicalJson(candidate).length <= 7000);

    assert.ok(all(packed).some(row => canonicalJson(row) === canonicalJson(body)));
    assert.ok(centralDeliveredSourceRefs(packed).includes(factId));
    assert.throws(() => packCentralDeliberationContext(input, candidate => !all(candidate).some(row => row.ref === body.ref)),
      /central_deliberation_context_capacity/, "optional history or a navigation address cannot replace the selected native feedback");
  }
});

test("the actual provider connection reaches reconsideration as a complete control condition", () => {
  const original = request(), text = canonicalJson({ role: "actual_provider_connection_not_business_evidence", scope,
    providerId: "provider:original", model: "model:changed", providerConnectionRef: "connection:changed", decisionFormat: "action_tool",
    decisionVersion: "central-learning-single-action-v7" });
  const condition: CentralRuntimeMaterial = { ref: `central-runtime-constraint:${contentHashOf(text)}`,
    kind: "source", text, sourceRefs: [] };
  const input = { ...original, materials: [condition], operation: { ...original.operation, sourceRefs: [condition.ref] } };
  const packed = packCentralDeliberationContext(input, candidate => canonicalJson(candidate).length <= 7000);

  assert.ok(all(packed).some(row => canonicalJson(row) === canonicalJson(condition)));
  assert.throws(() => packCentralDeliberationContext(input, candidate => !all(candidate).some(row => row.ref === condition.ref)),
    /central_deliberation_context_capacity/, "a missing connection body cannot acknowledge a changed provider");
});

test("a changed original budget remains a delivered control when optional bodies cannot fit", () => {
  const original = request(), rootRef = { budgetId: original.budgetId, scope, openedSequence: 1, authorizationRef: "auth:delivery" };
  const change = { changeId: "change:actual", limits: { tokens: 200000, calls: 8, steps: 8 },
    authorizationRef: rootRef.authorizationRef, changedAt: "2026-11-07T00:00:00Z", changedSequence: 2 };
  const sourceRef = `central-budget-change:${contentHashOf({ budgetId: rootRef.budgetId, changeId: change.changeId })}`;
  const text = canonicalJson({ schemaVersion: 1, role: "original_root_budget_limit_change_not_business_evidence", rootRef, change });
  const condition: CentralRuntimeMaterial = { ref: `central-runtime-constraint:${contentHashOf(text)}`,
    kind: "source", text, sourceRefs: [rootRef.budgetId, sourceRef] };
  const input = { ...original, materials: [condition], operation: { ...original.operation, sourceRefs: [sourceRef] } };
  const packed = packCentralDeliberationContext(input, () => true);

  assert.ok(centralDeliveredSourceRefs(packed).includes(sourceRef));
  assert.throws(() => packCentralDeliberationContext(input, candidate => !all(candidate).some(row => row.ref === condition.ref)),
    /central_deliberation_context_capacity/, "resource changes must be admitted whole rather than lost as optional navigation");
});

test("an actual returned read and source correction get bodies before historical relationship directories", () => {
  const original = request(), body: CentralRuntimeMaterial = { ref: "source:requested-interface", kind: "source",
    text: "Actual receiver interface: numeric seconds. ".repeat(45), sourceRefs: ["source:receiver"] };
  const feedback = { kind: "feedback" as const, decisionRef: "decision:original", unitRef: "source:actual-correction", supersedes: null,
    sourceRefs: ["source:receiver"], result: { kind: "correction" as const,
      statement: "The receiver requires numeric seconds; the earlier value/unit premise does not apply.", conditions: "This receiver contract only." } };
  const correction = createOrganizationFeedbackMaterial(scope, buildOrganizationRecord(scope, feedback).id, feedback);
  const decisionText = canonicalJson({ role: "PA_current_constraint_not_business_evidence", issueId: "issue:current",
    decision: { kind: "ordinary_execution", reason: "Use the actual contract in the ordinary task; do not continue the old learning commitment.",
      sourceRefs: ["source:receiver"], decidedAt: "2026-11-05T00:00:00.000Z", revision: 2 } });
  const decision: CentralRuntimeMaterial = { ref: `central-runtime-constraint:${contentHashOf(decisionText)}`,
    kind: "source", text: decisionText, sourceRefs: [] };
  const input: CentralDeliberationRequest = { ...original, operation: { ...original.operation, sourceRefs: [decision.ref] },
    state: { ...original.state, completed: [{ intentId: "intent:original",
    operation: { kind: "read", operationId: "operation:requested-read", purpose: "Read the original interface.",
      expectedChange: "Inspect its real numeric contract.", sourceRefs: [body.ref], refs: [body.ref], maximumChars: 4000 },
    outcome: "returned", resultRefs: [body.ref], publicResult: "The original source returned." }] }, materials: [body, decision],
  organization: [...Array.from({ length: 12 }, (_, index): CentralRuntimeMaterial => ({ ref: `organization-feedback-relations:${index}`,
    kind: "organization", sourceRefs: [], text: canonicalJson({ role: "organization_feedback_relationship_catalog_not_read_body",
      readRef: `source:historical-relationship:${index}`, description: "Historical relationship navigation. ".repeat(25) }) })), correction] };
  const packed = packCentralDeliberationContext(input, candidate => canonicalJson(candidate).length <= 7000);

  assert.ok(all(packed).some(row => canonicalJson(row) === canonicalJson(body)));
  assert.ok(all(packed).some(row => canonicalJson(row) === canonicalJson(correction)));
  assert.ok(all(packed).some(row => canonicalJson(row) === canonicalJson(decision)));
  assert.ok(canonicalJson(packed).length <= 7000);
  assert.deepEqual(packed.operation, input.operation);
  assert.throws(() => packCentralDeliberationContext(input, candidate => !all(candidate).some(row => row.ref === decision.ref)),
    /central_deliberation_context_capacity/);
  const opaque = { ...input, materials: [body, centralMaterialNavigation(decision,
    { priority: 0, navigationOnly: false, companionRefs: [] })] };

  assert.throws(() => packCentralDeliberationContext(opaque, () => true), /central_deliberation_context_capacity/,
    "an upstream manifest cannot acknowledge the selected PA decision's unseen body");
});

test("a selected publication condition is delivered whole or waits before a model call", () => {
  const original = request(), condition = createOrganizationPublicationCondition(scope, { knowledgeId: "knowledge:prior",
    currentHeadFactId: `organization-record:${"a".repeat(64)}`, reason: "organization_knowledge_revision_conflict" });
  const input = { ...original, materials: [condition], operation: { ...original.operation, sourceRefs: [condition.ref] } };
  const packed = packCentralDeliberationContext(input, candidate => canonicalJson(candidate).length <= 7000);

  assert.ok(all(packed).some(row => canonicalJson(row) === canonicalJson(condition)));
  assert.throws(() => packCentralDeliberationContext(input, candidate => !all(candidate).some(row => row.ref === condition.ref)),
    /central_deliberation_context_capacity/);
});

test("a returned read body remains mandatory for its review after another think completes", () => {
  const original = request(), body: CentralRuntimeMaterial = { ref: "method-research-record:actual-return",
    kind: "work_result", text: "The native method returned its actual prompt boundary. ".repeat(45), sourceRefs: [] };
  const read = { intentId: "central:agenda", operation: { kind: "read" as const, operationId: "read:actual",
    purpose: "Read the method result.", expectedChange: "Understand the native boundary.", sourceRefs: [body.ref],
    refs: [body.ref], maximumChars: 4000 }, outcome: "returned" as const, resultRefs: [body.ref], publicResult: "Returned." };
  const input: CentralDeliberationRequest = { ...original, materials: [body],
    operation: { ...original.operation, sourceRefs: [read.operation.operationId, body.ref] },
    state: { ...original.state, completed: [read, { intentId: "central:agenda", operation: original.operation,
      outcome: "returned", resultRefs: [], publicResult: "A previous review saw only navigation." }] } };
  const packed = packCentralDeliberationContext(input, candidate => canonicalJson(candidate).length <= 7000);

  assert.ok(all(packed).some(row => canonicalJson(row) === canonicalJson(body)));
  assert.throws(() => packCentralDeliberationContext(input, candidate => !all(candidate).some(row => row.ref === body.ref)),
    /central_deliberation_context_capacity/, "never pay for a review whose returned body was replaced by navigation");
});

test("a referenced native dispatch retains its original unsent boundary", () => {
  const original = request(), result = "原域明确交还，尚未执行：method_research_prompt_or_budget_boundary";
  const dispatch = { intentId: "intent:native", operation: { kind: "dispatch" as const, operationId: "dispatch:native",
    purpose: "Research a method.", expectedChange: "Receive a native finding.", sourceRefs: [],
    destination: { plane: "agent" as const, domain: "prompt" as const }, allowance: original.configuration.allowance },
    outcome: "returned" as const, publicResult: result, resultRefs: ["request:stored-only"] };
  const input = { ...original, operation: { ...original.operation, sourceRefs: [dispatch.operation.operationId] },
    state: { ...original.state, completed: [dispatch] } };
  const packed = packCentralDeliberationContext(input, () => true);

  assert.equal(packed.state.completed[0]!.publicResult, result);
});

test("navigation presents an affordable current purpose without another paid read of owned state", () => {
  const original = request(), intent = { intentId: "intent:owned", subject: { plane: "central" as const, questionRef: "question:owned" },
    goal: "Retain and publish the original receiver condition.", rationale: "A genuine handoff remains unresolved.", conditions: ["Same receiver"],
    knowledge: [{ statement: "Read the receiver contract before converting units.", conditions: "An explicit receiver contract exists.", sourceRefs: ["source:receiver"] }],
    residual: ["Whether it is adopted"], commitment: { purpose: "Compare actual receiver contracts", assumptions: [], reconsiderWhen: ["Actual use returns"] },
    revisionReason: "Preserve the original question", sourceRefs: ["source:receiver"],
    continuation: { kind: "waiting" as const, wait: { kind: "facts" as const, reason: "Await actual use", sourceRefs: ["source:use"] } } };
  const input = { ...original, state: { ...original.state, intents: [intent] } };
  const packed = packCentralDeliberationContext(input, candidate => candidate.activePurposeDelivery !== undefined && canonicalJson(candidate).length < 7000);

  assert.equal(readActivePurposeDelivery(packed).navigation, true);
  assert.deepEqual(readActivePurposeDelivery(packed).visibleIntents, [intent]);
  assert.deepEqual(packed.state.completed, [], "presentation does not invent a source read or execution receipt");
  const body = { ref: "source:receiver", kind: "source" as const, text: "Previously read request body. ".repeat(200), sourceRefs: [] };
  const read = { intentId: "central:agenda", operation: { kind: "read" as const, operationId: "read:prior-receiver",
    purpose: "Read the original receiver", expectedChange: "Inspect its actual contract", sourceRefs: [body.ref], refs: [body.ref], maximumChars: 10000 },
    outcome: "returned" as const, resultRefs: [body.ref], publicResult: "The actual body returned" };
  const review = { intentId: "central:agenda", operation: { ...original.operation,
    operationId: centralAgendaReadReviewId(scope, read), sourceRefs: [read.operation.operationId, body.ref] },
    outcome: "returned" as const, resultRefs: [], publicResult: "Its result has already been considered" };
  const later = packCentralDeliberationContext({ ...input, materials: [body], state: { ...input.state, completed: [read, review] } },
    candidate => candidate.activePurposeDelivery !== undefined && !all(candidate).some(row => row.ref === body.ref));

  assert.deepEqual(readActivePurposeDelivery(later).visibleIntents, [intent]);
  assert.ok(!all(later).some(row => row.ref === body.ref), "an already reviewed ancestor must not permanently displace the current owned purpose");
});

test("a selected source catalog notice remains visible and readable without claiming its report body was read", () => {
  const original = request(), hash = "1".repeat(64), otherHash = "2".repeat(64);
  const noticeRef = `central-runtime-issue-notice:${hash}`, readRef = `central-runtime-issue:${hash}`;
  const otherNotice = `central-runtime-issue-notice:${otherHash}`;
  const value = { role: "original_report_catalog_not_read_body", availableIssues: 2, shownIssues: 2, nextReadRef: null,
    entries: [{ issueId: "issue:current", owner: "collaboration", problem: "duration receiver contract", reportCount: 3,
      role: "original_report", noticeRef, readRef }, { issueId: "issue:other", owner: "skill", problem: "unrelated issue", reportCount: 1,
      role: "original_report", noticeRef: otherNotice, readRef: `central-runtime-issue:${otherHash}` }] };
  const catalog = (text: string, sourceRefs = [noticeRef, otherNotice]): CentralRuntimeMaterial => ({
    ref: `central-runtime-catalog:${contentHashOf(text)}`, kind: "source", text, sourceRefs });
  const source = catalog(canonicalJson(value));
  const input = { ...original, materials: [source], operation: { ...original.operation, sourceRefs: [noticeRef] } };
  const packed = packCentralDeliberationContext(input, candidate => canonicalJson(candidate).length <= 7000);
  const shown = all(packed).find(row => row.sourceRefs.includes(noticeRef));
  assert.ok(shown);
  const body = JSON.parse(shown.text);
  assert.equal(body.role, "central_source_body_not_delivered");
  assert.deepEqual(body.sourceNotices.map((row: { noticeRef: string; readRef: string; problem: string }) =>
    ({ noticeRef: row.noticeRef, readRef: row.readRef, problem: row.problem })), [{ noticeRef, readRef, problem: value.entries[0]!.problem }]);
  assert.ok(centralDeliveredSourceRefs(packed).includes(noticeRef));
  assert.ok(!centralDeliveredSourceRefs(packed).includes(otherNotice));
  assert.equal(isCentralUnreadNavigationMaterial(shown), true);
  assert.ok(!all(packed).some(row => row.ref === readRef || row.ref === source.ref));
  const forgedEntry = { ...value, entries: [{ ...value.entries[0]!, readRef: `central-runtime-issue:${otherHash}` }, value.entries[1]!] };
  const duplicatedNotice = { ...value, entries: [value.entries[0]!, { ...value.entries[1]!, noticeRef, readRef }] };

  for (const invalid of [{ ...source, text: `${source.text} ` }, catalog(canonicalJson(forgedEntry)),
    catalog(canonicalJson(duplicatedNotice), [noticeRef, noticeRef]),
    catalog(canonicalJson(value), [noticeRef, otherNotice, "notice:unproven"])]) {
    const rejected = packCentralDeliberationContext({ ...input, materials: [invalid] }, () => true);
    assert.ok(!centralDeliveredSourceRefs(rejected).includes(noticeRef));
  }

  const opaque = packCentralDeliberationContext(input, candidate => !all(candidate).some(row => row.text.includes('"sourceNotices"')));

  assert.ok(!centralDeliveredSourceRefs(opaque).includes(noticeRef), "an undisplayed notice is not acknowledged");
});

test("business source navigation distinguishes original turns without exposing source bodies", () => {
  const catalog = (sessionId: string, marker: string) => {
    const turnId = `turn-${sessionId}`, lastSourceHash = contentHashOf(`${sessionId}:terminal`);
    const noticeRef = `central-business-turn:${contentHashOf({ sessionId, turnId, journalSequence: 7, sourceHash: lastSourceHash })}`;
    const entries = [{ ref: `source:${sessionId}:result`, address: `session-address:${sessionId}:4`, journalSequence: 4,
      turnId, role: "tool_result", totalChars: 200, preview: marker, previewOmittedChars: 150 },
    { ref: `source:${sessionId}:handback`, address: `session-address:${sessionId}:6`, journalSequence: 6,
      turnId, role: "assistant_text", totalChars: 400, preview: `Created draft-${sessionId}.json with a numeric duration. ${"Visible task handback. ".repeat(10)}UNDELIVERED_TASK_TAIL`, previewOmittedChars: 50 },
    { ref: `source:${sessionId}:terminal`, address: `session-address:${sessionId}:7`, journalSequence: 7,
      turnId, role: "terminal", totalChars: 20, preview: "Execution boundary returned.", previewOmittedChars: 0 }];
    const value = { role: "host_normal_turn_source_catalog_not_read_body", sessionId, turnId, noticeRef, through: 7,
      lastSourceRef: entries[2]!.ref, lastSourceHash, entries, maximumShownEntries: 8 };
    const material = (body: typeof value): CentralRuntimeMaterial => { const text = canonicalJson(body);
    return {
      ref: `central-business-catalog:${contentHashOf(text)}`, kind: "source", text,
      sourceRefs: [body.noticeRef, ...body.entries.flatMap(entry => [entry.ref, entry.address])] }; };

    return { value, material, source: material(value), marker };
  };
  const sources = [catalog("duration-a", "PRIVATE_BODY_A"), catalog("duration-b", "PRIVATE_BODY_B")];
  const original = request(), input = { ...original, materials: sources.map(row => row.source) };
  const packed = packCentralDeliberationContext(input, candidate => canonicalJson(candidate).length <= 7000);

  for (const row of sources) {
    const shown = all(packed).find(material => JSON.parse(material.text).originalRef === row.source.ref);
    assert.ok(shown);
    const view = JSON.parse(shown.text);

    assert.equal(view.businessSource?.sessionId, row.value.sessionId, "the original session identity must distinguish each unread directory");
    assert.equal(view.businessSource.turnId, row.value.turnId);
    assert.equal(view.businessSource.through, row.value.through);
    assert.equal(view.businessSource.lastShownRole, "terminal");
    assert.equal(view.readRef, row.source.ref);
    assert.ok(view.businessSource.taskPreview.text.startsWith(`Created draft-${row.value.sessionId}.json`));
    assert.equal(view.businessSource.taskPreview.role, "assistant_text");
    assert.equal(view.businessSource.taskPreview.journalSequence, 6);
    assert.equal(view.businessSource.taskPreview.text.length, 160);
    assert.ok(view.businessSource.taskPreview.omittedChars > 50);
    assert.equal(view.sourceHash, contentHashOf(row.source.text));
    assert.equal(isCentralUnreadNavigationMaterial(shown), true);
    assert.ok(!shown.text.includes(row.marker) && !shown.text.includes("UNDELIVERED_TASK_TAIL"));
    assert.ok(!all(packed).some(material => material.ref === row.source.ref));
    const delivered = centralDeliveredSourceRefs(packed);
    assert.ok(delivered.includes(row.value.noticeRef));
    assert.ok(row.value.entries.every(entry => !delivered.includes(entry.ref) && !delivered.includes(entry.address)));
  }

  assert.deepEqual(packed.operation, input.operation);
  assert.deepEqual(input.materials, sources.map(row => row.source));
  const row = sources[0]!;

  for (const invalid of [{ ...row.source, text: `${row.source.text} ` },
    { ...row.source, sourceRefs: [...row.source.sourceRefs, "source:unproven"] },
    row.material({ ...row.value, noticeRef: `central-business-turn:${"0".repeat(64)}` })]) {
    const rejected = packCentralDeliberationContext({ ...original, materials: [invalid] }, () => true);
    assert.ok(all(rejected).every(material => JSON.parse(material.text).businessSource === undefined));
    assert.ok(!centralDeliveredSourceRefs(rejected).includes(row.value.noticeRef));
  }

  const history = Array.from({ length: 20 }, (_, index) => {
    const feedback = { kind: "feedback" as const, decisionRef: `decision:history-${index}`, unitRef: `source:history-${index}`,
      supersedes: null, sourceRefs: [`source:history-${index}`], result: { kind: "correction" as const,
        statement: "An earlier task supplied a source-bound correction. ".repeat(8), conditions: "That earlier receiver only." } };
    return createOrganizationFeedbackMaterial(scope, buildOrganizationRecord(scope, feedback).id, feedback);
  });
  const selected = { ...original, materials: [row.source], organization: history,
    operation: { ...original.operation, sourceRefs: [row.value.noticeRef] } };
  const crowded = packCentralDeliberationContext(selected, candidate => canonicalJson(candidate).length <= 7000);

  assert.ok(centralDeliveredSourceRefs(crowded).includes(row.value.noticeRef),
    "a selected business-turn notice must get a bounded delivery opportunity before optional history");
  const selectedView = all(crowded).find(material => material.sourceRefs.includes(row.value.noticeRef));
  assert.ok(selectedView);
  assert.equal(JSON.parse(selectedView.text).businessSource.sessionId, row.value.sessionId);
  assert.ok(!all(crowded).some(material => material.ref === row.source.ref));
  assert.ok(row.value.entries.every(entry => !centralDeliveredSourceRefs(crowded).includes(entry.ref)));
  const compact = packCentralDeliberationContext(input, candidate => !all(candidate).some(material => material.text.includes('"lastSourceHash"')));

  assert.ok(all(compact).every(material => JSON.parse(material.text).businessSource?.sessionId));
  const unsafe = row.material({ ...row.value, entries: row.value.entries.map(entry => entry.role === "assistant_text"
    ? { ...entry, preview: "Open C:\\private-source\\draft.json" } : entry) });
  const hidden = packCentralDeliberationContext({ ...original, materials: [unsafe] }, () => true);

  assert.ok(all(hidden).every(material => JSON.parse(material.text).businessSource?.taskPreview === undefined));
  const opaque = packCentralDeliberationContext(input, candidate => !all(candidate).some(material => material.text.includes('"businessSource"')));

  assert.ok(sources.every(source => !centralDeliveredSourceRefs(opaque).includes(source.value.noticeRef)),
    "address-only fallback cannot acknowledge an undisplayed business-turn identity");

  const owned = { intentId: "intent:ongoing", subject: { plane: "central" as const, questionRef: "question:receiver" },
    goal: "Understand which receiver conditions transfer.", rationale: "Preserve the original uncertainty. ".repeat(150),
    conditions: [], knowledge: [], residual: ["Actual business feedback remains unread."],
    commitment: { purpose: "Inspect actual feedback", assumptions: [], reconsiderWhen: ["New business material"] },
    revisionReason: "Retain the existing purpose", sourceRefs: [], continuation: { kind: "open" as const } };
  const current = { ...original, materials: [row.source], state: { ...original.state, intents: [owned] },
    operation: { ...original.operation, sourceRefs: [row.value.noticeRef] } };
  const visibleSize = (candidate: CentralDeliberationRequest) => canonicalJson({ ...candidate,
    state: { ...candidate.state, intents: readActivePurposeDelivery(candidate).visibleIntents } }).length;
  const capacity = visibleSize({ ...current, materials: [] }) + 700;
  const progressed = packCentralDeliberationContext(current, candidate => visibleSize(candidate) <= capacity);

  assert.ok(centralDeliveredSourceRefs(progressed).includes(row.value.noticeRef),
    "a barely fitting old purpose must not crowd its new business notice out of the actual delivery");
  assert.deepEqual(progressed.state.intents, current.state.intents, "pagination preserves the complete canonical purpose");
  assert.equal(readActivePurposeDelivery(progressed).navigation, true);
  const notice = all(progressed).find(material => material.sourceRefs.includes(row.value.noticeRef));
  assert.ok(notice);
  assert.equal(isCentralUnreadNavigationMaterial(notice), true, "a displayed change remains unread business evidence");
  const repacked = packCentralDeliberationContext(progressed, candidate => visibleSize(candidate) <= capacity);

  assert.ok(centralDeliveredSourceRefs(repacked).includes(row.value.noticeRef),
    "the model's final preparation must retain the notice admitted during driver preflight");
});
