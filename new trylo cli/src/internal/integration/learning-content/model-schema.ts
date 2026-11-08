import type { JsonObject } from "../../protocol/envelope.js";
import type { ContentSemanticRequest } from "../../learning/central/content/process-contract.js";

const text = (maximum = 4096): JsonObject => ({ type: "string", minLength: 1, maxLength: maximum });
const refs = (): JsonObject => ({ type: "array", items: text(512), minItems: 0, maxItems: 32 });
const object = (properties: JsonObject): JsonObject => ({ type: "object", properties,
  required: Object.keys(properties), additionalProperties: false });
const array = (items: JsonObject, maximum: number, minimum = 0): JsonObject => ({ type: "array", items, minItems: minimum, maxItems: maximum });
const citations = (minimum = 1): JsonObject => array(object({ evidenceRef: text(512), quote: text(256) }), 8, minimum);
const enumeration = (values: string[]): JsonObject => ({ type: "string", enum: values });

/** Same public shapes as the core readers. Wire structure never substitutes for source/semantic validation. */
export function contentModelResponseSchema(stage: ContentSemanticRequest["stage"]): JsonObject {
  if (stage === "apply_known") return object({ schemaVersion: { type: "integer", enum: [1] },
    knowledge: array(object({ id: text(512), statement: text(), conditions: text(), citations: citations() }), 16),
    applications: array(object({ id: text(512), requirementRefs: refs(), answerRefs: refs(), binding: text(),
      result: text(), conditions: text(), citations: citations() }), 16),
    relations: array(object({ id: text(512), question: text(600), whenRelevant: text(600), expectedChange: text(600), citations: citations() }), 16),
    preparations: array(object({ description: text(), sourceRefs: refs() }), 16) });
  return object({ schemaVersion: { type: "integer", enum: [1] },
    assessments: array(object({ relationId: text(512), disposition: enumeration(["answered", "residual", "unsupported"]),
      applicationIds: refs(), reason: text() }), 16),
    comparisons: array(object({ relationId: text(512), priorRef: text(512),
      kind: enumeration(["same_question", "covered", "changed_conditions", "different_target", "undetermined"]),
      reason: text(), citations: citations() }), 32),
    selectedRelationId: { anyOf: [text(512), { type: "null" }] },
    recommendation: object({ kind: enumeration(["continue", "revise", "end", "undetermined"]), reason: text(), citations: citations(0) }) });
}
