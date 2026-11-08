import { parseRun } from "./args-run.js";
import type { LearningSwitch, ParsedCommand } from "./args-primitives.js";
import { flagToken, usageError } from "./args-tokens.js";
import { sessionLearningOptions } from "./session-learning-options.js";

/** Reuse the run parser's units and bounds; the interactive entry accepts only learning configuration. */
export function parseInteractiveLearning(argv: readonly string[], learning?: LearningSwitch): ParsedCommand {
  if (argv.includes("--help") || argv.includes("-h")) return { kind: "help" };

  const values = new Set(["learning", "skill-learning-budget", "skill-learning-calls", "workflow-learning-budget", "collaboration-learning",
    "central-learning-budget", "central-learning-calls", "central-learning-prompt-chars", "central-learning-thought-tokens"]);

  for (let index = 0; index < argv.length; index++) {
    const flag = flagToken(argv[index]!);
    if (flag === undefined || (flag.name !== "workflow-learning" && !values.has(flag.name))) {
      return usageError("repl accepts learning switches and explicit learning allowances only", "use `trylo run` for a one-shot task");
    }
    if (values.has(flag.name) && flag.inlineValue === undefined) index++;
  }

  const parsed = parseRun(argv, learning);
  if (parsed.kind !== "run") return parsed;

  return { kind: "repl", ...(parsed.options.learning === undefined ? {} : { learning: parsed.options.learning }),
    learningOptions: sessionLearningOptions(parsed.options) };
}
