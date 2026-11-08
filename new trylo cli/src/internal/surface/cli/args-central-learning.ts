import type { ParsedCommand } from "./args-primitives.js";
import { usageError } from "./args-tokens.js";

export type CentralLearningCommandOptions = { readonly subsystem: "central"; readonly centralOperation: "inspect" | "skill" | "runtime" };

export function parseCentralLearning(argv: readonly string[]): ParsedCommand {
  if (argv.length === 2 && argv[1] === "-" && (argv[0] === "inspect" || argv[0] === "skill" || argv[0] === "runtime")) {
    return { kind: "learn", options: { subsystem: "central", centralOperation: argv[0] } };
  }
  return usageError("invalid central learning command", "try `trylo learn central runtime -`, `trylo learn central inspect -` or `trylo learn central skill -` with JSON on stdin");
}
