/** Shared scope boundary for coordination and its explicit resource budgets. */
export const coordinationScopeValid = (value: unknown): value is string => typeof value === "string"
  && !!value.trim() && value.length <= 512 && !["global", "*", "broad"].includes(value.trim().toLowerCase());
