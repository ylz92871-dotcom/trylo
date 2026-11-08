import assert from "node:assert/strict";
import test from "node:test";
import type { BoardCommand } from "../../learning/control/commands.js";
import { emptyBoardState } from "../../learning/control/state.js";
import { reduce } from "../../learning/control/reducer.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import type { CentralDeliberationRequest, CentralLearningRuntimeState } from "../../learning/central/runtime/contracts.js";
import { centralOperationSignature, type CentralRuntimeHistory } from "../../learning/central/runtime/records.js";
import { isCentralCitationRejection } from "../../learning/central/runtime/citation-rejection.js";
import type { ProviderEvent, ProviderPort } from "../../ports/provider.js";
import { createCentralAccountingFunding } from "../learning-content/central-accounting-funding.js";
import { learningChangeBody, readLearningChangeWire } from "./change-test-support.js";
import { CENTRAL_REFERENCE_SELECTION_CONTRACT_REF, CENTRAL_REFERENCE_SELECTION_CONTRACT_SPEC } from "./change-reference-contract.js";
import { CentralDeliberationError, createCentralModelDeliberation } from "./deliberation.js";
import { blocksAutomaticSemanticRecovery, semanticRecoveryBlock } from "./runtime-recovery.js";
import { readCentralActionRejection } from "./runtime-action-rejection.js";
import { assertCentralActionCorrectionDelivery, centralActionCorrection } from "./runtime-action-correction.js";

const PRIVATE = "private-citation-value-and-key-must-not-survive";
const PARENT = "A separate delivered premise is available for comparison.";

function request(): CentralDeliberationRequest {
  return { schemaVersion: 1, scope: "workspace:citation-rejection", budgetId: "budget:citation-rejection", boardSequence: 1,
    stateRef: "state:citation-rejection", configuration: { schemaVersion: 1, configurationRef: "config:citation-rejection",
      authorizationRef: "authorization:citation-rejection", allowance: { schemaVersion: 2, unit: "total_model_tokens",
        maxTokens: 150000, maxCalls: 8, maxSteps: 8, maxPromptChars: 100000 } },
    resources: { boardSequence: 1, budgetId: "budget:citation-rejection", limits: { tokens: 200000, calls: 10, steps: 10 },
      occupied: { tokens: 0, calls: 0, steps: 0 }, available: { tokens: 200000, calls: 10, steps: 10 }, status: "available", holdReason: null },
    state: { schemaVersion: 1, scope: "workspace:citation-rejection", intents: [], completed: [], running: [], materials: [], consumedSourceRefs: [] },
    opportunities: [], organization: [], materials: [
      { ref: "source:citation", kind: "source", text: PRIVATE, sourceRefs: [] },
      { ref: "source:other-parent", kind: "source", text: PARENT, sourceRefs: [] }],
    operation: { kind: "think", operationId: "operation:citation-rejection", purpose: "Compare the actual premises.",
      expectedChange: "Choose a source-grounded research question.", sourceRefs: ["source:citation", "source:other-parent"] } };
}

test("an actual citation parent refusal retains only a typed slot through billing, recovery and authenticated correction", async () => {
  const input = request();
  let state = emptyBoardState(), streams = 0;
  const board = { load: async () => ({ ok: true as const, state, generation: 0 }), async apply(command: BoardCommand) {
    const result = reduce(state, command);
    if (result.ok) state = result.state;
    return result;
  } };
  const opened = await board.apply({ type: "coordinate_learning", commandId: "open:citation-rejection", issuedAt: "2026-11-06T00:00:00.000Z",
    action: { kind: "open_budget", expectedSequence: 0, budget: { schemaVersion: 1, budgetId: input.budgetId, scope: input.scope,
      unit: "total_model_tokens", limits: input.resources.limits, authorizationRef: input.configuration.authorizationRef } } });

  assert.ok(opened.ok);
  const funding = createCentralAccountingFunding({ board, scope: input.scope, budgetId: input.budgetId,
    owner: { kind: "central_deliberation", ownerId: input.budgetId }, enabled: () => true, now: () => "2026-11-06T00:00:00.000Z" });
  const provider = (): ProviderPort => ({ fork: () => provider(), async *stream(wire): AsyncGenerator<ProviderEvent> {
    streams += 1;
    const view = readLearningChangeWire(wire);
    const body = learningChangeBody(view, PRIVATE), parent = learningChangeBody(view, PARENT);

    // The body and unique quote are genuinely delivered; only its parent link is missing.
    yield { type: "tool_call", toolCallId: "decision:citation-rejection", name: wire.tools[0]!.name, arguments: {
      checkpoint: view.checkpoint, changes: [{ kind: "create", key: "new-question", subject: "central",
        goal: "Compare the supplied premises.", why: "The relation remains a hypothesis.",
        grounding: { relation: "Compare the premises.", whenRelevant: "A related future handoff.",
          parents: [parent.handle], citations: [{ source: body.handle, quote: PRIVATE }] },
        next: { kind: "end", goalState: "open", reason: "No further computation is selected." } }],
      explanation: "Retain the uncertainty without asserting a finding." } };
    yield { type: "usage", usage: { mode: "snapshot", inputTokens: 10, outputTokens: 10,
      cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 20 } };
    yield { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true };
  } });
  const model = createCentralModelDeliberation({ provider: provider(), model: "local-citation-case", funding, outputMode: "tool" });
  let refusal: CentralDeliberationError | undefined;

  try { await model.deliberate(input, new AbortController().signal); }
  catch (error) {
    assert.ok(error instanceof CentralDeliberationError);
    refusal = error;
  }

  assert.ok(refusal);
  assert.equal(refusal.reason, "central_derived_intent_citation_unread_or_not_unique");
  assert.equal(refusal.delivery, "returned");
  assert.equal(streams, 1);
  assert.ok(isCentralCitationRejection(refusal.citationRejection));
  const diagnostic = refusal.citationRejection;

  assert.deepEqual(diagnostic, { schemaVersion: 1, slot: "intent_derivation_citation", intentIndex: 0, citationIndex: 0, cause: "evidence_not_parent" });
  assert.equal(isCentralCitationRejection({ ...diagnostic, [PRIVATE]: PRIVATE }), false);
  assert.equal(isCentralCitationRejection({ ...diagnostic, quote: PRIVATE }), false);
  assert.equal(isCentralCitationRejection({ ...diagnostic, cause: PRIVATE }), false);
  assert.equal(isCentralCitationRejection({ ...diagnostic, slot: PRIVATE }), false);
  const receipt = model.receipts()[0];
  assert.ok(receipt);
  assert.equal(receipt.boundary.kind, "complete");
  assert.equal(receipt.settlement, "confirmed");
  assert.equal(receipt.response, "rejected");
  assert.deepEqual(receipt.citationRejection, diagnostic);
  const funded = await funding.inspect();
  assert.ok(funded.ok);
  const accounting = funded.projection.budget.accounting ?? [];
  assert.equal(accounting.length, 1);
  const charged = accounting[0];
  assert.ok(charged?.state === "settled");
  assert.equal(charged.usage.kind, "reported");
  const block = semanticRecoveryBlock(input.operation.operationId, refusal, funded.projection, input.configuration.configurationRef);
  const restored: unknown = JSON.parse(block.text);

  assert.ok(typeof restored === "object" && restored !== null && "citationRejection" in restored);
  assert.ok(isCentralCitationRejection(restored.citationRejection));
  assert.deepEqual(restored.citationRejection, diagnostic);
  assert.equal(blocksAutomaticSemanticRecovery(refusal), true);
  const completed = { intentId: "central:agenda", operation: input.operation, outcome: "failed" as const,
    resultRefs: [] as const, publicResult: refusal.reason };
  const checkpoint: CentralLearningRuntimeState = { ...input.state, completed: [completed], materials: [block] };
  const history: CentralRuntimeHistory = { operations: [{ operationId: input.operation.operationId,
    signature: centralOperationSignature(input.operation), intentId: completed.intentId, factRef: "fact:issued" }],
    materials: [{ ref: block.ref, factRef: "fact:refusal" }], endedIntents: [], consumedSourceRefs: [] };
  const original = await readCentralActionRejection({ state: checkpoint, history, budget: funded.projection, lookupMaterial: async () => undefined });

  assert.ok(original);
  assert.deepEqual(original.citationRejection, diagnostic);
  const correction = centralActionCorrection(checkpoint, history, input.budgetId, original);
  assert.ok(correction);
  const corrected = { ...input, state: checkpoint, operation: correction.operation, materials: correction.materials };

  assert.ok(assertCentralActionCorrectionDelivery(corrected, CENTRAL_REFERENCE_SELECTION_CONTRACT_SPEC.inputVersion, CENTRAL_REFERENCE_SELECTION_CONTRACT_REF));
  assert.throws(() => assertCentralActionCorrectionDelivery({ ...corrected, materials: corrected.materials.map(row => row.ref !== block.ref ? row
    : { ...row, text: row.text.replace('"evidence_not_parent"', '"quote_not_unique"') }) },
  CENTRAL_REFERENCE_SELECTION_CONTRACT_SPEC.inputVersion, CENTRAL_REFERENCE_SELECTION_CONTRACT_REF), /contract_unavailable/);
  const crossKind = { ...JSON.parse(correction.feedback.text), knowledge: { kind: "typed_reference_rejection",
    value: { schemaVersion: 1, field: "/inspect/refs/0", expected: ["read"], actual: "source", cause: "kind_mismatch", handle: "b1" } } };
  const substituted = { ...correction.feedback, text: canonicalJson(crossKind),
    ref: `central-action-correction-feedback:${contentHashOf([input.scope, input.budgetId, crossKind])}` };

  assert.throws(() => assertCentralActionCorrectionDelivery({ ...corrected,
    operation: { ...correction.operation, sourceRefs: correction.operation.sourceRefs.map(ref => ref === correction.feedback.ref ? substituted.ref : ref) },
    materials: corrected.materials.map(row => row.ref === correction.feedback.ref ? substituted : row) },
  CENTRAL_REFERENCE_SELECTION_CONTRACT_SPEC.inputVersion, CENTRAL_REFERENCE_SELECTION_CONTRACT_REF), /contract_unavailable/,
  "A rehashed reference diagnostic cannot replace the citation refusal's original diagnostic kind");
  assert.equal(JSON.stringify([diagnostic, receipt, restored, correction.feedback]).includes(PRIVATE), false);
});
