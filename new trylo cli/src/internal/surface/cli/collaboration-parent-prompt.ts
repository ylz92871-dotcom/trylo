import { compactPersonalAgentFacts, compactPersonalAgentSignals } from "../../learning/agent/subsystems/collaboration/personal-agent/index.js";
import { PERSONAL_AGENT_INSTRUCTION_TOOLS } from "../../learning/agent/subsystems/collaboration/runtime/personal-agent-instructions.js";

/** Keep observation facts, but never a generated command to an unmounted inspector. */
export function personalAgentSignalContext(inspection: unknown, mountedTools: readonly string[]): string {
  const compact = compactPersonalAgentSignals(inspection);

  if (mountedTools.includes("collaboration_inspect")) return compact;

  const projected: unknown = JSON.parse(compact);
  if (typeof projected !== "object" || projected === null || Array.isArray(projected)) {
    throw new Error("collaboration_signal_projection_invalid");
  }

  const data = withoutGeneratedNext(projected);
  if (typeof data.objective === "object" && data.objective !== null && !Array.isArray(data.objective)) {
    data.objective = withoutGeneratedNext(data.objective as Record<string, unknown>);
  }

  return JSON.stringify(data);
}

/** Only the compactor's own detail pointer is guidance; actual fact text stays unchanged. */
export function personalAgentFactsContext(facts: readonly unknown[], mountedTools: readonly string[]): string {
  const compact = compactPersonalAgentFacts(facts);
  if (!compact || mountedTools.includes("collaboration_inspect")) return compact;

  const projected: unknown = JSON.parse(compact);
  if (typeof projected !== "object" || projected === null || Array.isArray(projected)) {
    throw new Error("collaboration_fact_projection_invalid");
  }

  return JSON.stringify(withoutGeneratedNext(projected));
}

function withoutGeneratedNext(data: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(data).filter(([key]) => key !== "next"));
}

/** Host-owned instructions are atomic: do not advertise a partly callable protocol. */
export function availableLearningInstruction(instruction: string | undefined, mountedTools: readonly string[]): string | undefined {
  if (instruction === undefined) return undefined;
  const mounted = new Set(mountedTools);
  const required = [...PERSONAL_AGENT_INSTRUCTION_TOOLS, "central_learning"]
    .filter(tool => new RegExp(`\\b${tool}\\b`).test(instruction));
  return required.every(tool => mounted.has(tool)) ? instruction : undefined;
}
