import assert from "node:assert/strict";
import test from "node:test";
import type { CentralDeliberationRequest, CentralLearningIntentDraft } from "../../learning/central/runtime/contracts.js";
import { compileCentralLearningChange } from "./change-compile.js";
import { createCentralLearningChangeView } from "./change-prompt.js";
import { expandCentralSingleAction } from "./change-single-action-expand.js";
import { CENTRAL_SINGLE_ACTION_LEGACY_VERSION, CENTRAL_SINGLE_ACTION_V2_VERSION, CENTRAL_SINGLE_ACTION_V3_VERSION,
  CENTRAL_SINGLE_ACTION_V5_VERSION, type CentralSingleActionVersion } from "./change-single-action-version.js";

const scope = "workspace:single-action-knowledge-edits", sourceRef = "source:current-receiver";
const subject = { plane: "agent" as const, domain: "workflow" as const, issueId: "issue:knowledge-edits" };

type Knowledge = CentralLearningIntentDraft["knowledge"][number];

const first: Knowledge = { statement: "Receiver A retains the declared unit", conditions: "The original A receiver",
  sourceRefs: ["source:old-a", "source:old-shared"] };
const second: Knowledge = { statement: "Receiver B rejects a missing unit", conditions: "The original B receiver",
  sourceRefs: ["source:old-b"] };
const added: Knowledge = { statement: "The current receiver supplies an explicit unit", conditions: "This delivered receiver",
  sourceRefs: [sourceRef] };
const revised: Knowledge = { statement: "Receiver A retains the declared unit only at its typed boundary",
  conditions: "The now clarified A boundary", sourceRefs: ["source:old-a", sourceRef] };

function request(): CentralDeliberationRequest {
  const intent: CentralLearningIntentDraft = { intentId: "intent:knowledge-edits", subject,
    goal: "Understand when the declared receiver unit matters", rationale: "Keep the original conditional observations",
    conditions: ["A receiver declares its unit"], knowledge: [first, second, structuredClone(first)],
    residual: ["The cross-receiver boundary remains unresolved"],
    commitment: { purpose: "Resolve the conditional receiver boundary", assumptions: [], reconsiderWhen: ["An actual contrary receiver is read"] },
    revisionReason: "Retain the original observations", sourceRefs: [sourceRef], continuation: { kind: "waiting",
      wait: { kind: "facts", sourceRefs: [sourceRef], reason: "Wait for a discriminating original receiver" } } };
  return { schemaVersion: 1, scope, budgetId: "budget:knowledge-edits", boardSequence: 0, stateRef: "state:knowledge-edits",
    configuration: { schemaVersion: 1, configurationRef: "configuration:knowledge-edits", authorizationRef: "authorization:knowledge-edits",
      allowance: { schemaVersion: 2, unit: "total_model_tokens", maxTokens: 32000, maxCalls: 4, maxSteps: 4, maxPromptChars: 60000 } },
    resources: { boardSequence: 0, budgetId: "budget:knowledge-edits", limits: { tokens: 32000, calls: 4, steps: 4 },
      occupied: { tokens: 0, calls: 0, steps: 0 }, available: { tokens: 32000, calls: 4, steps: 4 }, status: "available", holdReason: null },
    state: { schemaVersion: 1, scope, intents: [intent], completed: [], running: [], materials: [], consumedSourceRefs: [] },
    operation: { kind: "think", operationId: "thought:knowledge-edits", purpose: "Revise one conditional observation",
      expectedChange: "Preserve untouched observations and their original sources", sourceRefs: [sourceRef] },
    opportunities: [{ subject, sourceRef: "opportunity:knowledge-edits", description: "The current receiver clarifies its unit boundary", constraints: [] }],
    materials: [{ ref: sourceRef, kind: "source", text: "The current receiver supplies an explicit unit.", sourceRefs: [sourceRef] }], organization: [] };
}

test("single-action v4 knowledge edits preserve original row indices, sources and legacy replacement semantics", () => {
  const original = request(), before = structuredClone(original);
  const input = createCentralLearningChangeView(original, [], "central-learning-change-input-v4");
  const entriesBefore = structuredClone(input.dictionary.entries);
  const target = input.dictionary.entries.find(entry => entry.kind === "intent" && entry.ref === original.state.intents[0]!.intentId)?.handle;

  assert.ok(target);
  const source = (ref: string): string => {
    const entry = input.dictionary.entries.find(row => row.kind === "reference" && row.ref === ref)
      ?? input.dictionary.entries.find(row => row.kind === "source" && row.ref === ref);
    assert.ok(entry, `the current dictionary must already expose ${ref}`);
    return entry.handle;
  };
  const wire = (row: Knowledge) => ({ statement: row.statement, conditions: row.conditions, sources: row.sourceRefs.map(source) });
  const why = "Retain the other observations while recording the current receiver boundary";
  const action = (set: unknown) => ({ action: "revise", target, why, set });
  const compile = (raw: unknown, version: CentralSingleActionVersion = CENTRAL_SINGLE_ACTION_V5_VERSION) => compileCentralLearningChange(
    expandCentralSingleAction(raw, original, input.dictionary, version), original, input.dictionary, "central-learning-change-input-v4");
  const append = { kind: "append", entry: wire(added), why: "The delivered current receiver adds a distinct condition" };

  // The pre-feature baseline reaches the existing canonical parser here and rejects the unsupported field.
  const appended = compile(action({ knowledgeEdits: [append,
    { kind: "append", entry: wire(first), why: "Keep this separately stated observation even though its full row matches an earlier row" }] }));

  assert.deepEqual(appended.intents[0]!.knowledge, [first, second, first, added, first]);
  assert.deepEqual(appended.intents[0]!.knowledge[0]!.sourceRefs, ["source:old-a", "source:old-shared"]);
  assert.deepEqual(appended.intents[0]!.continuation, original.state.intents[0]!.continuation);
  assert.equal(appended.intents[0]!.intentId, original.state.intents[0]!.intentId);

  const edits = [{ kind: "withdraw", target: 0, why: "Withdraw the first occurrence while retaining the independently addressed duplicate" },
    { kind: "revise", target: 2, entry: wire(revised), why: "Clarify the original third row, irrespective of the earlier withdrawal" }, append];

  assert.deepEqual(compile(action({ knowledgeEdits: edits })).intents[0]!.knowledge, [second, revised, added]);
  const rejects = (set: unknown) => assert.throws(() => compile(action(set)), /central_learning_change_invalid/);

  rejects({ knowledgeEdits: [{ kind: "revise", target: 0, entry: wire(revised), why }, { kind: "withdraw", target: 0, why }] });
  rejects({ knowledgeEdits: [{ kind: "withdraw", target: 3, why }] });
  rejects({ knowledgeEdits: [{ kind: "revise", target: 1.5, entry: wire(revised), why }] });
  rejects({ knowledgeEdits: [{ kind: "append", entry: wire(added) }] });
  rejects({ knowledgeEdits: [{ kind: "withdraw", target: 0, why: "" }] });
  rejects({ knowledge: [], knowledgeEdits: [append] });
  rejects({ knowledgeEdits: [{ ...append, target: 0 }] });
  rejects({ knowledgeEdits: [{ kind: "revise", target: 0, entry: { statement: revised.statement, sources: [source(sourceRef)] }, why }] });
  rejects({ knowledgeEdits: [append, { kind: "revise", target: 3, entry: wire(revised), why }] });

  const replacement = action({ knowledge: [wire(added)] });
  const canonicalReplacement = compileCentralLearningChange({ checkpoint: input.view.checkpoint,
    changes: [{ kind: "revise", target, why, set: { knowledge: [wire(added)] } }], explanation: why },
  original, input.dictionary, "central-learning-change-input-v4");

  assert.deepEqual(compile(replacement), canonicalReplacement);
  assert.deepEqual(canonicalReplacement.intents[0]!.knowledge, [added]);
  assert.equal(CENTRAL_SINGLE_ACTION_V5_VERSION, "central-learning-single-action-v5");

  for (const version of [CENTRAL_SINGLE_ACTION_LEGACY_VERSION, CENTRAL_SINGLE_ACTION_V2_VERSION, CENTRAL_SINGLE_ACTION_V3_VERSION] as const) {
    assert.throws(() => compile(action({ knowledgeEdits: [append] }), version), /central_learning_change_invalid/);
    assert.deepEqual(compile(replacement, version), canonicalReplacement);
    assert.deepEqual(compile({ action: "none", why }, version), compile({ action: "none", why }));
  }

  const stale = { ...original, state: { ...original.state, intents: [{ ...original.state.intents[0]!, knowledge: [second, first, first] }] } };

  assert.throws(() => expandCentralSingleAction(action({ knowledgeEdits: [append] }), stale, input.dictionary, CENTRAL_SINGLE_ACTION_V5_VERSION), /central_input_checkpoint_mismatch/);
  assert.deepEqual(original, before);
  assert.deepEqual(input.dictionary.entries, entriesBefore, "edits reuse the existing dictionary without creating capabilities");
});
