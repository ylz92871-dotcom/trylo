import type { JsonObject } from "../../protocol/envelope.js";
import { CENTRAL_LEARNING_AGENT_DOMAINS } from "../../learning/control/coordination-contract.js";
import type { CentralDeliberationRequest } from "../../learning/central/runtime/contracts.js";
import { createCentralChangeView } from "./change-input.js";
import type { CentralChangeInputDictionary } from "./change-input-contract.js";
import { centralOrganizationInputInventory } from "./deliberation-input-sources.js";
import { CENTRAL_MIN_OUTPUT_TOKENS, isCentralGenerationLimits, type CentralGenerationLimits } from "../../learning/central/runtime/generation.js";
import { C34_CENTRAL_CHANGE_INPUT_VERSION as CENTRAL_CHANGE_INPUT_VERSION, usesCentralShortReferenceHandles,
  type CentralChangeInputVersion } from "./change-input-contract.js";
import { scopeCentralChangeReferenceSchema } from "./change-reference-schema.js";

// Wire advertises meanings and required fields. The parser/domain retain the
// canonical size/numeric ceilings instead of repeating them at every leaf.
const text = (): JsonObject => ({ type: "string" });
const handle = (): JsonObject => ({ type: "string" });
const enumeration = (values: readonly string[]): JsonObject => ({ type: "string", enum: values });
const integer = (): JsonObject => ({ type: "integer" });
const array = (items: JsonObject): JsonObject => ({ type: "array", items });
const object = (properties: JsonObject, required = Object.keys(properties)): JsonObject => ({ type: "object", properties, required, additionalProperties: false });
const definition = (name: string): JsonObject => ({ $ref: `#/$defs/${name}` });
const handles = () => array(handle());
const statements = () => array(text());
const commitment = () => object({ purpose: text(), assumptions: statements(), reconsiderWhen: statements() });
const knowledge = () => array(object({ statement: text(), conditions: text(), sources: handles() }));
const grounding = () => object({ relation: text(), whenRelevant: text(), parents: handles(),
  citations: array(object({ source: handle(), quote: text() }, ["source"])) });

function next(generationLimits?: CentralGenerationLimits): JsonObject {
  const meaning = { purpose: text(), expectedChange: text(), sources: handles() };
  const investment = object({ maxTokens: integer(), maxCalls: integer(), maxSteps: integer(), maxPromptChars: integer() });
  const destination = { anyOf: [object({ plane: enumeration(["agent"]), domain: enumeration(CENTRAL_LEARNING_AGENT_DOMAINS) }), object({ plane: enumeration(["user"]) })] };
  // One compact advert; the tagged parser still requires exactly the fields
  // belonging to the chosen action and rejects unrelated ones.
  const advertised: JsonObject = { ...object({ kind: enumeration(["think", "read", "query", "consult", "dispatch", "wait", "wait_until", "end"]), ...meaning,
    refs: handles(), maximumChars: integer(), allowance: investment, destination,
    plane: enumeration(["knowledge", "organization"]), query: text(), offset: integer(),
    for: enumeration(["facts", "use_feedback", "resources"]), reason: text(), at: integer(),
    goalState: enumeration(["open", "answered", "withdrawn"]) }, ["kind"]),
    description: "think/read/query/consult/dispatch require purpose,expectedChange,sources. read:refs,maximumChars. query:plane,query,maximumChars, organization offset optional. consult/dispatch:allowance; central dispatch:destination. wait:for,sources,reason. wait_until:at,sources,reason. end:goalState,reason. Other fields forbidden." };

  if (generationLimits === undefined) return advertised;

  return { ...advertised, properties: { ...(advertised.properties as JsonObject), maxOutputTokens: {
    type: "integer", minimum: CENTRAL_MIN_OUTPUT_TOKENS, maximum: generationLimits.maxOutputTokens,
    description: `Optional only for think. The next thought defaults to ${generationLimits.defaultMaxOutputTokens}; this caps generation, including provider reasoning where shared, not the total bill or root authority.` } },
    allOf: [{ if: { properties: { kind: { const: "think" } }, required: ["kind"] },
      else: { not: { required: ["maxOutputTokens"] } } }],
    description: `${advertised.description} think may additionally choose maxOutputTokens within the displayed generation limits; omission preserves the displayed default.` };
}

function changes(canCreate: boolean, canRevise: boolean, subjects: readonly string[]): JsonObject {
  const semantic = { goal: text(), rationale: text(), conditions: statements(), knowledge: definition("knowledge"), residual: statements(),
    commitment: definition("commitment"), sources: handles(), grounding: definition("grounding"), next: definition("next") };
  const creation = { kind: enumeration(["create"]), key: handle(), subject: enumeration(subjects), goal: semantic.goal, why: text(), grounding: semantic.grounding,
    next: semantic.next, conditions: semantic.conditions, knowledge: semantic.knowledge, residual: semantic.residual,
    commitment: semantic.commitment, sources: semantic.sources };
  const variants: JsonObject[] = [];

  if (canCreate) variants.push({ ...object(creation, ["kind", "key", "subject", "goal", "why", "next", ...(subjects.length === 1 && subjects[0] === "central" ? ["grounding"] : [])]),
    description: "Central purposes require grounding. An original opportunity subject may omit it; no source judgement is supplied by the host." });

  if (canRevise) variants.push(object({ kind: enumeration(["revise"]), target: handle(), why: text(), set: { ...object(semantic, []), minProperties: 1 } }),
    object({ kind: enumeration(["end"]), target: handle(), goalState: enumeration(["open", "answered", "withdrawn"]), why: text() }));

  return variants.length === 0 ? { type: "array", maxItems: 0 } : array({ anyOf: variants });
}

function organizationKnowledge(canPropose: boolean, canRevise: boolean): JsonObject {
  const prose = () => text(), keys = () => array(handle());
  const semantic = { statement: prose(), conditions: prose(), conditionKeys: keys(), exceptions: prose(), exceptionKeys: keys(), implication: prose(),
    support: handles(), counterexamples: handles() };
  const variants: JsonObject[] = [];

  if (canPropose) variants.push(object({ kind: enumeration(["propose"]), key: handle(), ...semantic }, ["kind", "key", "statement", "conditions", "exceptions", "implication", "support"]));

  if (canRevise) variants.push(object({ kind: enumeration(["revise", "withdraw"]), target: handle(), why: text(), set: definition("organizationFields") }));

  return array({ anyOf: variants });
}

/** Normal model contract. Durable complete agendas are compiler output, never a second advertised wire. */
export function centralLearningChangeSchema(request?: CentralDeliberationRequest, suppliedDictionary?: CentralChangeInputDictionary,
  inputVersion: CentralChangeInputVersion = CENTRAL_CHANGE_INPUT_VERSION): JsonObject {
  const dictionary = request === undefined ? undefined : suppliedDictionary ?? createCentralChangeView(request, inputVersion).dictionary;

  if (request !== undefined) dictionary!.assertRequest(request);

  const hasBody = dictionary === undefined || dictionary.entries.some(row => row.kind === "source");
  const opportunities = dictionary?.entries.filter(row => row.kind === "opportunity").map(row => row.handle) ?? [];
  const canCreate = hasBody || opportunities.length > 0;
  const canEditIntent = dictionary === undefined || dictionary.entries.some(row => row.kind === "intent");
  const organization = request === undefined ? undefined : centralOrganizationInputInventory(request);
  const canPropose = organization === undefined || organization.feedback.size > 0;
  const canRevise = organization === undefined || organization.knowledgeBodies.size > 0;
  const canUse = organization === undefined || [...organization.recalls.values()].some(entries => [...entries].some(ref => organization.knowledgeBodies.has(ref)));
  const canInspect = dictionary === undefined || dictionary.entries.some(row => row.kind === "read");
  const generationLimits = inputVersion === CENTRAL_CHANGE_INPUT_VERSION && request !== undefined && isCentralGenerationLimits(request.configuration.generationLimits)
    ? request.configuration.generationLimits : undefined;
  const organizationFields = { statement: text(), conditions: text(), conditionKeys: array(handle()), exceptions: text(),
    exceptionKeys: array(handle()), implication: text(), support: handles(), counterexamples: handles() };
  const definitions = { ...(canCreate || canEditIntent ? { next: next(generationLimits), grounding: grounding(), knowledge: knowledge(), commitment: commitment() } : {}),
    ...(canRevise ? { organizationFields: object(organizationFields, []) } : {}) };
  const schema: JsonObject = { ...object({ checkpoint: handle(), changes: changes(canCreate, canEditIntent, [...(hasBody ? ["central"] : []), ...opportunities]), explanation: text(),
    ...(canCreate || canEditIntent ? { next: handle() } : {}), sources: handles(), alternatives: array(text()),
    ...(canInspect ? { inspect: object({ purpose: text(), expectedChange: text(), refs: handles(), maximumChars: integer(),
      sources: handles() }, ["purpose", "expectedChange", "refs", "maximumChars"]) } : {}),
    ...(canUse ? { organizationUse: object({ recall: handle(), changes: array(object({ knowledge: handle(), choice: enumeration(["program", "investment", "timing", "wait", "unchanged"]),
      before: text(), after: text(), reason: text() })) }) } : {}),
      ...(canPropose || canRevise ? { organizationKnowledge: organizationKnowledge(canPropose, canRevise) } : {}) }, ["changes", "explanation"]),
    ...(Object.keys(definitions).length === 0 ? {} : { $defs: definitions }) };

  return request !== undefined && dictionary !== undefined && usesCentralShortReferenceHandles(inputVersion)
    ? scopeCentralChangeReferenceSchema(schema, dictionary) : schema;
}
