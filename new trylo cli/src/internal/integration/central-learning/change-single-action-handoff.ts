import type { CentralDeliberationOutput, CentralDeliberationRequest, CentralKnowledgeHandoffDecision,
  CentralLearningIntentDraft } from "../../learning/central/runtime/contracts.js";
import { CENTRAL_RUNTIME_LIMITS } from "../../learning/central/runtime/validation.js";
import { fields, text } from "../../validation/json-shape.js";
import type { CentralChangeInputDictionary, CentralChangeInputVersion } from "./change-input-contract.js";
import { CENTRAL_CHANGE_INPUT_VERSION } from "./change-input-contract.js";
import { compileCentralLearningChange } from "./change-compile.js";
import { bindCentralChangeReference } from "./change-reference-resolve.js";
import { expandCentralSingleAction } from "./change-single-action-expand.js";
import { CENTRAL_SINGLE_ACTION_V5_VERSION } from "./change-single-action-version.js";
import { centralAdvisoryKnowledgeHash } from "./central-advisory-records.js";
import { CENTRAL_ADVISORY_PUBLICATION_PREFIX } from "./central-advisory-contracts.js";
import { CentralDeliberationError } from "./deliberation-contract.js";

interface Selection {
  readonly knowledge: readonly number[];
  readonly whenRelevant: string;
  readonly uncertainty: string;
}

type Handoff = { readonly kind: "publish"; readonly selection: Selection; readonly action: "create" | "revise" | "handoff"; readonly target?: unknown }
  | { readonly kind: "withdraw"; readonly publication: unknown; readonly why: unknown };

interface Prepared { readonly base: unknown; readonly handoff?: Handoff }

const invalid = (): never => { throw new CentralDeliberationError("central_learning_change_invalid", "returned"); };
const record = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null) && Reflect.ownKeys(value).length === Object.keys(value).length;
};

function selection(value: unknown): Selection {
  if (!record(value) || !fields(value, ["knowledge", "whenRelevant", "uncertainty"]) || !Array.isArray(value.knowledge)
    || value.knowledge.length < 1 || value.knowledge.length > CENTRAL_RUNTIME_LIMITS.statements
    || Reflect.ownKeys(value.knowledge).length !== value.knowledge.length + 1
    || !Array.from(value.knowledge).every(index => Number.isSafeInteger(index) && index >= 0)
    || new Set(value.knowledge).size !== value.knowledge.length
    || !text(value.whenRelevant, CENTRAL_RUNTIME_LIMITS.textChars) || !text(value.uncertainty, CENTRAL_RUNTIME_LIMITS.textChars)) return invalid();
  return { knowledge: value.knowledge, whenRelevant: value.whenRelevant, uncertainty: value.uncertainty };
}

/** Only v6 metadata is removed. Unknown canonical/action fields still reach the
 * original closed v5 parser; neither caller input nor explicit checkpoints change. */
function prepare(value: unknown): Prepared {
  if (!record(value)) return { base: value };

  const checkpoint = Object.hasOwn(value, "checkpoint") ? ["checkpoint"] : [];

  if (value.action === "handoff") {
    if (!fields(value, ["action", "why", "target", "knowledge", "whenRelevant", "uncertainty", ...checkpoint])) return invalid();
    const selected = selection({ knowledge: value.knowledge, whenRelevant: value.whenRelevant, uncertainty: value.uncertainty });
    return { base: { action: "none", why: value.why, ...(checkpoint.length === 0 ? {} : { checkpoint: value.checkpoint }) },
      handoff: { kind: "publish", selection: selected, action: "handoff", target: value.target } };
  }

  if (value.action === "withdraw_handoff") {
    if (!fields(value, ["action", "why", "publication", ...checkpoint])) return invalid();
    return { base: { action: "none", why: value.why, ...(checkpoint.length === 0 ? {} : { checkpoint: value.checkpoint }) },
      handoff: { kind: "withdraw", publication: value.publication, why: value.why } };
  }

  if (!Object.hasOwn(value, "handoff")) return { base: value };

  if (value.action !== "create" && value.action !== "revise") return invalid();

  const { handoff, ...base } = value;

  return { base, handoff: { kind: "publish", selection: selection(handoff), action: value.action, target: value.target } };
}

function expandBase(prepared: Prepared, request: CentralDeliberationRequest, dictionary: CentralChangeInputDictionary): unknown {
  return expandCentralSingleAction(prepared.base, request, dictionary, CENTRAL_SINGLE_ACTION_V5_VERSION);
}

/** Original host-placeholder inspection uses this same v6 stripping strategy;
 * it does not apply or publish the advisory decision. */
export function expandCentralSingleActionV6Base(value: unknown, request: CentralDeliberationRequest,
  dictionary: CentralChangeInputDictionary): unknown {
  dictionary.assertRequest(request);
  return expandBase(prepare(value), request, dictionary);
}

/** One model response becomes one canonical agenda plus explicit public
 * advisory choices. Entry identities are computed from the real compiled array. */
export function compileCentralSingleActionV6(value: unknown, request: CentralDeliberationRequest,
  dictionary: CentralChangeInputDictionary, inputVersion: CentralChangeInputVersion = CENTRAL_CHANGE_INPUT_VERSION): CentralDeliberationOutput {
  dictionary.assertRequest(request);
  const prepared = prepare(value), output = compileCentralLearningChange(expandBase(prepared, request, dictionary), request, dictionary, inputVersion);
  const handoff = prepared.handoff;
  if (handoff === undefined) return output;

  let decisions: readonly CentralKnowledgeHandoffDecision[];

  if (handoff.kind === "withdraw") {
    if (typeof handoff.publication !== "string" || !text(handoff.why, CENTRAL_RUNTIME_LIMITS.textChars)) return invalid();

    const kind = dictionary.entries.find(entry => entry.handle === handoff.publication)?.kind;
    if (kind !== "source" && kind !== "read") throw new CentralDeliberationError("central_learning_change_handle_unbound", "returned");

    const publicationRef = dictionary.source(handoff.publication) ?? dictionary.read(handoff.publication);
    if (publicationRef === undefined) throw new CentralDeliberationError("central_learning_change_handle_unbound", "returned");

    if (!publicationRef.startsWith(CENTRAL_ADVISORY_PUBLICATION_PREFIX)) return invalid();

    decisions = [{ kind: "withdraw", publicationRef, why: handoff.why }];
  } else {
    let selected: CentralLearningIntentDraft | undefined;

    if (handoff.action === "create") {
      const originalIds = new Set(request.state.intents.map(intent => intent.intentId));
      const created = output.intents.filter(intent => !originalIds.has(intent.intentId));
      if (created.length !== 1) return invalid();
      selected = created[0];
    } else {
      if (typeof handoff.target !== "string") return invalid();
      const original = bindCentralChangeReference(dictionary, dictionary.intent(handoff.target), {
        handle: handoff.target, category: "intent", field: "/target",
      });
      selected = output.intents.find(intent => intent.intentId === original.intentId)
        ?? (handoff.action === "handoff" ? original : undefined);
    }

    if (selected === undefined || selected.continuation.kind === "ended" && selected.continuation.goalState === "withdrawn") return invalid();

    const intent = selected;

    decisions = handoff.selection.knowledge.map(index => {
      const entry = intent.knowledge[index];
      if (entry === undefined) return invalid();
      return { kind: "publish", intentId: intent.intentId, knowledgeHash: centralAdvisoryKnowledgeHash(entry),
        whenRelevant: handoff.selection.whenRelevant, uncertainty: handoff.selection.uncertainty };
    });
  }

  return { ...output, knowledgeHandoffs: decisions };
}
