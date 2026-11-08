/** Cost estimates describe executable paths; only the central grant authorizes spending. */
export type ToolConstructionReserve = {
  readonly route: "pure_tool" | "npm_tool";
  readonly calls: number; readonly tokens: number; readonly reason: string;
  readonly afterPlanningCalls: number; readonly afterPlanningTokens: number;
  readonly investigationCalls: number; readonly investigationTokens: number;
  readonly planningReservationTokens: number;
  readonly affordableRoutes: readonly string[];
};

export const TOOL_PLANNING_OUTPUT_TOKENS = 4_096;
export const TOOL_PLANNING_REQUEST_TOKENS = 12_000;
export const TOOL_CONSTRUCTION_REQUEST_TOKENS = 16_000;

/** Conservative admission estimate, not a tokenizer or a measured charge. */
export function toolLearningInputTokenEstimate(texts: readonly string[], overheadTokens = 0): number {
  if (!Number.isFinite(overheadTokens) || overheadTokens < 0) return Infinity;
  let chars = 0, bytes = 0;
  for (const text of texts) {
    chars += text.length;
    bytes += new TextEncoder().encode(text).byteLength;
  }
  return Math.max(Math.ceil(chars / 2), Math.ceil(bytes / 2)) + 512 + overheadTokens;
}

export function toolConstructionReserve(input: { readonly callsRemaining: number; readonly tokensRemaining: number;
  readonly prompt: string; readonly route: ToolConstructionReserve["route"] }): ToolConstructionReserve {
  const planningReservationTokens = Math.min(TOOL_PLANNING_REQUEST_TOKENS,
    toolLearningInputTokenEstimate([input.prompt], 768) + TOOL_PLANNING_OUTPUT_TOKENS);
  const calls = input.route === "npm_tool" ? 2 : 1, tokens = calls * TOOL_CONSTRUCTION_REQUEST_TOKENS;
  const afterPlanningCalls = Math.max(0, input.callsRemaining - 1);
  const afterPlanningTokens = Math.max(0, input.tokensRemaining - planningReservationTokens);

  return { route: input.route, calls, tokens, planningReservationTokens, afterPlanningCalls, afterPlanningTokens,
    reason: input.route === "npm_tool" ? "Independent frozen contract followed by source adaptation; both share this original grant"
      : "Frozen task oracle followed by one source generation; repairs spend further allowance",
    investigationCalls: Math.max(0, afterPlanningCalls - calls - 1),
    investigationTokens: Math.max(0, afterPlanningTokens - tokens - TOOL_PLANNING_REQUEST_TOKENS),
    affordableRoutes: ["reuse", "refine", "defer", "compose", "revise_contract", ...(afterPlanningCalls >= 1 && afterPlanningTokens >= TOOL_CONSTRUCTION_REQUEST_TOKENS ? ["create", "improve"] : []),
      ...(afterPlanningCalls >= 2 && afterPlanningTokens >= 2 * TOOL_CONSTRUCTION_REQUEST_TOKENS ? ["acquire", "adapt"] : [])] };
}
