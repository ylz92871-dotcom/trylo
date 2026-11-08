import assert from "node:assert/strict";
import test from "node:test";
import type { CentralDeliberationRequest } from "../../learning/central/runtime/contracts.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { CENTRAL_SINGLE_ACTIONS } from "./change-single-action-contract.js";
import { centralSingleActionMessages as legacyMessages } from "./change-single-action-page-v1.js";
import { CENTRAL_SINGLE_ACTION_LEGACY_VERSION, CENTRAL_SINGLE_ACTION_V2_VERSION as CENTRAL_SINGLE_ACTION_VERSION } from "./change-single-action-version.js";
import { compileCentralDecision, encodeCentralDeliberation } from "./deliberation-encoding.js";
import { centralDeliberationReservation, decodeCentralDeliberation } from "./deliberation-prompt.js";
import { buildCentralDeliberationWireEvidence, isCentralDeliberationWireEvidence } from "./deliberation-wire-evidence.js";

// Reuse the public request and post-reservation funding fixture from
// deliberation-receipts.test.ts; this contract introduces no new runtime state.
const SCOPE = "project:central-receipts", BUDGET = "budget:receipts";
const request = (): CentralDeliberationRequest => ({ schemaVersion: 1, scope: SCOPE, budgetId: BUDGET, boardSequence: 0,
  resources: { boardSequence: 0, budgetId: BUDGET, limits: { tokens: 100000, calls: 4, steps: 4 },
    occupied: { tokens: 0, calls: 0, steps: 0 }, available: { tokens: 100000, calls: 4, steps: 4 }, status: "available", holdReason: null },
  configuration: { schemaVersion: 1, configurationRef: "configuration:one", authorizationRef: "authorization:one",
    allowance: { schemaVersion: 2, unit: "total_model_tokens", maxTokens: 100000, maxCalls: 4, maxSteps: 4, maxPromptChars: 100000 } },
  stateRef: "state:one", state: { schemaVersion: 1, scope: SCOPE, intents: [], completed: [], running: [], materials: [], consumedSourceRefs: [] },
  opportunities: [], materials: [{ ref: "source:one", kind: "source", text: "Actual public source.", sourceRefs: ["source:one"] }], organization: [],
  operation: { kind: "think", operationId: "operation:one", purpose: "Choose useful research.", expectedChange: "Resolve next step.", sourceRefs: ["source:one"] } });

test("single-action v2 publishes a closed root menu while v1 proof bytes and cross-wire fences remain exact", () => {
  const original = request();
  const v1 = { kind: "action_json", representationVersion: CENTRAL_SINGLE_ACTION_LEGACY_VERSION } as const;
  const v2 = { kind: "action_json", representationVersion: CENTRAL_SINGLE_ACTION_VERSION } as const;

  assert.equal(v1.representationVersion, "central-learning-single-action-v1");
  assert.equal(v2.representationVersion, "central-learning-single-action-v2");
  const old = encodeCentralDeliberation(original, v1), current = encodeCentralDeliberation(original, v2);

  assert.equal(contentHashOf(old.messages), contentHashOf(legacyMessages(original, old)));
  assert.deepEqual(current.view, old.view, "the new root menu does not rewrite the original public input");
  assert.notEqual(contentHashOf(current.messages), contentHashOf(old.messages));
  const system = current.messages[0]?.content;

  assert.ok(typeof system === "string");
  assert.ok(system.includes(canonicalJson(CENTRAL_SINGLE_ACTIONS)), "the actual v2 page must enumerate the closed root action menu");
  assert.match(system, /next\.kind/, "the page must distinguish nested operation kinds from root actions");

  const funding = { role: "user" as const, content: canonicalJson({ role: "host_original_root_after_this_computation_reservation",
    budgetId: BUDGET, limits: original.resources.limits, occupied: { tokens: 20000, calls: 1, steps: 1 },
    available: { tokens: 80000, calls: 3, steps: 3 }, status: "available", holdReason: null,
    thisComputation: { reservationId: centralDeliberationReservation(original), maxTokens: 20000, calls: 1, steps: 1 },
    interpretation: "current_root_resources_not_new_authorization_or_value_prediction" }) };
  const rawChange = { action: "none", why: "Wait for actual use." };

  for (const [format, input, opposite] of [[v1, old, v2], [v2, current, v1]] as const) {
    const output = decodeCentralDeliberation(compileCentralDecision(rawChange, original, input.dictionary, format), original, []);
    const wire = { ...input.wire, messages: [...input.messages, funding], maxOutputTokens: 8192 };
    const proof = buildCentralDeliberationWireEvidence({ request: original, output, rawChange, format, wire });

    assert.ok(proof);
    assert.ok(isCentralDeliberationWireEvidence(proof, original, output));
    assert.equal(proof.messagesHash, contentHashOf(wire.messages));
    assert.equal(isCentralDeliberationWireEvidence({ ...proof, format: opposite }, original, output), false,
      "changing only the advertised version cannot relabel old or new actual wire hashes");
    assert.equal(buildCentralDeliberationWireEvidence({ request: original, output, rawChange, format: opposite, wire }), undefined,
      "the original wire must match the selected factory before a proof is created");
  }
});
