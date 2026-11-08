import { usageError } from "./args-tokens.js";

/** Explicit diagnostics for former public inputs; this owns no runtime or learning state. */
export function retiredRoutingInput() {
  return usageError("Standalone routing learning has been retired (独立路由学习已退役)",
    "remove the retired routing-learning command/options; normal execution paths remain available");
}

export function isRetiredRoutingFlag(name: string): boolean {
  return ["routing-learning", "routing-budget-tokens", "routing-collect"].includes(name);
}
