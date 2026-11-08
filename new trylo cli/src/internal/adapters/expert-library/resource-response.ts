import type { ToolOutcome } from "../../ports/tools.js";
import { ExpertLibraryError } from "../../subagent/experts/contracts.js";

export function isExpertWebUri(value: string): boolean {
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password;
  }
  catch { return false; /* Invalid external URL is a rejected candidate, never fetched. */ }
}

export function requireExpertResourceActive(outcome: ToolOutcome, signal: AbortSignal): void {
  if (outcome.outcome === "cancelled" || signal.aborted) throw new ExpertLibraryError("cancelled", "Expert resource collection was cancelled");
}

export function expertWebResponse(outcome: ToolOutcome): { readonly url: string; readonly text: string } | undefined {
  if (outcome.outcome !== "result" || typeof outcome.value.url !== "string" || !isExpertWebUri(outcome.value.url)
    || typeof outcome.value.status !== "number" || outcome.value.status < 200 || outcome.value.status >= 300 || !outcome.output.trim()) return undefined;
  return { url: outcome.value.url, text: outcome.output };
}

export function expertResourceFailure(stage: string, outcome: ToolOutcome): ExpertLibraryError {
  const detail = outcome.outcome === "error" || outcome.outcome === "unknown" ? `${outcome.code}: ${outcome.message}` : outcome.outcome;
  return new ExpertLibraryError("resource_unavailable", `${stage} did not produce usable evidence (${detail})`);
}
