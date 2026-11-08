/** Presentation actions only; canonical v4 parsing and compilation remain authoritative. */
export const CENTRAL_SINGLE_ACTION_DEFAULT_READ_CHARS = 8192;
export const CENTRAL_SINGLE_ACTIONS = ["read", "inspect", "create", "revise", "continue", "end", "none", "organize"] as const;

export type CentralSingleAction = (typeof CENTRAL_SINGLE_ACTIONS)[number];

/** Fields beside action, why and the optional original checkpoint. No aliases or coercions. */
export const CENTRAL_SINGLE_ACTION_FIELDS: Readonly<Record<CentralSingleAction, readonly string[]>> = {
  read: ["purpose", "expectedChange", "refs", "maximumChars", "sources"],
  inspect: ["purpose", "expectedChange", "refs", "maximumChars", "sources"],
  create: ["key", "subject", "goal", "next", "grounding", "conditions", "knowledge", "residual", "commitment", "sources"],
  revise: ["target", "set"],
  continue: ["target", "next"],
  end: ["target", "goalState"],
  none: [],
  organize: ["organizationUse", "organizationKnowledge", "sources", "alternatives"],
};

export function isCentralSingleAction(value: unknown): value is CentralSingleAction {
  return typeof value === "string" && CENTRAL_SINGLE_ACTIONS.some(action => action === value);
}
