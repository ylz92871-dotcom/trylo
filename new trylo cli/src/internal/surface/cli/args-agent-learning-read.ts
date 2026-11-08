import type { AgentLearningDomain } from "../../protocol/agent-learning-read.js";
import type { ParsedCommand } from "./args-primitives.js";
import { usageError } from "./args-tokens.js";

export type AgentLearningReadOptions = { readonly subsystem: AgentLearningDomain; readonly readOnly: true; readonly versionId?: string };

/** The inspect branch accepts identities only: no work, funding or lifecycle actions. */
export function parseAgentLearningRead(argv: readonly string[]): ParsedCommand {
  const [subsystem, versionId] = argv;
  if ((subsystem !== "method" && subsystem !== "workflow" && subsystem !== "collaboration") || argv.length > 2
    || (versionId !== undefined && (versionId.length === 0 || versionId.length > 512 || /[\0\r\n]/.test(versionId) || versionId.startsWith("-")))) {
    return usageError("invalid learning inspection", "try `trylo learn inspect method|workflow|collaboration [version-id]`");
  }
  return { kind: "learn", options: { subsystem, readOnly: true, ...(versionId === undefined ? {} : { versionId }) } };
}
