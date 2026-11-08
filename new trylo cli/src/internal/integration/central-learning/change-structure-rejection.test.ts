import assert from "node:assert/strict";
import test from "node:test";
import type { CentralDeliberationRequest } from "../../learning/central/runtime/contracts.js";
import type { ProviderEvent, ProviderPort } from "../../ports/provider.js";
import type { BoardCommand } from "../../learning/control/commands.js";
import { emptyBoardState } from "../../learning/control/state.js";
import { reduce } from "../../learning/control/reducer.js";
import { createCentralAccountingFunding } from "../learning-content/central-accounting-funding.js";
import { createCentralChangeView } from "./change-input.js";
import { centralReferenceSelectionCode } from "./change-reference-contract.js";
import { compileCentralLearningChange } from "./change-compile.js";
import { isCentralLearningChange, readCentralLearningChange } from "./change-parse.js";
import { isCentralChangeStructureRejection } from "./change-structure-rejection.js";
import { CentralDeliberationError, createCentralModelDeliberation } from "./deliberation.js";
import { blocksAutomaticSemanticRecovery, semanticRecoveryBlock, semanticResourceCondition } from "./runtime-recovery.js";

const PRIVATE = "private-value-and-key-must-never-survive";

function request(): CentralDeliberationRequest {
  return { schemaVersion: 1, scope: "workspace:structure-rejection", budgetId: "budget:structure-rejection", boardSequence: 1,
    stateRef: "state:structure-rejection", configuration: { schemaVersion: 1, configurationRef: "config:structure-rejection",
      authorizationRef: "authorization:structure-rejection", allowance: { schemaVersion: 2, unit: "total_model_tokens",
        maxTokens: 150000, maxCalls: 8, maxSteps: 8, maxPromptChars: 100000 } },
    resources: { boardSequence: 1, budgetId: "budget:structure-rejection", limits: { tokens: 200000, calls: 10, steps: 10 },
      occupied: { tokens: 0, calls: 0, steps: 0 }, available: { tokens: 200000, calls: 10, steps: 10 }, status: "available", holdReason: null },
    state: { schemaVersion: 1, scope: "workspace:structure-rejection", intents: [], completed: [], running: [], materials: [], consumedSourceRefs: [] },
    opportunities: [], materials: [], organization: [], operation: { kind: "think", operationId: "operation:structure-rejection",
      purpose: "Decide whether an original uncertainty needs more research.", expectedChange: "Choose or decline a next computation.", sourceRefs: [] } };
}

test("canonical rejection identifies only safe structure and preserves the original reported bill and contract hold", async () => {
  const input = request(), view = createCentralChangeView(input), checkpoint = centralReferenceSelectionCode(view.dictionary);

  assert.ok(checkpoint);
  const valid = { checkpoint, changes: [], explanation: "Keep the original uncertainty without choosing another operation." };

  assert.equal(isCentralLearningChange(valid), true);
  assert.equal(readCentralLearningChange(valid).ok, true);
  assert.deepEqual(compileCentralLearningChange(valid, input, view.dictionary).intents, []);
  const rejected = (value: unknown) => {
    try { compileCentralLearningChange(value, input, view.dictionary); }
    catch (error) {
      assert.ok(error instanceof CentralDeliberationError);
      return error;
    }
    return assert.fail("Invalid structure must remain rejected");
  };
  const malformed = { ...valid, changes: PRIVATE }, error = rejected(malformed);

  assert.equal(error.reason, "central_learning_change_invalid");
  assert.equal(error.delivery, "returned");
  assert.ok(error.structureRejection, "the original generic compiler refusal must carry its first safe structural cause");
  assert.ok(isCentralChangeStructureRejection(error.structureRejection));
  assert.equal(error.structureRejection.stage, "shape");
  assert.equal(error.structureRejection.field, "/changes");
  assert.equal(error.structureRejection.actual, "string");
  const extra = rejected({ ...valid, [PRIVATE]: PRIVATE }).structureRejection;
  assert.ok(extra);
  assert.equal(extra.field, "", "unknown caller keys identify only their known parent container");
  assert.equal(extra.cause, "unexpected");
  const nested = rejected({ ...valid, inspect: { purpose: "Inspect the original.", expectedChange: "Resolve the uncertainty.",
    refs: PRIVATE, maximumChars: 4096 } }).structureRejection;
  assert.ok(nested);
  assert.equal(nested.field, "/inspect/refs");
  assert.equal(nested.actual, "string");
  const generation = rejected({ ...valid, changes: [{ kind: "create", key: "local-purpose", subject: "central",
    goal: "Resolve the original uncertainty.", why: "A conditional explanation remains unresolved.",
    grounding: { relation: "Compare the original premises.", whenRelevant: "At the next relevant review.", parents: [], citations: [] },
    next: { kind: "think", purpose: "Compare the premises.", expectedChange: "Choose a discriminating question.", sources: [], maxOutputTokens: 512 } }] }).structureRejection;

  assert.ok(generation);
  assert.equal(generation.stage, "generation");
  assert.equal(generation.field, "/changes/0/next/maxOutputTokens");
  assert.equal(generation.cause, "unavailable");
  assert.equal(JSON.stringify([error.structureRejection, extra, nested, generation]).includes(PRIVATE), false);
  assert.equal(isCentralChangeStructureRejection({ ...extra, raw: PRIVATE }), false);
  assert.equal(isCentralChangeStructureRejection({ ...extra, field: `/${PRIVATE}` }), false);

  let state = emptyBoardState(), streams = 0;
  const board = { load: async () => ({ ok: true as const, state, generation: 0 }), async apply(command: BoardCommand) {
    const result = reduce(state, command);
    if (result.ok) state = result.state;
    return result;
  } };
  const opened = await board.apply({ type: "coordinate_learning", commandId: "open:structure-rejection", issuedAt: "2026-11-06T00:00:00.000Z",
    action: { kind: "open_budget", expectedSequence: 0, budget: { schemaVersion: 1, budgetId: input.budgetId, scope: input.scope,
      unit: "total_model_tokens", limits: input.resources.limits, authorizationRef: input.configuration.authorizationRef } } });

  assert.ok(opened.ok);
  const funding = createCentralAccountingFunding({ board, scope: input.scope, budgetId: input.budgetId,
    owner: { kind: "central_deliberation", ownerId: input.budgetId }, enabled: () => true, now: () => "2026-11-06T00:00:00.000Z" });
  const provider = (): ProviderPort => ({ fork: () => provider(), async *stream(wire): AsyncGenerator<ProviderEvent> {
    streams += 1;
    assert.equal(wire.tools.length, 1);
    yield { type: "tool_call", toolCallId: "decision:structure-rejection", name: wire.tools[0]!.name, arguments: malformed };
    yield { type: "usage", usage: { mode: "snapshot", inputTokens: 10, outputTokens: 10,
      cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 20 } };
    yield { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true };
  } });
  // The historical canonical transport deliberately remains available. The new
  // single-action page's independent end-to-end case belongs to its owner.
  const model = createCentralModelDeliberation({ provider: provider(), model: "local-structure-case", funding, outputMode: "tool" });
  let final: CentralDeliberationError | undefined;

  try { await model.deliberate(input, new AbortController().signal); }
  catch (caught) {
    assert.ok(caught instanceof CentralDeliberationError);
    final = caught;
  }

  assert.ok(final);
  assert.equal(final.reason, "central_learning_change_invalid");
  assert.ok(final.structureRejection);
  assert.equal(final.structureRejection.field, "/changes");
  assert.equal(streams, 1);
  const receipt = model.receipts()[0];
  assert.ok(receipt);
  assert.equal(receipt.boundary.kind, "complete");
  assert.equal(receipt.settlement, "confirmed");
  assert.deepEqual(receipt.structureRejection, final.structureRejection);
  const funded = await funding.inspect();
  assert.ok(funded.ok);
  const accounting = funded.projection.budget.accounting ?? [];
  assert.equal(accounting.length, 1);
  const charged = accounting[0];
  assert.ok(charged?.state === "settled");
  assert.equal(charged.usage.kind, "reported");
  const block = semanticRecoveryBlock(input.operation.operationId, final, funded.projection, input.configuration.configurationRef);
  const restored: unknown = JSON.parse(block.text);

  assert.ok(typeof restored === "object" && restored !== null && "structureRejection" in restored);
  assert.ok(isCentralChangeStructureRejection(restored.structureRejection));
  assert.equal(JSON.stringify([receipt, restored]).includes(PRIVATE), false);
  assert.equal(blocksAutomaticSemanticRecovery(final), true);
  const old = semanticRecoveryBlock(input.operation.operationId, new CentralDeliberationError("central_learning_change_invalid", "returned"),
    funded.projection, input.configuration.configurationRef);

  assert.equal("structureRejection" in JSON.parse(old.text), false);
  assert.deepEqual(semanticResourceCondition({ ...input.state, materials: [block] }, funded.projection,
    input.configuration.configurationRef, 0), semanticResourceCondition({ ...input.state, materials: [old] }, funded.projection,
    input.configuration.configurationRef, 0), "structural metadata does not change the original resource/recovery condition");
});
