/** Existing context-selection diagnostics, never an independent business outcome or method feedback. */
export type MethodLearningControlObservation =
  | { readonly component: "method_context"; readonly taskId: string; readonly opportunityId: string; readonly selected: number }
  | { readonly component: "method_context_refresh"; readonly taskId: string; readonly reason: string };

/** Only the producer's complete shapes are registered. Extended or unknown observations retain their source role. */
export function isMethodLearningControlObservation(value: unknown): value is MethodLearningControlObservation {
  if (exactRecord(value, ["component", "taskId", "opportunityId", "selected"])) {
    return value.component === "method_context" && nonempty(value.taskId) && nonempty(value.opportunityId)
      && typeof value.selected === "number" && Number.isSafeInteger(value.selected) && value.selected >= 0;
  }
  return exactRecord(value, ["component", "taskId", "reason"]) && value.component === "method_context_refresh"
    && nonempty(value.taskId) && nonempty(value.reason);
}

function exactRecord(value: unknown, keys: readonly string[]): value is Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;

  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;

  const actual = Reflect.ownKeys(value);

  return actual.length === keys.length && keys.every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable === true && Object.hasOwn(descriptor, "value");
  });
}

const nonempty = (value: unknown): value is string => typeof value === "string" && value.length > 0;
