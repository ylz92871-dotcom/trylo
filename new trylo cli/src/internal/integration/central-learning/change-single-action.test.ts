import assert from "node:assert/strict";
import test from "node:test";
import type { CentralDeliberationRequest, CentralLearningIntentDraft } from "../../learning/central/runtime/contracts.js";
import { canonicalJson } from "../../learning/control/hash.js";
import type { CentralInputKind } from "./deliberation-input-dictionary.js";
import type { CentralChangeInput } from "./change-input-contract.js";
import { compileCentralLearningChange } from "./change-compile.js";
import { isCentralLearningChange } from "./change-parse.js";
import { createCentralLearningChangeView } from "./change-prompt.js";
import { decodeCentralDeliberation } from "./deliberation-prompt.js";
import { centralSingleActionMessages,
  expandCentralSingleAction } from "./change-single-action.js";
import { CENTRAL_SINGLE_ACTION_DEFAULT_READ_CHARS } from "./change-single-action-expand.js";
import { CENTRAL_SINGLE_ACTION_LEGACY_VERSION } from "./change-single-action-version.js";
import { encodeCentralDeliberation } from "./deliberation-encoding.js";

const scope = "workspace:single-action-contract", sourceRef = "source:public-receiver";
const readRef = sourceRef, opportunityRef = "opportunity:public-workflow";
const quote = "The receiver requires its original declared unit.";
const subject = { plane: "agent" as const, domain: "workflow" as const, issueId: "issue:public-workflow" };

function request(intents: readonly CentralLearningIntentDraft[] = []): CentralDeliberationRequest {
  return { schemaVersion: 1, scope, budgetId: "budget:single-action", boardSequence: 0, stateRef: "state:single-action",
    configuration: { schemaVersion: 1, configurationRef: "configuration:single-action", authorizationRef: "authorization:single-action",
      allowance: { schemaVersion: 2, unit: "total_model_tokens", maxTokens: 32000, maxCalls: 4, maxSteps: 4, maxPromptChars: 60000 } },
    resources: { boardSequence: 0, budgetId: "budget:single-action", limits: { tokens: 32000, calls: 4, steps: 4 },
      occupied: { tokens: 0, calls: 0, steps: 0 }, available: { tokens: 32000, calls: 4, steps: 4 }, status: "available", holdReason: null },
    state: { schemaVersion: 1, scope, intents, completed: [], running: [], materials: [], consumedSourceRefs: [] },
    operation: { kind: "think", operationId: "thought:single-action", purpose: "Choose a justified inquiry",
      expectedChange: "Retain the source condition and unresolved question", sourceRefs: [sourceRef] },
    opportunities: [{ subject, sourceRef: opportunityRef, description: "The observed receiver condition remains unresolved.", constraints: [] }],
    materials: [{ ref: sourceRef, kind: "source", text: quote, sourceRefs: [sourceRef] },
      { ref: "central-source-navigation:public-counterexample", kind: "source", sourceRefs: [],
        text: canonicalJson({ role: "original_domain_feedback_catalog_not_read_body", readRef,
          preview: "An unread counterexample may distinguish the condition." }) }], organization: [] };
}

function existing(): CentralLearningIntentDraft {
  return { intentId: "intent:existing-public-question", subject, goal: "Understand the receiver condition",
    rationale: "The public source establishes one conditional observation", conditions: ["A receiver declares its unit"],
    knowledge: [{ statement: quote, conditions: "This original public receiver", sourceRefs: [sourceRef] }],
    residual: ["A counterexample remains unread"], commitment: { purpose: "Resolve the conditional question",
      assumptions: ["The original receiver is applicable"], reconsiderWhen: ["An actual contrary receiver is read"] },
    revisionReason: "Retain the original question", sourceRefs: [sourceRef],
    continuation: { kind: "waiting", wait: { kind: "facts", sourceRefs: [sourceRef], reason: "Wait for a discriminating original" } } };
}

function handle(input: CentralChangeInput, kind: CentralInputKind, ref: string): string {
  const entry = input.dictionary.entries.find(row => row.kind === kind && row.ref === ref);
  assert.ok(entry, `missing ${kind} capability`);
  return entry.handle;
}

function compile(raw: unknown, original: CentralDeliberationRequest, input: CentralChangeInput) {
  return decodeCentralDeliberation(compileCentralLearningChange(raw, original, input.dictionary, "central-learning-change-input-v4"),
    original, [], "central-learning-change-input-v4");
}

test("single actions preserve the original v4 page, semantics, identities and capability failures", () => {
  assert.equal(CENTRAL_SINGLE_ACTION_LEGACY_VERSION, "central-learning-single-action-v1");
  const empty = request(), retained = request([existing()]), beforeEmpty = structuredClone(empty), beforeRetained = structuredClone(retained);
  const format = { kind: "action_json", representationVersion: CENTRAL_SINGLE_ACTION_LEGACY_VERSION } as const;
  const input = encodeCentralDeliberation(empty, format, [], "central-learning-change-input-v4"),
    withIntent = encodeCentralDeliberation(retained, format, [], "central-learning-change-input-v4");

  for (const [original, single] of [[empty, input], [retained, withIntent]] as const) {
    const v4 = createCentralLearningChangeView(original, [], "central-learning-change-input-v4");

    assert.equal(single.version, v4.version);
    assert.equal(single.checkpoint, v4.checkpoint);
    assert.deepEqual(single.view, v4.view);
    assert.deepEqual(single.exposure, v4.exposure);
    assert.equal(single.dictionary.checkpoint, v4.dictionary.checkpoint);
    assert.equal(single.dictionary.selectionCode, v4.dictionary.selectionCode);
    assert.equal(single.dictionary.referenceSelectionContractRef, v4.dictionary.referenceSelectionContractRef);
    assert.deepEqual(single.dictionary.entries, v4.dictionary.entries);

    for (const entry of single.dictionary.entries) {
      assert.equal(single.dictionary.source(entry.handle), v4.dictionary.source(entry.handle));
      assert.equal(single.dictionary.read(entry.handle), v4.dictionary.read(entry.handle));
      assert.deepEqual(single.dictionary.intent(entry.handle), v4.dictionary.intent(entry.handle));
      assert.deepEqual(single.dictionary.opportunity(entry.handle), v4.dictionary.opportunity(entry.handle));
      assert.deepEqual(single.dictionary.citation(entry.handle, quote), v4.dictionary.citation(entry.handle, quote));
    }

    assert.deepEqual(single.messages, centralSingleActionMessages(original, single, CENTRAL_SINGLE_ACTION_LEGACY_VERSION));
    assert.equal(single.messages.length, 2);
    assert.equal(single.messages[1]?.role, "user");
    assert.equal(single.messages[1]?.content, canonicalJson(single.view));
  }

  const source = handle(input, "source", sourceRef), read = handle(input, "read", readRef);
  const opportunityEntry = input.dictionary.entries.find(entry => entry.kind === "opportunity"
    && input.dictionary.opportunity(entry.handle)?.sourceRef === opportunityRef);

  assert.ok(opportunityEntry, "the actual dictionary must expose the original offered subject");
  const opportunity = opportunityEntry.handle, target = handle(withIntent, "intent", existing().intentId);
  const retainedSource = handle(withIntent, "source", sourceRef), retainedRead = handle(withIntent, "read", readRef);
  const why = "Inspect the original counterexample before investing further.";
  const equivalent = (raw: unknown, expected: unknown, original = empty, page = input) => {
    assert.equal(isCentralLearningChange(raw), false, "single actions are not silently admitted by the original v4 parser");
    assert.deepEqual(compile(expandCentralSingleAction(raw, original, page.dictionary, CENTRAL_SINGLE_ACTION_LEGACY_VERSION), original, page), compile(expected, original, page));
  };
  const inspection = { purpose: "Read the original counterexample", expectedChange: "Expose its actual receiver condition",
    refs: [read], maximumChars: 2048, sources: [source] };

  equivalent({ action: "read", why, ...inspection }, { checkpoint: input.view.checkpoint, changes: [], explanation: why, inspect: inspection });
  equivalent({ action: "read", refs: [read], why }, { checkpoint: input.view.checkpoint, changes: [], explanation: why,
    inspect: { purpose: why, expectedChange: why, refs: [read], maximumChars: CENTRAL_SINGLE_ACTION_DEFAULT_READ_CHARS } });

  const next = { kind: "read", purpose: "Compare the original receiver", expectedChange: "Bound the observed condition",
    sources: [source], refs: [read], maximumChars: 2048 };
  const nativeCreate = { key: "native-question", subject: opportunity, goal: "Understand the native receiver condition", next };

  equivalent({ action: "create", why, ...nativeCreate }, { checkpoint: input.view.checkpoint,
    changes: [{ kind: "create", why, ...nativeCreate }], explanation: why });
  const grounding = { relation: "The declared unit may distinguish the receiver boundary", whenRelevant: "A future receiver declares a representation",
    parents: [source], citations: [{ source, quote }] };
  const centralCreate = { key: "central-question", subject: "central", goal: "Learn when the declared unit must survive", grounding,
    sources: [source], next: { kind: "wait", for: "facts", sources: [source], reason: "Wait for an actual contrary receiver" } };

  equivalent({ action: "create", why, ...centralCreate }, { checkpoint: input.view.checkpoint,
    changes: [{ kind: "create", why, ...centralCreate }], explanation: why });

  const continued = { kind: "read", purpose: "Read the retained question's counterexample", expectedChange: "Resolve its residual uncertainty",
    sources: [retainedSource], refs: [retainedRead], maximumChars: 1024 };

  equivalent({ action: "continue", target, why, next: continued }, { checkpoint: withIntent.view.checkpoint,
    changes: [{ kind: "revise", target, why, set: { next: continued } }], explanation: why }, retained, withIntent);
  const set = { goal: "A narrower original receiver question", residual: ["Its cross-receiver applicability remains unknown"] };

  equivalent({ action: "revise", target, why, set }, { checkpoint: withIntent.view.checkpoint,
    changes: [{ kind: "revise", target, why, set }], explanation: why }, retained, withIntent);
  equivalent({ action: "end", target, why, goalState: "open" }, { checkpoint: withIntent.view.checkpoint,
    changes: [{ kind: "end", target, why, goalState: "open" }], explanation: why }, retained, withIntent);
  equivalent({ action: "none", why }, { checkpoint: withIntent.view.checkpoint, changes: [], explanation: why }, retained, withIntent);

  // Omitted slot keys are deterministic transport details; explicit keys and semantic fields survive.
  const advanced = { changes: [{ kind: "create", why, subject: opportunity, goal: "First independent question", next },
    { kind: "create", why, ...nativeCreate, key: "single-create-1" }], explanation: why };
  const beforeAdvanced = structuredClone(advanced), expanded = expandCentralSingleAction(advanced, empty, input.dictionary, CENTRAL_SINGLE_ACTION_LEGACY_VERSION);

  assert.ok(isCentralLearningChange(expanded));
  assert.equal(expanded.checkpoint, input.view.checkpoint);
  const first = expanded.changes[0], second = expanded.changes[1];

  assert.ok(first?.kind === "create" && second?.kind === "create");
  assert.notEqual(first.key, second.key);
  assert.equal(second.key, "single-create-1");
  assert.deepEqual(expanded, expandCentralSingleAction(advanced, structuredClone(empty), input.dictionary, CENTRAL_SINGLE_ACTION_LEGACY_VERSION));
  const handwritten = { checkpoint: input.view.checkpoint, changes: [{ ...advanced.changes[0], key: first.key }, advanced.changes[1]], explanation: why };

  assert.deepEqual(compile(expanded, empty, input), compile(handwritten, empty, input));
  assert.deepEqual(advanced, beforeAdvanced);

  const wrongCheckpoint = { action: "none", why, checkpoint: "wrong-explicit-checkpoint" };
  const wrongExpanded = expandCentralSingleAction(wrongCheckpoint, empty, input.dictionary, CENTRAL_SINGLE_ACTION_LEGACY_VERSION);

  assert.ok(isCentralLearningChange(wrongExpanded));
  assert.equal(wrongExpanded.checkpoint, wrongCheckpoint.checkpoint);
  assert.throws(() => compile(wrongExpanded, empty, input));
  const rejected = (raw: unknown) => assert.throws(() => compile(expandCentralSingleAction(raw, empty, input.dictionary, CENTRAL_SINGLE_ACTION_LEGACY_VERSION), empty, input));

  rejected({ action: "invented", why });
  rejected({ action: "none", why, changes: [] });
  rejected({ action: "read", why, refs: [read], unknownField: "must not disappear" });
  const compilerRejects = (raw: unknown) => {
    const canonical = expandCentralSingleAction(raw, empty, input.dictionary, CENTRAL_SINGLE_ACTION_LEGACY_VERSION);
    assert.throws(() => compile(canonical, empty, input), "the original compiler retains shape and capability admission");
  };

  compilerRejects({ changes: [], explanation: why, unknownField: "canonical fields remain closed" });
  compilerRejects({ action: "read", why, refs: [read], maximumChars: 0 });
  compilerRejects({ action: "read", why, refs: [source] });
  compilerRejects({ action: "read", why, refs: [read], sources: [read] });
  compilerRejects({ action: "create", why, ...centralCreate, grounding: { ...grounding, citations: [{ source: read, quote }] } });
  assert.deepEqual(empty, beforeEmpty);
  assert.deepEqual(retained, beforeRetained);
});
