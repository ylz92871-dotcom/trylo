import type { JsonObject } from "../../../../../protocol/envelope.js";

const text = { type: "string", minLength: 1, maxLength: 4096 };
const texts = { type: "array", maxItems: 32, uniqueItems: true, items: text };
const task: JsonObject = {
  type: "object", additionalProperties: false, required: ["taskFamily"], properties: {
    taskFamily: {
      type: "object", additionalProperties: false, required: ["id", "intentClass", "checkKind"], properties: {
        id: text, intentClass: text, checkKind: { type: "string", enum: ["unit_test", "compile", "lint", "acceptance"] },
        language: text, repoKind: text, checkSchema: text,
      },
    },
    conditions: {
      type: "object", maxProperties: 16,
      description: "Literal prerequisite assertions, not an inventory of every observed fact. During adoption, match a published procedure by reusing its requiredConditions keys and string values exactly, only after checking those assertions against the actual current sources. Paraphrases do not match the canonical assertion. Keep concrete case observations in their original evidence; never claim false or unknown prerequisites. For a new opportunity, paths and digests used only to locate evidence are not permanent reuse gates unless exact identity is genuinely required. Values are nonempty strings. The host supplies scope.",
      propertyNames: { minLength: 1, maxLength: 128, not: { enum: ["__proto__", "constructor", "prototype"] } },
      additionalProperties: text,
    },
    process: {
      type: "object", additionalProperties: false,
      description: "Canonical process contract. For adoption, first verify that the published inventory process matches the actual current input/output/effects/check semantics, then reuse that complete process object unchanged. A paraphrased or materially different contract is a different process.",
      required: ["key", "inputContract", "outputContract", "sideEffects", "checkContract"], properties: {
        key: text, inputContract: text, outputContract: text, checkContract: text,
        sideEffects: { type: "string", enum: ["read_only", "local_artifact", "external"] },
      },
    },
  },
};

/** One shared report vocabulary keeps context={} valid across provider schema dialects.
 * Operation-specific required fields and evidence semantics remain runtime-owned. */
export const WORKFLOW_IMPROVEMENT_PARAMETERS: JsonObject = {
  type: "object", additionalProperties: false, required: ["operation"], properties: {
    operation: { type: "string", enum: ["context", "opportunity", "feedback"] },
    report: {
      type: "object", additionalProperties: false,
      description: "Actual JSON object, never a JSON-encoded string. context: {} for inventory, or task+boundary for adoption (optional versionId/issueKey). opportunity: issueKey+task+trigger+problem+desiredOutcome+nonempty evidenceRefs; alternatively only resumeOpportunityId. feedback: useId+exposure+followedStepIds+explanation, optional evidenceRefs. Do not mix operation fields.",
      properties: {
        task, boundary: text, versionId: text, issueKey: text,
        trigger: { type: "string", enum: ["repeated_inefficiency", "user_correction"] },
        problem: text, desiredOutcome: text, evidenceRefs: texts,
        affectedStepIds: {
          type: "array", minItems: 1, maxItems: 8, uniqueItems: true, items: text,
          description: "Existing steps of the matching current parent only. Omit for cold learning or when the process contract does not match a parent.",
        },
        resumeOpportunityId: text, useId: text,
        exposure: { type: "string", enum: ["reported_used", "skipped"] },
        followedStepIds: texts, explanation: text,
      },
    },
  },
  oneOf: [
    { properties: { operation: { enum: ["context"] } } },
    { required: ["report"], properties: { operation: { enum: ["opportunity"] }, report: {
      anyOf: [{ required: ["resumeOpportunityId"] },
        { required: ["issueKey", "task", "trigger", "problem", "desiredOutcome", "evidenceRefs"] }],
    } } },
    { required: ["report"], properties: { operation: { enum: ["feedback"] }, report: {
      required: ["useId", "exposure", "followedStepIds", "explanation"],
    } } },
  ],
};
