import assert from "node:assert/strict";
import test from "node:test";
import type { CentralDeliberationRequest, CentralRuntimeMaterial } from "../../learning/central/runtime/contracts.js";
import { createCentralJudgmentMaterial } from "../../learning/central/runtime/judgment.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { centralMaterialFromPage } from "./deliberation-material.js";
import { encodeCentralDeliberation, compileCentralDecision } from "./deliberation-encoding.js";
import { decodeCentralDeliberation } from "./deliberation-prompt.js";
import { CENTRAL_SINGLE_ACTION_VERSION } from "./change-single-action-version.js";
import type { CentralInputKind } from "./deliberation-input-dictionary.js";

const scope = "workspace:source-anchoring";

function page(text: string, id: string): CentralRuntimeMaterial {
  return centralMaterialFromPage({ ref: `source:${id}`, originalRef: `source:${id}`, originalScope: scope,
    owner: "session", origin: "execution_result", coordinate: { runId: `session:${id}`, sequence: 1 },
    sourceHash: contentHashOf(text), start: 0, end: text.length, totalChars: text.length, text });
}

function request(materials: readonly CentralRuntimeMaterial[]): CentralDeliberationRequest {
  return { schemaVersion: 1, scope, budgetId: "budget:source-anchoring", stateRef: "state:source-anchoring", boardSequence: 1,
    configuration: { schemaVersion: 1, configurationRef: "config:source-anchoring", authorizationRef: "authorization:source-anchoring",
      allowance: { schemaVersion: 2, unit: "total_model_tokens", maxTokens: 32000, maxCalls: 4, maxSteps: 4, maxPromptChars: 100000 } },
    resources: { boardSequence: 1, budgetId: "budget:source-anchoring", limits: { tokens: 32000, calls: 4, steps: 4 },
      occupied: { tokens: 0, calls: 0, steps: 0 }, available: { tokens: 32000, calls: 4, steps: 4 }, status: "available", holdReason: null },
    state: { schemaVersion: 1, scope, intents: [], completed: [], running: [], materials: [], consumedSourceRefs: [] },
    materials, organization: [], opportunities: [], operation: { kind: "think", operationId: "operation:source-anchoring",
      purpose: "Compare supplied original premises.", expectedChange: "Retain a bounded question.", sourceRefs: materials.map(row => row.ref) } };
}

test("v5 anchors only actually delivered business bodies and preserves canonical validation and frozen v4 refusals", () => {
  const actual = page('The receiver says "numeric_seconds".\nPreserve this newline and the literal \\ escape.', "escaped");
  const other = page("A separate actual premise has one exact occurrence.", "other"), hidden = page("An unpacked body is unavailable.", "hidden");
  const extra = "source:extra-parent", many = Array.from({ length: 256 }, (_, index) => `source:parent-${index}`);
  const navigation: CentralRuntimeMaterial = { ref: "central-source-navigation:unread", kind: "source", sourceRefs: [],
    text: canonicalJson({ role: "original_domain_feedback_catalog_not_read_body", readRef: "source:unread", preview: "Only navigation." }) };
  const control: CentralRuntimeMaterial = { ref: "central-semantic-attempt:original", kind: "work_result", sourceRefs: [],
    text: canonicalJson({ type: "original_semantic_attempt", operationId: "operation:prior", issuedAt: 1 }) };
  const oldBlock: CentralRuntimeMaterial = { ref: `central-semantic-recovery-blocked:${contentHashOf("old")}`, kind: "feedback",
    sourceRefs: [], text: canonicalJson({ reason: "central_learning_change_invalid", operationId: "operation:old" }) };
  const nativeFailure: CentralRuntimeMaterial = { ref: "native-feedback:original-trial", kind: "feedback", sourceRefs: [],
    text: canonicalJson({ phase: "trial", outcome: "failed", observation: "The actual native attempt did not satisfy its expectation." }) };
  const judgment = createCentralJudgmentMaterial({ scope, operationId: "operation:judgment", resultRef: "result:judgment",
    originalRef: "original:judgment", originalHash: contentHashOf("A public decision."), text: "A public decision.", sourceRefs: [], aliases: [] });
  const carrier: CentralRuntimeMaterial = { ref: "source:parent-carrier", kind: "source", text: "Parent identities are not delivered bodies.", sourceRefs: many };
  const broad = request([actual, other, navigation, control, oldBlock, nativeFailure, judgment, carrier,
    { ref: extra, kind: "source", text: "An additional supplied parent.", sourceRefs: [] }, hidden]);
  const packed = { ...broad, materials: broad.materials.filter(row => row.ref !== hidden.ref) }, before = structuredClone(packed);
  const format = { kind: "action_json", representationVersion: CENTRAL_SINGLE_ACTION_VERSION } as const;
  const encoded = encodeCentralDeliberation(packed, format);
  const handle = (kind: CentralInputKind, ref: string): string => {
    const entry = encoded.dictionary.entries.find(row => row.kind === kind && row.ref === ref);
    assert.ok(entry, `actual ${kind} capability required`);
    return entry.handle;
  };
  const body = handle("source", actual.ref), secondBody = handle("source", other.ref), span = handle("span", other.ref);
  const secondRef = handle("reference", other.ref), extraRef = handle("reference", extra);

  assert.equal(encoded.exposure.find(row => row.ref === actual.ref)?.kind, "body");
  assert.equal(encoded.dictionary.entries.some(row => row.kind === "span" && row.ref === actual.ref), false);
  const grounding = { relation: "Compare the actual premises without inferring success.", whenRelevant: "A similar later handoff.",
    parents: [span, secondBody, secondRef, extraRef, extraRef], citations: [{ source: body }] };
  const raw = { action: "create", subject: "central", goal: "Understand the source condition.", why: "The observed relation remains conditional.",
    grounding, next: { kind: "end", goalState: "open", reason: "Keep the unresolved boundary without further spending." } };
  const rawBefore = structuredClone(raw);
  const compile = (value: unknown) => compileCentralDecision(value, packed, encoded.dictionary, format);
  const decode = (value: unknown) => decodeCentralDeliberation(compile(value), packed, []);
  const canonical = compile(raw), output = decodeCentralDeliberation(canonical, packed, []), intent = output.intents[0];
  assert.ok(intent);
  assert.deepEqual(intent.derivation?.citations, [{ evidenceRef: actual.ref, quote: actual.text }]);
  assert.deepEqual(intent.derivation?.parentRefs, [actual.ref, other.ref, extra], "citation identities precede stable, resolved extra parents");
  assert.deepEqual(output, canonical, "the original canonical decoder still owns acceptance");
  const spanOutput = decode({ ...raw, grounding: { ...grounding, citations: [{ source: span }] } });

  assert.deepEqual(spanOutput.intents[0]?.derivation?.citations, [{ evidenceRef: other.ref,
    quote: "A separate actual premise has one exact occurrence." }], "source-only span keeps its original exact excerpt instead of expanding to the page");
  assert.deepEqual(raw, rawBefore);
  assert.deepEqual(packed, before);

  for (const quote of ["", "A quotation absent from the actual supplied body."] as const) {
    const explicit = { ...raw, grounding: { ...grounding, citations: [{ source: body, quote }] } }, saved = structuredClone(explicit);
    assert.throws(() => decode(explicit), "an explicitly bad quote is never filled or repaired");
    assert.deepEqual(explicit, saved);
  }

  for (const ref of [navigation.ref, control.ref, judgment.ref, hidden.ref]) {
    const locator = handle("reference", ref);
    assert.equal(encoded.dictionary.entries.some(row => row.kind === "source" && row.ref === ref), false);
    assert.throws(() => decode({ ...raw, grounding: { ...grounding, citations: [{ source: locator }] } }));
  }

  assert.equal(encoded.exposure.some(row => row.ref === hidden.ref), false, "the broader source is outside this packed delivery");
  const legacyBody = handle("source", oldBlock.ref);

  assert.throws(() => decode({ ...raw, grounding: { ...grounding, citations: [{ source: legacyBody }] } }),
    "a legacy host refusal cannot become a business anchor even when its old presentation exposed a b handle");
  assert.throws(() => decode({ ...raw, grounding: { ...grounding, citations: [{ source: legacyBody, quote: oldBlock.text }] } }),
    "an explicit exact quote cannot turn host control feedback into a v5 research source");
  assert.doesNotThrow(() => decode({ ...raw, grounding: { ...grounding, citations: [{ source: handle("source", nativeFailure.ref) }] } }),
    "actual native failure feedback can still motivate a question; feedback kinds and failure prose are not control identities");
  const overParents = { ...raw, grounding: { ...grounding, parents: many.map(ref => handle("reference", ref)) } };
  const overBefore = structuredClone(overParents);

  assert.throws(() => decode(overParents), "256 explicit identities plus the actual citation exceed the original parent limit");
  assert.deepEqual(overParents, overBefore, "overflow is refused without truncating parent identities");
  assert.throws(() => decode({ ...raw, goal: "g".repeat(32769) }), "canonical text limits remain authoritative");
  const overJson = { ...raw, goal: "g".repeat(32768), why: "w".repeat(32768),
    grounding: { ...grounding, relation: "r".repeat(32768), whenRelevant: "t".repeat(32768) } };

  assert.throws(() => decode(overJson), "individually bounded fields cannot evade the canonical JSON envelope limit");
  const v4 = { kind: "action_json", representationVersion: "central-learning-single-action-v4" } as const;
  const old = encodeCentralDeliberation(packed, v4);
  const decodeV4 = (value: unknown) => decodeCentralDeliberation(compileCentralDecision(value, packed, old.dictionary, v4), packed, []);

  assert.throws(() => decodeV4(raw), "the frozen v4 source-only citation is not upgraded");
  assert.throws(() => decodeV4({ ...raw, grounding: { ...grounding, parents: [], citations: [{ source: body, quote: actual.text }] } }),
    "the frozen v4 missing-parent refusal remains unchanged");
  assert.deepEqual(raw, rawBefore);
  assert.deepEqual(packed, before);
});
