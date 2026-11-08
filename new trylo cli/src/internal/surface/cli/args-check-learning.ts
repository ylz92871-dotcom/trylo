import type { ParsedCommand } from "./args-primitives.js";
import type { CheckerAllowance } from "../../learning/agent/subsystems/check/index.js";
import { usageError } from "./args-tokens.js";

export type CheckLearnOptions = { readonly subsystem: "check"; readonly action: "learn"; readonly allowance: CheckerAllowance }
  | { readonly subsystem: "check"; readonly action: "status" | "recover" };

const HINT = "try `trylo learn check --budget <0..32> --tokens <0..262144> --executions <0..256>` or `--status` / `--recover`";

/** Allocation is the only learning decision accepted here. The subsystem chooses evidence, method and stopping. */
export function parseCheckLearn(argv: readonly string[]): ParsedCommand {
  if (argv.length === 1 && (argv[0] === "--status" || argv[0] === "--recover")) {
    return { kind: "learn", options: { subsystem: "check", action: argv[0] === "--status" ? "status" : "recover" } };
  }

  const limits: Readonly<Record<string, number>> = { "--budget": 32, "--tokens": 262144, "--executions": 256 };
  const values = new Map<string, number>();

  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]!, raw = argv[index + 1], limit = limits[flag];
    if (limit === undefined || values.has(flag) || raw === undefined || !/^\d+$/u.test(raw)
      || !Number.isSafeInteger(Number(raw)) || Number(raw) > limit) return usageError("invalid or duplicate check-learning allocation", HINT);
    values.set(flag, Number(raw));
  }

  const modelCalls = values.get("--budget"), tokens = values.get("--tokens"), executions = values.get("--executions");
  if (modelCalls === undefined || tokens === undefined || executions === undefined) return usageError("check learning requires all three explicit quotas", HINT);

  return { kind: "learn", options: { subsystem: "check", action: "learn", allowance: { modelCalls, tokens, executions } } };
}
