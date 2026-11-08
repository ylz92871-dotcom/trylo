/** A falsifiable trial hypothesis. These fields never confer verification or execution authority. */
export type CollaborationEvaluation = {
  readonly schema: "collaboration-evaluation/v1";
  readonly mechanism: string;
  readonly alternatives: readonly { readonly explanation: string; readonly discriminator: string }[];
  readonly expectedObservations: readonly { readonly id: string; readonly observation: string }[];
  readonly reconsiderWhen: readonly string[];
};

export const COLLABORATION_EVALUATION_LIMITS = Object.freeze({
  mechanismChars: 400, explanationChars: 300, observationChars: 300,
  observationIdChars: 64, alternatives: 3, observations: 4, reconsiderConditions: 4,
});

type Row = Record<string, unknown>;

const row = (value: unknown): value is Row => value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value: Row, keys: readonly string[]) => Object.keys(value).every(key => keys.includes(key));
const text = (value: unknown, max: number): value is string => typeof value === "string" && !!value.trim()
  && value.length <= max && !value.includes("\0");
const boundedList = (value: unknown, max: number): value is unknown[] => Array.isArray(value) && value.length > 0 && value.length <= max;

export function isCollaborationEvaluation(value: unknown): value is CollaborationEvaluation {
  const limits = COLLABORATION_EVALUATION_LIMITS;
  return row(value) && exact(value, ["schema", "mechanism", "alternatives", "expectedObservations", "reconsiderWhen"])
    && value.schema === "collaboration-evaluation/v1" && text(value.mechanism, limits.mechanismChars)
    && boundedList(value.alternatives, limits.alternatives) && value.alternatives.every(item => row(item)
      && exact(item, ["explanation", "discriminator"]) && text(item.explanation, limits.explanationChars)
      && text(item.discriminator, limits.observationChars))
    && boundedList(value.expectedObservations, limits.observations) && value.expectedObservations.every(item => row(item)
      && exact(item, ["id", "observation"]) && text(item.id, limits.observationIdChars) && text(item.observation, limits.observationChars))
    && new Set(value.expectedObservations.map(item => row(item) ? item.id : undefined)).size === value.expectedObservations.length
    && boundedList(value.reconsiderWhen, limits.reconsiderConditions) && value.reconsiderWhen.every(item => text(item, limits.observationChars));
}
