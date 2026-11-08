import type { JsonObject } from "../../protocol/envelope.js";
import { CENTRAL_LEARNING_AGENT_DOMAINS } from "../../learning/control/coordination-contract.js";
import { COORDINATION_DECISION_LIMITS } from "../../learning/control/coordination-parse.js";
import { CENTRAL_RUNTIME_LIMITS } from "../../learning/central/runtime/validation.js";

const prose = (): JsonObject => ({ type: "string", maxLength: CENTRAL_RUNTIME_LIMITS.textChars });
const identity = (): JsonObject => ({ type: "string", minLength: 1, maxLength: 256 });
const reference = (): JsonObject => ({ type: "string", minLength: 1, maxLength: COORDINATION_DECISION_LIMITS.sourceRefMaxChars });
const enumeration = (values: readonly string[]): JsonObject => ({ type: "string", enum: values });
const integer = (minimum: number, maximum: number): JsonObject => ({ type: "integer", minimum, maximum });
const array = (items: JsonObject, maximum: number, minimum = 0): JsonObject => ({ type: "array", items, minItems: minimum, maxItems: maximum });
const refs = (): JsonObject => array(reference(), CENTRAL_RUNTIME_LIMITS.references);
const statements = (): JsonObject => array(prose(), CENTRAL_RUNTIME_LIMITS.statements);
const object = (properties: JsonObject): JsonObject => ({ type: "object", properties,
  required: Object.keys(properties), additionalProperties: false });

function subject(): JsonObject {
  return { anyOf: [object({ plane: enumeration(["agent"]), domain: enumeration(CENTRAL_LEARNING_AGENT_DOMAINS), issueId: reference() }),
    object({ plane: enumeration(["user"]), ledgerRef: reference(), questionRef: reference() }),
    object({ plane: enumeration(["central"]), questionRef: reference() })] };
}

function allowance(): JsonObject {
  return object({ schemaVersion: { type: "integer", enum: [2] }, unit: enumeration(["total_model_tokens"]),
    maxTokens: integer(1, 1_000_000_000), maxCalls: integer(1, 64), maxSteps: integer(1, 64), maxPromptChars: integer(0, 100000) });
}

function operation(): JsonObject {
  const purpose = { operationId: identity(), purpose: prose(), expectedChange: prose(), sourceRefs: refs() };
  return { anyOf: [object({ kind: enumeration(["think"]), ...purpose }),
    object({ kind: enumeration(["read"]), ...purpose, refs: refs(), maximumChars: integer(1, CENTRAL_RUNTIME_LIMITS.jsonChars) }),
    object({ kind: enumeration(["consult"]), ...purpose, allowance: allowance() }),
    object({ kind: enumeration(["dispatch"]), ...purpose, allowance: allowance(), destination: { anyOf: [
      object({ plane: enumeration(["agent"]), domain: enumeration(CENTRAL_LEARNING_AGENT_DOMAINS) }),
      object({ plane: enumeration(["user"]) }), { type: "null" }] } })] };
}

function wait(): JsonObject {
  return { anyOf: [object({ kind: enumeration(["facts", "use_feedback", "resources"]), sourceRefs: refs(), reason: prose() }),
    object({ kind: enumeration(["until"]), at: integer(0, Number.MAX_SAFE_INTEGER), sourceRefs: refs(), reason: prose() })] };
}

function continuation(): JsonObject {
  return { anyOf: [object({ kind: enumeration(["ready"]), operation: operation() }),
    object({ kind: enumeration(["waiting"]), wait: wait() }),
    object({ kind: enumeration(["ended"]), goalState: enumeration(["open", "answered", "withdrawn"]), reason: prose() })] };
}

const organizationProse = (): JsonObject => ({ type: "string", minLength: 1, maxLength: 4096 });

function organizationUse(): JsonObject {
  return { anyOf: [object({ recallRef: identity(), changes: array(object({ knowledgeFactId: identity(),
    choice: enumeration(["program", "investment", "timing", "wait", "unchanged"]), before: organizationProse(),
    after: organizationProse(), reason: organizationProse() }), 8) }), { type: "null" }] };
}

function organizationKnowledge(): JsonObject {
  return object({ kind: enumeration(["knowledge"]), knowledgeId: identity(), supersedes: { anyOf: [identity(), { type: "null" }] },
    statement: organizationProse(), conditions: organizationProse(), conditionKeys: array(identity(), 32),
    exceptions: organizationProse(), exceptionKeys: array(identity(), 32), implication: organizationProse(),
    supportFactIds: array(reference(), 64, 1), counterexampleFactIds: array(reference(), 64),
    state: enumeration(["proposed", "revised", "withdrawn"]) });
}

function derivation(): JsonObject {
  return { anyOf: [object({ relation: prose(), whenRelevant: prose(), parentRefs: refs(),
    citations: array(object({ evidenceRef: reference(), quote: prose() }), 32) }), { type: "null" }] };
}

/** Strict wire outputs carry empty arrays and null for absent optional objects. The decoder removes those nulls;
 * old canonical checkpoints may omit the fields. Grounding and cross-field identity remain domain checks. */
export function centralDeliberationResponseSchema(): JsonObject {
  const intent = object({ intentId: identity(), subject: subject(), goal: prose(), rationale: prose(), conditions: statements(),
    knowledge: array(object({ statement: prose(), conditions: prose(), sourceRefs: refs() }), CENTRAL_RUNTIME_LIMITS.knowledge),
    residual: statements(), commitment: object({ purpose: prose(), assumptions: statements(), reconsiderWhen: statements() }),
    revisionReason: prose(), sourceRefs: refs(), derivation: derivation(), continuation: continuation() });
  return object({ schemaVersion: { type: "integer", enum: [1] }, intents: array(intent, CENTRAL_RUNTIME_LIMITS.intents),
    publicExplanation: prose(), sourceRefs: refs(), alternatives: array(organizationProse(), 32), organizationUse: organizationUse(),
    organizationKnowledge: array(organizationKnowledge(), CENTRAL_RUNTIME_LIMITS.knowledge) });
}
