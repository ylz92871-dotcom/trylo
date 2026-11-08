import { contentHashOf } from "../../learning/control/hash.js";
import type { OrganizationKnowledge } from "../../learning/central/organization/contracts.js";
import type { CentralDeliberationOutput, CentralDeliberationRequest, CentralLearningIntentDraft,
  CentralLearningOperation, CentralLearningOpportunity } from "../../learning/central/runtime/contracts.js";
import type { CentralChangeFields, CentralChangeGrounding, CentralChangeNext, CentralIntentChange,
  CentralOrganizationChange, CentralOrganizationChangeFields } from "./change-contract.js";
import { readCentralLearningChange } from "./change-parse.js";
import type { CentralChangeStructureRejection } from "./change-structure-rejection.js";
import { CentralDeliberationError } from "./deliberation-contract.js";
import { isCentralGenerationLimits } from "../../learning/central/runtime/generation.js";
import { CENTRAL_CHANGE_INPUT_VERSION, usesCentralShortReferenceHandles, type CentralChangeInputVersion } from "./change-input-contract.js";
import type { CentralChangeReferenceCategory } from "./change-reference-contract.js";
import { bindCentralChangeReference, validateCentralChangeSelection, type CentralReferenceResolverDictionary } from "./change-reference-resolve.js";

/** Capabilities for the exact delivered request. Each accessor enforces one handle kind. */
export interface CentralChangeDictionary extends CentralReferenceResolverDictionary {
  readonly checkpoint: string;
  assertRequest(request: CentralDeliberationRequest): void;
  source(handle: string): string | undefined;
  read(handle: string): string | undefined;
  intent(handle: string): CentralLearningIntentDraft | undefined;
  opportunity(handle: string): CentralLearningOpportunity | undefined;
  citation(handle: string, quote?: string): { readonly evidenceRef: string; readonly quote: string } | undefined;
  recall(handle: string): string | undefined;
  knowledge(handle: string): { readonly factId: string; readonly knowledge: OrganizationKnowledge } | undefined;
  feedback(handle: string): string | undefined;
}

const fail = (reason: "invalid" | "handle_unbound" | "duplicate"): never => {
  throw new CentralDeliberationError(`central_learning_change_${reason}`, "returned");
};
const rejectStructure = (rejection: CentralChangeStructureRejection): never => {
  throw new CentralDeliberationError("central_learning_change_invalid", "returned",
    undefined, undefined, undefined, undefined, undefined, rejection);
};
const bound = <T>(value: T | undefined): T => value === undefined ? fail("handle_unbound") : value;

/** Compile mechanical aliases and identities only; the original decoder remains authoritative. */
export function compileCentralLearningChange(value: unknown, request: CentralDeliberationRequest,
  dictionary: CentralChangeDictionary, inputVersion: CentralChangeInputVersion = CENTRAL_CHANGE_INPUT_VERSION): CentralDeliberationOutput {
  dictionary.assertRequest(request);
  const parsed = readCentralLearningChange(value);
  if (!parsed.ok) return rejectStructure(parsed.rejection);

  const change = parsed.value;

  validateCentralChangeSelection(dictionary, change.checkpoint, usesCentralShortReferenceHandles(inputVersion) ? "selection_code" : "legacy");
  // Model keys only acquire identity within this delivered request and operation.
  const stableId = (key: string, kind: "intent" | "operation" | "knowledge" | "inspection") =>
    `central-change-${kind}:${contentHashOf([request.scope, request.stateRef, request.operation.operationId, key, kind])}`;
  const reference = <T>(resolved: T | undefined, handle: string, category: CentralChangeReferenceCategory, field: string,
    quoteProvided?: boolean): T => bindCentralChangeReference(dictionary, resolved, { handle, category, field,
      ...(quoteProvided === undefined ? {} : { quoteProvided }) });
  const sources = (handles: readonly string[], field: string) => handles.map((handle, index) =>
    reference(dictionary.source(handle), handle, "source", `${field}/${index}`));
  const feedback = (handles: readonly string[], field: string) => handles.map((handle, index) =>
    reference(dictionary.feedback(handle), handle, "feedback", `${field}/${index}`));
  const grounding = (input: CentralChangeGrounding, field: string): NonNullable<CentralLearningIntentDraft["derivation"]> => ({
    relation: input.relation, whenRelevant: input.whenRelevant, parentRefs: sources(input.parents, `${field}/parents`),
    citations: input.citations.map((citation, index) => reference(dictionary.citation(citation.source, citation.quote),
      citation.source, "citation", `${field}/citations/${index}/source`, citation.quote !== undefined)),
  });
  const continuation = (input: CentralChangeNext, key: string, field: string): CentralLearningIntentDraft["continuation"] => {
    if (input.kind === "end") return { kind: "ended", goalState: input.goalState, reason: input.reason };

    if (input.kind === "wait") return { kind: "waiting", wait: { kind: input.for, sourceRefs: sources(input.sources, `${field}/sources`), reason: input.reason } };

    if (input.kind === "wait_until") return { kind: "waiting", wait: { kind: "until", at: input.at, sourceRefs: sources(input.sources, `${field}/sources`), reason: input.reason } };

    const meaning = { operationId: stableId(key, "operation"), purpose: input.purpose,
      expectedChange: input.expectedChange, sourceRefs: sources(input.sources, `${field}/sources`) };

    if (input.kind === "think") {
      if (input.maxOutputTokens !== undefined) {
        const generation = usesCentralShortReferenceHandles(inputVersion) && isCentralGenerationLimits(request.configuration.generationLimits)
          ? request.configuration.generationLimits : undefined;
        if (generation === undefined || input.maxOutputTokens > generation.maxOutputTokens) return rejectStructure({
          schemaVersion: 1, stage: "generation", field: `${field}/maxOutputTokens`, expected: "generation_limit", actual: "number",
          cause: generation === undefined ? "unavailable" : "range" });
      }
      return { kind: "ready", operation: { kind: "think", ...meaning,
        ...(input.maxOutputTokens === undefined ? {} : { maxOutputTokens: input.maxOutputTokens }) } };
    }

    if (input.kind === "read") return { kind: "ready", operation: { kind: "read", ...meaning,
      refs: input.refs.map((handle, index) => reference(dictionary.read(handle), handle, "read", `${field}/refs/${index}`)), maximumChars: input.maximumChars } };

    if (input.kind === "query") return { kind: "ready", operation: { kind: "read", ...meaning,
      refs: [input.plane === "knowledge" ? `central-known:${encodeURIComponent(input.query)}`
        : `central-organization-known:${input.offset ?? 0}:${encodeURIComponent(input.query)}`], maximumChars: input.maximumChars } };

    const allowance = { schemaVersion: 2 as const, unit: "total_model_tokens" as const, ...input.allowance };

    return input.kind === "consult" ? { kind: "ready", operation: { kind: "consult", ...meaning, allowance } }
      : { kind: "ready", operation: { kind: "dispatch", ...meaning, allowance,
        ...(input.destination === undefined ? {} : { destination: input.destination }) } };
  };
  const intentFields = (input: CentralChangeFields, field: string): Partial<CentralLearningIntentDraft> => ({
    ...(input.goal === undefined ? {} : { goal: input.goal }),
    ...(input.rationale === undefined ? {} : { rationale: input.rationale }),
    ...(input.conditions === undefined ? {} : { conditions: input.conditions }),
    ...(input.knowledge === undefined ? {} : { knowledge: input.knowledge.map((item, index) => ({ statement: item.statement,
      conditions: item.conditions, sourceRefs: sources(item.sources, `${field}/knowledge/${index}/sources`) })) }),
    ...(input.residual === undefined ? {} : { residual: input.residual }),
    ...(input.commitment === undefined ? {} : { commitment: input.commitment }),
    ...(input.sources === undefined ? {} : { sourceRefs: sources(input.sources, `${field}/sources`) }),
    ...(input.grounding === undefined ? {} : { derivation: grounding(input.grounding, `${field}/grounding`) }),
  });
  const organizationFields = (input: CentralOrganizationChangeFields, field: string): Partial<OrganizationKnowledge> => ({
    ...(input.statement === undefined ? {} : { statement: input.statement }),
    ...(input.conditions === undefined ? {} : { conditions: input.conditions }),
    ...(input.conditionKeys === undefined ? {} : { conditionKeys: input.conditionKeys }),
    ...(input.exceptions === undefined ? {} : { exceptions: input.exceptions }),
    ...(input.exceptionKeys === undefined ? {} : { exceptionKeys: input.exceptionKeys }),
    ...(input.implication === undefined ? {} : { implication: input.implication }),
    ...(input.support === undefined ? {} : { supportFactIds: feedback(input.support, `${field}/support`) }),
    ...(input.counterexamples === undefined ? {} : { counterexampleFactIds: feedback(input.counterexamples, `${field}/counterexamples`) }),
  });
  const localKeys = new Set<string>();
  const claimKey = (key: string) => {
    if (localKeys.has(key) || dictionary.source(key) !== undefined || dictionary.read(key) !== undefined
      || dictionary.intent(key) !== undefined || dictionary.opportunity(key) !== undefined || dictionary.citation(key) !== undefined
      || dictionary.recall(key) !== undefined || dictionary.knowledge(key) !== undefined || dictionary.feedback(key) !== undefined) fail("duplicate");
    localKeys.add(key);
  };
  const intents = new Map(request.state.intents.map(intent => [intent.intentId, intent]));
  const newIntents = new Map<string, string>(), edited = new Set<string>();
  const compileIntent = (change: CentralIntentChange, index: number) => {
    const field = `/changes/${index}`;

    if (change.kind === "create") {
      claimKey(change.key);
      const intentId = stableId(change.key, "intent");
      if (intents.has(intentId)) return fail("duplicate");

      const subject = change.subject === "central" ? { plane: "central" as const, questionRef: intentId }
        : reference(dictionary.opportunity(change.subject), change.subject, "opportunity", `${field}/subject`).subject;
      const intent: CentralLearningIntentDraft = { intentId, subject, goal: change.goal, rationale: change.why,
        conditions: [], knowledge: [], residual: [], commitment: { purpose: "", assumptions: [], reconsiderWhen: [] },
        revisionReason: change.why, sourceRefs: [], ...intentFields(change, field), continuation: continuation(change.next, change.key, `${field}/next`) };

      intents.set(intentId, intent);
      newIntents.set(change.key, intentId);
      return;
    }

    const delivered = reference(dictionary.intent(change.target), change.target, "intent", `${field}/target`);
    const prior = request.state.intents.find(intent => intent.intentId === delivered.intentId) ?? delivered;
    if (edited.has(prior.intentId)) return fail("duplicate");

    edited.add(prior.intentId);
    intents.set(prior.intentId, change.kind === "end" ? { ...prior, revisionReason: change.why,
      continuation: { kind: "ended", goalState: change.goalState, reason: change.why } }
      : { ...prior, ...intentFields(change.set, `${field}/set`), revisionReason: change.why,
        ...(change.set.next === undefined ? {} : { continuation: continuation(change.set.next, prior.intentId, `${field}/set/next`) }) });
  };

  for (const [index, item] of change.changes.entries()) compileIntent(item, index);

  const knowledgeTargets = new Set<string>();
  const compileKnowledge = (change: CentralOrganizationChange, index: number): OrganizationKnowledge => {
    const field = `/organizationKnowledge/${index}`;

    if (change.kind === "propose") {
      claimKey(change.key);
      return { kind: "knowledge", knowledgeId: stableId(change.key, "knowledge"), supersedes: null,
        statement: change.statement, conditions: change.conditions, exceptions: change.exceptions, implication: change.implication,
        conditionKeys: [], exceptionKeys: [], supportFactIds: feedback(change.support, `${field}/support`), counterexampleFactIds: [],
        ...organizationFields(change, field), state: "proposed" };
    }

    const original = reference(dictionary.knowledge(change.target), change.target, "knowledge", `${field}/target`);
    if (knowledgeTargets.has(original.knowledge.knowledgeId)) return fail("duplicate");

    knowledgeTargets.add(original.knowledge.knowledgeId);

    return { ...original.knowledge, ...organizationFields(change.set, `${field}/set`), supersedes: original.factId,
      state: change.kind === "withdraw" ? "withdrawn" : "revised" };
  };
  const organizationKnowledge = change.organizationKnowledge?.map(compileKnowledge);
  let agenda = [...intents.values()];

  if (change.next !== undefined) {
    const intentId = newIntents.get(change.next) ?? reference(dictionary.intent(change.next), change.next, "intent", "/next").intentId;
    const selected = bound(intents.get(intentId));
    agenda = [selected, ...agenda.filter(intent => intent.intentId !== intentId)];
  }

  const agendaRead: Extract<CentralLearningOperation, { kind: "read" }> | undefined = change.inspect === undefined ? undefined
    : { kind: "read", operationId: stableId("inspect", "inspection"), purpose: change.inspect.purpose,
      expectedChange: change.inspect.expectedChange, sourceRefs: sources(change.inspect.sources ?? [], "/inspect/sources"),
      refs: change.inspect.refs.map((handle, index) => reference(dictionary.read(handle), handle, "read", `/inspect/refs/${index}`)), maximumChars: change.inspect.maximumChars };

  return { schemaVersion: 1, intents: agenda, publicExplanation: change.explanation, sourceRefs: sources(change.sources ?? [], "/sources"),
    ...(agendaRead === undefined ? {} : { agendaRead }),
    ...(change.alternatives === undefined ? {} : { alternatives: change.alternatives }),
    ...(change.organizationUse === undefined ? {} : { organizationUse: { recallRef: reference(dictionary.recall(change.organizationUse.recall),
      change.organizationUse.recall, "recall", "/organizationUse/recall"),
      changes: change.organizationUse.changes.map((item, index) => ({ knowledgeFactId: reference(dictionary.knowledge(item.knowledge),
        item.knowledge, "knowledge", `/organizationUse/changes/${index}/knowledge`).factId,
        choice: item.choice, before: item.before, after: item.after, reason: item.reason })) } }),
    ...(organizationKnowledge === undefined ? {} : { organizationKnowledge }) };
}
