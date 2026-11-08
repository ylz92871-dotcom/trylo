import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { CentralDeliberationOutput, CentralDeliberationRequest } from "../../learning/central/runtime/contracts.js";
import type { CentralGenerationLimits } from "../../learning/central/runtime/generation.js";
import { validateAgendaTransitionBeforeHistory } from "../../learning/central/runtime/transitions.js";
import { isCentralLearningOperation } from "../../learning/central/runtime/validation.js";
import type { JsonObject } from "../../protocol/envelope.js";
import { compileCentralLearningChange } from "./change-compile.js";
import { CENTRAL_CHANGE_INPUT_VERSION, C18_CENTRAL_CHANGE_INPUT_VERSION, LEGACY_CENTRAL_CHANGE_INPUT_VERSION,
  PREVIOUS_CENTRAL_CHANGE_INPUT_VERSION, type CentralChangeInputVersion } from "./change-input-contract.js";
import { createCentralChangeView } from "./change-input.js";
import { isCentralLearningChange } from "./change-parse.js";
import { createCentralLearningChangeView } from "./change-prompt.js";
import { centralLearningChangeSchema } from "./change-schema.js";

const source = "source:c19-original";

function request(generationLimits?: CentralGenerationLimits): CentralDeliberationRequest {
  const allowance = { schemaVersion: 2 as const, unit: "total_model_tokens" as const,
    maxTokens: 200000, maxCalls: 4, maxSteps: 4, maxPromptChars: 100000 };
  return { schemaVersion: 1, scope: "workspace:c19-contract", budgetId: "budget:c19", stateRef: "state:c19", boardSequence: 0,
    configuration: { schemaVersion: 1, configurationRef: "configuration:c19", authorizationRef: "authorization:c19", allowance,
      ...(generationLimits === undefined ? {} : { generationLimits }) },
    resources: { boardSequence: 0, budgetId: "budget:c19", limits: { tokens: 200000, calls: 4, steps: 4 },
      occupied: { tokens: 0, calls: 0, steps: 0 }, available: { tokens: 200000, calls: 4, steps: 4 }, status: "available", holdReason: null },
    state: { schemaVersion: 1, scope: "workspace:c19-contract", intents: [], completed: [], running: [], materials: [], consumedSourceRefs: [] },
    operation: { kind: "think", operationId: "thought:c19-current", purpose: "Choose a useful next computation",
      expectedChange: "Resolve the original uncertainty", sourceRefs: [source] },
    opportunities: [{ subject: { plane: "agent", domain: "workflow", issueId: "issue:c19-original" }, sourceRef: source,
      description: "The original handoff condition remains unresolved.", constraints: [] }],
    materials: [{ ref: source, kind: "source", text: "The original handoff condition remains unresolved.", sourceRefs: [source] }], organization: [] };
}

function choose(input: CentralDeliberationRequest, maxOutputTokens?: number,
  inputVersion: CentralChangeInputVersion = CENTRAL_CHANGE_INPUT_VERSION): CentralDeliberationOutput {
  const delivered = createCentralChangeView(input, inputVersion);
  const opportunity = delivered.dictionary.entries.find(row => row.kind === "opportunity")!.handle;
  const body = delivered.dictionary.entries.find(row => row.kind === "source")!.handle;

  return compileCentralLearningChange({ checkpoint: delivered.view["checkpoint"], changes: [{ kind: "create", key: "next-thought", subject: opportunity,
    goal: "Resolve the handoff uncertainty", why: "The original uncertainty requires another bounded computation",
    next: { kind: "think", purpose: "Compare the original handoff conditions", expectedChange: "Identify the remaining condition",
      sources: [body], ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }) } }],
  explanation: "Invest only in the remaining original uncertainty", sources: [body] }, input, delivered.dictionary, inputVersion);
}

function nextSchema(input: CentralDeliberationRequest, version: CentralChangeInputVersion = CENTRAL_CHANGE_INPUT_VERSION): JsonObject {
  const delivered = createCentralChangeView(input, version);
  return (centralLearningChangeSchema(input, delivered.dictionary, version)["$defs"] as JsonObject)["next"] as JsonObject;
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

test("C19 future think retains an explicit advertised generation choice without granting root credit", () => {
  const input = request({ defaultMaxOutputTokens: 8192, maxOutputTokens: 16384 });
  const output = choose(input, 16384), future = output.intents[0]!.continuation;

  assert.equal(future.kind, "ready");

  if (future.kind !== "ready") throw new Error("expected future computation");

  assert.equal(future.operation.kind, "think");

  if (future.operation.kind !== "think") throw new Error("expected future thought");

  assert.equal(future.operation.maxOutputTokens, 16384);
  assert.equal(isCentralLearningOperation(future.operation), true);
  assert.equal(validateAgendaTransitionBeforeHistory(input, output), null);
  assert.deepEqual(createCentralChangeView(input).view["generationLimits"], input.configuration.generationLimits);
  const advertised = nextSchema(input)["properties"] as JsonObject;

  assert.deepEqual(advertised["maxOutputTokens"] && {
    minimum: (advertised["maxOutputTokens"] as JsonObject)["minimum"], maximum: (advertised["maxOutputTokens"] as JsonObject)["maximum"] },
  { minimum: 256, maximum: 16384 });
  assert.deepEqual(nextSchema(input)["allOf"], [{ if: { properties: { kind: { const: "think" } }, required: ["kind"] },
    else: { not: { required: ["maxOutputTokens"] } } }]);
  const unchanged = choose(input).intents[0]!.continuation;

  assert.equal(unchanged.kind, "ready");

  if (unchanged.kind !== "ready") throw new Error("expected default thought");

  assert.equal(Object.hasOwn(unchanged.operation, "maxOutputTokens"), false);
  assert.throws(() => choose(request(), 16384), /central_learning_change_invalid/);
  assert.throws(() => choose(request({ defaultMaxOutputTokens: 8192, maxOutputTokens: 8192 }), 16384), /central_learning_change_invalid/);
  assert.throws(() => choose(input, 16384, C18_CENTRAL_CHANGE_INPUT_VERSION), /central_learning_change_invalid/);
  assert.equal(validateAgendaTransitionBeforeHistory(request(), output), "central_think_generation_unavailable");
  assert.equal(validateAgendaTransitionBeforeHistory(request({ defaultMaxOutputTokens: 8192, maxOutputTokens: 8192 }), output),
    "central_think_generation_unavailable");
  assert.equal(isCentralLearningOperation({ ...future.operation, maxOutputTokens: undefined }), false);
  assert.equal(isCentralLearningOperation({ ...future.operation, maxOutputTokens: 255 }), false);
  assert.equal(isCentralLearningOperation({ ...future.operation, maxOutputTokens: 16385 }), true);
  assert.equal(isCentralLearningOperation({ ...future.operation, maxOutputTokens: 1_000_000_001 }), false);
  assert.equal(isCentralLearningChange({ changes: [{ kind: "create", key: "read", subject: "opportunity", goal: "Read the original",
    why: "The body is required", next: { kind: "read", purpose: "Read", expectedChange: "Inspect", sources: [], refs: [],
      maximumChars: 100, maxOutputTokens: 512 } }], explanation: "Read the original" }), false);
});

test("C19 legacy input versions retain their frozen instructions and unextended capability advertisement", () => {
  const input = request({ defaultMaxOutputTokens: 8192, maxOutputTokens: 16384 });
  // Digests are from the byte-identical, preserved formal C18 source literals.
  const legacy: readonly (readonly [CentralChangeInputVersion, string])[] = [[LEGACY_CENTRAL_CHANGE_INPUT_VERSION, "fffe8a7daf4a4ac628e0575d8eeb18f33db4ae4ec6f23e33cf97dedae9e69382"],
    [PREVIOUS_CENTRAL_CHANGE_INPUT_VERSION, "fffe8a7daf4a4ac628e0575d8eeb18f33db4ae4ec6f23e33cf97dedae9e69382"],
    [C18_CENTRAL_CHANGE_INPUT_VERSION, "9b4f30a2c4482526261020e10d83d3a460398befefc1ecad66f9be729c3081d6"]];

  for (const [version, instructionHash] of legacy) {
    const delivered = createCentralLearningChangeView(input, [], version);
    assert.equal(sha256(delivered.messages[0]!.content), instructionHash);
    assert.equal(Object.hasOwn(delivered.view, "generationLimits"), false);
    assert.equal(Object.hasOwn(nextSchema(input, version)["properties"] as JsonObject, "maxOutputTokens"), false);
    assert.equal(Object.hasOwn(nextSchema(input, version), "allOf"), false);
  }

  const absent = request();
  const current = createCentralLearningChangeView(absent);

  assert.equal(Object.hasOwn(current.view, "generationLimits"), false);
  assert.equal(Object.hasOwn(nextSchema(absent)["properties"] as JsonObject, "maxOutputTokens"), false);
});
