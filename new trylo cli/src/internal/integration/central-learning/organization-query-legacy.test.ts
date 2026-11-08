import assert from "node:assert/strict";
import test from "node:test";
import type { OrganizationDecision, OrganizationFeedback, OrganizationKnowledge } from "../../learning/central/organization/contracts.js";
import type { CentralDeliberationOutput, CentralDeliberationRequest, CentralLearningIntentDraft,
  CentralRuntimeMaterial } from "../../learning/central/runtime/contracts.js";
import type { RewardV2Draft, RewardV2Fact } from "../../learning/reward/v2-facts.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { createCentralOrganizationService, isOrganizationRecordContentSafe, type OrganizationPublication } from "./organization-service.js";
import { createCentralRuntimeOrganization } from "./runtime-organization.js";
import { createCentralDeliberationReceiptsAtRoot } from "./deliberation-receipts.js";
import { centralMaterialFromPage } from "./deliberation-material.js";
import { decodeCentralDeliberation } from "./deliberation-prompt.js";
import { centralOrganizationDeliberationRef } from "./organization-feedback-runtime.js";
import { buildCentralRuntimeRecord, emptyCentralRuntimeState, initialCentralRuntimeRef } from "../../learning/central/runtime/records.js";

const scope = "D:\\legacy-query-fixture\\workspace", signal = new AbortController().signal;
const allowance = { schemaVersion: 2, unit: "total_model_tokens", maxTokens: 32000, maxCalls: 4, maxSteps: 4,
  maxPromptChars: 100000 } as const;

type Variant = "canonical" | "archived" | "outside_path" | "plain_scope" | "output_path" | "knowledge_path";

async function fixture(variant: Variant = "canonical", saveReceipt = true) {
  let revision = 0, readFailure: "none" | "unknown" | "corrupt" = "none";
  const facts: RewardV2Fact[] = [];
  const board = { async read() {
    if (readFailure === "unknown") throw new Error("fixture_original_board_read_unknown");
    return { revision, facts: readFailure === "corrupt" ? [...facts, facts[0]!] : [...facts] };
  }, async append(expected: number, draft: RewardV2Draft) {
    const existing = facts.find(row => row.id === draft.id);
    if (existing !== undefined) {
      const { sequence: _sequence, ...original } = existing;
      assert.deepEqual(original, draft);
      return { status: "written" as const, revision, idempotent: true };
    }

    if (expected !== revision) return { status: "stale" as const };

    revision++;
    facts.push({ ...draft, sequence: revision });
    return { status: "written" as const, revision, idempotent: false };
  } };
  const options = { boardRoot: "unused-injected-original-legacy-query-board", scope, enabled: () => true,
    board, secrets: ["known-legacy-fixture-secret"] };
  const service = createCentralOrganizationService(options);
  const saved = async (pending: Promise<OrganizationPublication>) => {
    const result = await pending;
    assert.equal(result.status, "saved");
    if (result.status !== "saved") throw new Error("fixture publication failed");
    return result;
  };
  const prior: OrganizationDecision = { kind: "decision", decisionRef: "decision:original-receiver", purposeRef: "intent:original-receiver",
    context: { purpose: "Inspect a receiver contract before deeper duration research", conditionKeys: ["domain:tool"],
      known: [], residual: ["The receiver contract remains uncertain"] },
    program: { programRef: "program:original-receiver", depth: "Compare before inspecting the receiver contract", timing: "now" },
    expectation: { change: "Choose a bounded research depth", uncertainties: ["Original receiver applicability is unknown"] },
    alternatives: ["Inspect the contract first"], issueRefs: ["issue:original-receiver"], stageRefs: [],
    sourceRefs: ["source:original-receiver"], experienceUse: null };

  await saved(service.freezeDecision(prior, revision));
  const observe = (unitRef: string, result: OrganizationFeedback["result"], sourceRef: string) => saved(service.observe({
    kind: "feedback", decisionRef: prior.decisionRef, unitRef, supersedes: null, sourceRefs: [sourceRef], result }, revision));
  const support = await observe("unit:original-receiver-progress", { kind: "progress",
    summary: "The original source requires checking receiver assumptions before deeper comparison", remaining: ["Applicability is not established"],
    resultRefs: ["result:original-receiver"] }, "source:receiver-progress");

  await observe("unit:original-exposure", { kind: "adoption", state: "used", artifactRefs: ["artifact:receiver-trial"],
    exposureRef: "exposure:receiver-trial" }, "receipt:receiver-use");
  const counter = await observe("unit:original-negative", { kind: "outcome", state: "observed", exposureRef: "exposure:receiver-trial",
    attribution: "unknown", summary: "Original source reports not_helped and context_mismatch for a numeric-only receiver; causal benefit remains unknown" }, "receipt:receiver-negative");
  const knowledge: OrganizationKnowledge = { kind: "knowledge", knowledgeId: "knowledge:receiver-contract", supersedes: null,
    statement: "Inspect the receiver contract before deeper duration research", conditions: "The original receiver representation is uncertain",
    conditionKeys: ["domain:tool"], exceptions: "A numeric-only receiver may reject an added unit field", exceptionKeys: ["receiver_numeric_only"],
    implication: "Prefer bounded exact contract inspection before comparison", supportFactIds: [support.factId],
    counterexampleFactIds: [counter.factId], state: "proposed" };
  const initialKnowledge = await saved(service.reviseKnowledge(knowledge, revision));
  const sourceText = "The original receiver accepts only its explicit contract. Inspect that premise before increasing research depth.";
  const originalRef = "source:receiver-contract";
  const canonical = centralMaterialFromPage({ ref: originalRef, originalRef, origin: "execution_result", originalScope: scope,
    start: 0, end: sourceText.length, totalChars: sourceText.length, text: sourceText, sourceHash: contentHashOf(sourceText),
    coordinate: { runId: "run:original-receiver", sequence: 1 }, owner: "board" });

  assert.ok(canonical.text.length < 900, "the old bounded query includes the whole canonical wrapper");
  const material: CentralRuntimeMaterial = variant === "plain_scope"
    ? { ref: originalRef, kind: "source", sourceRefs: [originalRef], text: `Ordinary source prose names workspace ${scope}.` } : canonical;
  const waiting: CentralLearningIntentDraft = { intentId: "intent:receiver", subject: { plane: "agent", domain: "tool", issueId: "issue:receiver" },
    goal: "Inspect the original receiver contract", rationale: "A missing premise blocks bounded reuse", conditions: ["Receiver contract unknown"],
    knowledge: [], residual: ["The receiver applicability remains uncertain"], commitment: { purpose: "Inspect the exact premise before deeper research",
      assumptions: ["The original source may distinguish receiver representations"], reconsiderWhen: ["An exact contract is delivered"] },
    revisionReason: "Retain the original research purpose", sourceRefs: [originalRef],
    continuation: { kind: "waiting", wait: { kind: "facts", reason: "Read the delivered original source", sourceRefs: [originalRef] } } };
  const state = { ...emptyCentralRuntimeState(scope), intents: [waiting] };
  let stateRef = "state:legacy-query";

  if (variant === "archived") {
    const archived = buildCentralRuntimeRecord({ previousRef: initialCentralRuntimeRef(scope),
      state: { ...emptyCentralRuntimeState(scope), materials: [canonical] }, reason: "Archive the original canonical source page", sourceRefs: [canonical.ref] });
    assert.equal((await board.append(revision, archived)).status, "written");
    const compacted = buildCentralRuntimeRecord({ previousRef: archived.id, state,
      reason: "Retain the purpose while the original page remains in the verified archive", sourceRefs: [canonical.ref] });
    assert.equal((await board.append(revision, compacted)).status, "written");
    stateRef = compacted.id;
  }

  // Reproduce the old builder's bounded input, never sanitize or re-hash a frozen packet.
  const purpose = [[waiting.goal, ...waiting.conditions, ...waiting.residual].join("\n"), material.text].join("\n")
    + (variant === "outside_path" ? "\nRead D:\\outside-original-scope\\private.txt." : "");
  const recalled = await service.prepareRecall({ purpose, conditionKeys: ["plane:agent", "domain:tool",
    `condition:${contentHashOf(waiting.conditions[0]!)}`], sourceRefs: [...new Set([originalRef, material.ref])],
  maximumEntries: 8, maximumCharacters: 24000 }, signal);

  assert.equal(recalled.status, "ready");
  if (recalled.status !== "ready") throw new Error("legacy fixture recall unavailable");

  const packet = recalled.packet;
  assert.equal(packet.entries[0]?.factId, initialKnowledge.factId);
  const queryText = canonicalJson({ role: "organization_retrieval_context_not_business_evidence", query: packet.query, recallRef: packet.recallRef });
  const organization: readonly CentralRuntimeMaterial[] = [
    { ref: packet.recallRef, kind: "organization", text: packet.materialJson, sourceRefs: [packet.recallRef, initialKnowledge.factId] },
    { ref: `organization-query:${contentHashOf(queryText)}`, kind: "organization", text: queryText,
      sourceRefs: variant === "archived" ? packet.query.sourceRefs : [] },
  ];
  const request: CentralDeliberationRequest = { schemaVersion: 1, scope, budgetId: "budget:legacy-query",
    configuration: { schemaVersion: 1, configurationRef: "configuration:legacy-query", authorizationRef: "authorization:legacy-query", allowance },
    boardSequence: revision, resources: { boardSequence: revision, budgetId: "budget:legacy-query", limits: { tokens: 32000, calls: 4, steps: 4 },
      occupied: { tokens: 0, calls: 0, steps: 0 }, available: { tokens: 32000, calls: 4, steps: 4 }, status: "available", holdReason: null },
    stateRef, state, opportunities: [], materials: variant === "archived" ? [] : [material], organization,
    operation: { kind: "think", operationId: "operation:legacy-query-think",
      purpose: "Choose a bounded receiver research program", expectedChange: "Retain the negative observation and inspect the exact contract", sourceRefs: [originalRef] } };
  const revised: OrganizationKnowledge = { ...knowledge, supersedes: initialKnowledge.factId, state: "revised",
    statement: variant === "knowledge_path" ? "Inspect D:\\outside-original-scope\\private-contract.txt before research" : knowledge.statement,
    implication: "Read the numeric-only receiver contract before adopting a value and unit handoff" };
  const selected: CentralLearningIntentDraft = { ...waiting, revisionReason: "The original source supplies an exact contract read",
    continuation: { kind: "ready", operation: { kind: "read", operationId: "operation:legacy-query-read", purpose: "Inspect the original receiver contract",
      expectedChange: "Choose bounded depth from the explicit receiver premise", sourceRefs: [originalRef], refs: [originalRef], maximumChars: 16000 } } };
  const output: CentralDeliberationOutput = { schemaVersion: 1, intents: [selected],
    publicExplanation: variant === "output_path" ? "Inspect D:\\outside-original-scope\\private-output.txt before research" : "Read the receiver contract and retain the source-reported counterexample",
    sourceRefs: [material.ref], alternatives: ["Defer deeper comparison until the receiver premise is known"], organizationKnowledge: [revised],
    organizationUse: { recallRef: packet.recallRef, changes: [{ knowledgeFactId: initialKnowledge.factId, choice: "program",
      before: "Compare before reading the receiver contract", after: "Read the exact receiver contract first", reason: "The supplied conditional hypothesis retains an original negative observation" }] } };

  assert.deepEqual(decodeCentralDeliberation(output, request, options.secrets), output);
  const receipts = createCentralDeliberationReceiptsAtRoot({ ...options, budgetId: request.budgetId });
  const receipt = saveReceipt ? await receipts.save({ request, output }, signal) : undefined;
  const deliveryRef = receipt?.deliveryRef ?? `central-deliberation-delivery:${"a".repeat(64)}`;
  const input = { request, output, decisionRef: request.operation.operationId, role: "deliberation" as const, deliveryRef };

  return { options, service, receipts, receipt, input, packet, prior, initialKnowledge, support, counter, revised,
    revision: () => revision, facts, setReadFailure(value: "none" | "unknown" | "corrupt") { readFailure = value; } };
}

test("only a verified immutable legacy delivery with canonical originalScope copied into query prose can retain safe decisions without claiming an exported use", async () => {
  const f = await fixture("archived"), packetBefore = canonicalJson(f.packet), receiptBefore = canonicalJson(f.receipt);

  assert.equal(f.input.request.materials.length, 0);
  assert.equal(f.input.request.state.materials.length, 0);
  assert.ok(f.packet.query.sourceRefs.some(ref => ref.startsWith("central-source-page:")), "the old query retains only the exact original archived page address");
  const beforeRaw = f.facts.length;

  assert.deepEqual(await f.service.freezeDecision({ ...f.prior, decisionRef: "decision:unsafe-direct-use", experienceUse: {
    packet: f.packet, deliveryRef: f.input.deliveryRef, changes: f.input.output.organizationUse!.changes } }, f.revision()),
  { status: "rejected", reason: "organization_sensitive_content" }, "the original writer still rejects the raw unsafe experience-use packet");
  assert.equal(f.facts.length, beforeRaw);
  const runtime = createCentralRuntimeOrganization({ ...f.options, service: f.service });

  await runtime.recordDecision!(f.input, signal);
  await runtime.recordDecision!({ ...f.input, decisionRef: "operation:legacy-query-read", role: "operation_expectation" }, signal);
  const loaded = await createCentralOrganizationService(f.options).read();
  assert.equal(loaded.status, "ready");

  if (loaded.status !== "ready") throw new Error("safe legacy decision cold replay unavailable");

  for (const decisionRef of [centralOrganizationDeliberationRef(scope, f.input.request.operation.operationId), "operation:legacy-query-read"]) {
    const decision: OrganizationDecision | undefined = loaded.projection.decisions.find(row => row.value.decisionRef === decisionRef)?.value;
    assert.ok(decision);
    assert.equal(decision.experienceUse, null);
    const note = decision.context.known.find((value: string) => value.includes(f.input.deliveryRef) && value.includes(f.packet.recallRef));
    assert.ok(note);
    assert.match(note, /original.*claim.*immutable delivery/i);
    assert.match(note, /does not assert.*unread or unused/i);
    assert.ok(decision.sourceRefs.includes(f.input.deliveryRef));
    assert.equal(isOrganizationRecordContentSafe(decision, f.options, f.options.secrets), true);
    assert.ok(!canonicalJson(decision).includes(JSON.stringify(scope).slice(1, -1)), "the safe public decision carries no serialized workspace path");
  }

  const revisedHead = loaded.projection.knowledge.find(row => row.value.knowledgeId === f.revised.knowledgeId)!;

  assert.notEqual(revisedHead.factId, f.initialKnowledge.factId);
  assert.deepEqual(revisedHead.value, f.revised);
  assert.deepEqual(revisedHead.value.counterexampleFactIds, [f.counter.factId]);
  assert.deepEqual(revisedHead.value.supportFactIds, [f.support.factId]);
  const countBeforeCold = f.facts.length, cold = createCentralRuntimeOrganization({ ...f.options, service: createCentralOrganizationService(f.options) });

  await cold.recordDecision!(f.input, signal);
  await cold.recordDecision!({ ...f.input, decisionRef: "operation:legacy-query-read", role: "operation_expectation" }, signal);
  assert.equal(f.facts.length, countBeforeCold, "cold replay retains the same C, D and knowledge facts");
  assert.equal(canonicalJson(await f.receipts.read(f.input.request.operation.operationId, signal)), receiptBefore);
  assert.equal(canonicalJson(f.packet), packetBefore, "neither the legacy query, packet nor recall hash is rewritten");

  // These are the same boundary's finite negative controls, not provider runs.
  for (const variant of ["outside_path", "plain_scope", "output_path", "knowledge_path"] as const) {
    const invalid = await fixture(variant), before = invalid.facts.length;
    await assert.rejects(() => createCentralRuntimeOrganization({ ...invalid.options, service: invalid.service }).recordDecision!(invalid.input, signal),
      /organization_sensitive_content/, `${variant} cannot inherit the canonical originalScope exception`);
    assert.equal(invalid.facts.length, before, `${variant} exports no new organization fact`);
  }

  const missing = await fixture("canonical", false), missingCount = missing.facts.length;

  await assert.rejects(() => createCentralRuntimeOrganization({ ...missing.options, service: missing.service }).recordDecision!(missing.input, signal),
    /organization_experience_delivery_unverified/);
  assert.equal(missing.facts.length, missingCount);
  const mismatch = await fixture(), mismatchCount = mismatch.facts.length;

  await assert.rejects(() => createCentralRuntimeOrganization({ ...mismatch.options, service: mismatch.service }).recordDecision!({ ...mismatch.input,
    output: { ...mismatch.input.output, publicExplanation: "A changed output was not present in the immutable original receipt" } }, signal),
  /organization_experience_delivery_unverified/);
  assert.equal(mismatch.facts.length, mismatchCount);
  const failed = await fixture(), failedCount = failed.facts.length;

  failed.setReadFailure("unknown");
  await assert.rejects(() => createCentralRuntimeOrganization({ ...failed.options, service: failed.service }).recordDecision!(failed.input, signal),
    /fixture_original_board_read_unknown/);
  failed.setReadFailure("corrupt");
  await assert.rejects(() => createCentralRuntimeOrganization({ ...failed.options, service: failed.service }).recordDecision!(failed.input, signal),
    /organization_board_prefix_invalid/);
  assert.equal(failed.facts.length, failedCount, "unknown reads and invalid original prefixes stay hard failures");
});
