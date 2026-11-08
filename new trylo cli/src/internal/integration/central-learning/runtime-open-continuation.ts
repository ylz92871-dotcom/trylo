import type { CentralDeliberationOutput, CentralDeliberationRequest, CentralLearningIntentDraft,
  CentralLearningRuntimeState } from "../../learning/central/runtime/contracts.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { fields, identity } from "../../validation/json-shape.js";
import { readCentralLearningChange } from "./change-parse.js";
import { encodeCentralDeliberation, expandCentralDecisionBase } from "./deliberation-encoding.js";
import { isCentralDeliberationWireEvidence } from "./deliberation-wire-evidence.js";

/** Recognizes the exact host placeholder, never a general wait on facts. Its
 * text alone cannot prove that a model omitted a successor commitment. */
export function isCentralUnconfirmedThoughtWait(intent: CentralLearningIntentDraft, operationId?: string): boolean {
  const continuation = intent.continuation;
  if (!fields(continuation, ["kind", "wait"]) || continuation.kind !== "waiting"
    || !fields(continuation.wait, ["kind", "reason", "sourceRefs"])) return false;

  const wait = continuation.wait;

  return wait.kind === "facts" && wait.reason === "central_deliberation_outcome_unconfirmed"
    && Array.isArray(wait.sourceRefs) && wait.sourceRefs.length === 1 && identity(wait.sourceRefs[0])
    && (operationId === undefined || wait.sourceRefs[0] === operationId);
}

/** Derives runtime state only after authenticating the original unchanged
 * request/output/wire proof. Legacy absence is unknown, never proof of omission.
 * The caller owns the exact-current-checkpoint policy for historical repair;
 * equal intent bodies alone cannot establish that no later checkpoint existed. */
export function openCentralReturnedThought(input: { readonly state: CentralLearningRuntimeState;
  readonly request: CentralDeliberationRequest; readonly output: CentralDeliberationOutput;
  readonly wireEvidence?: unknown }): CentralLearningRuntimeState {
  const { state, request, output, wireEvidence } = input;

  if (wireEvidence === undefined || request.operation.kind !== "think" || state.scope !== request.scope) return state;

  try {
    const operationId = request.operation.operationId, operationBody = canonicalJson(request.operation);
    const issued = request.state.completed.find(row => row.outcome === "unknown" && row.operation.operationId === operationId
      && canonicalJson(row.operation) === operationBody);
    if (issued === undefined) return state;

    const originalIntent = request.state.intents.find(row => row.intentId === issued.intentId);
    if (originalIntent === undefined || !isCentralUnconfirmedThoughtWait(originalIntent, operationId)) return state;

    const resultRef = `central-deliberation-result:${contentHashOf(output)}`;
    if (!state.completed.some(row => row.intentId === issued.intentId && row.outcome === "returned"
      && row.operation.operationId === operationId && canonicalJson(row.operation) === operationBody
      && row.resultRefs.includes(resultRef))) return state;

    const currentIndex = state.intents.findIndex(row => row.intentId === issued.intentId);
    const currentIntent = state.intents[currentIndex], outputIntent = output.intents.find(row => row.intentId === issued.intentId);
    if (currentIntent === undefined || outputIntent === undefined || !isCentralUnconfirmedThoughtWait(currentIntent, operationId)
      || canonicalJson(currentIntent) !== canonicalJson(outputIntent)) return state;

    if (!isCentralDeliberationWireEvidence(wireEvidence, request, output)) return state;

    // Use the proof's frozen representation and dictionary, not today's default
    // page or a caller-supplied handle map. The original proof/output stay intact.
    const encoded = encodeCentralDeliberation(request, wireEvidence.format, [], wireEvidence.inputVersion);
    const format = wireEvidence.format;
    const canonical = expandCentralDecisionBase(wireEvidence.rawChange, request, encoded.dictionary, format);
    const parsed = readCentralLearningChange(canonical);
    if (!parsed.ok) return state;

    for (const change of parsed.value.changes) {
      if (change.kind === "create") continue;
      const target = encoded.dictionary.intent(change.target);
      if (target === undefined) return state;
      if (target.intentId === issued.intentId && (change.kind === "end" || Object.hasOwn(change.set, "next"))) return state;
    }

    // Canonical top-level next only orders the agenda. Only per-intent next/end
    // is an explicit continuation; even an identical explicit wait is preserved.
    return { ...state, intents: state.intents.map((intent, index) => index === currentIndex
      ? { ...intent, continuation: { kind: "open" as const } } : intent) };
  } catch {
    // Optional historical provenance fails closed. No malformed proof, legacy
    // renderer or unavailable binding may alter the original runtime state.
    return state;
  }
}
