import type { WorkflowLearningResult } from "../../learning/domains/workflow/trace-contracts.js";
import { text, workflowFailure } from "../../learning/domains/workflow/trace-parse.js";

export function splitWorkflowProviderArgs(argv: readonly string[]) {
  const split = argv.indexOf("--");
  return split < 0 ? { head: argv, provider: [] } : { head: argv.slice(0, split), provider: argv.slice(split + 1) };
}

export function parseWorkflowOperatorArgs(argv: readonly string[], allowed: readonly string[]): WorkflowLearningResult<{ readonly positional: readonly string[]; readonly values: ReadonlyMap<string, string> }> {
  const positional: string[] = [], values = new Map<string, string>();

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }

    const equal = token.indexOf("="), name = equal < 0 ? token.slice(2) : token.slice(2, equal);
    if (!allowed.includes(name) || values.has(name)) return workflowFailure("workflow_usage", `unknown or duplicate workflow option --${name}`);

    const value = equal < 0 ? argv[++index] : token.slice(equal + 1);
    if (!text(value) || value.startsWith("--")) return workflowFailure("workflow_usage", `--${name} requires a bounded value`);

    values.set(name, value);
  }

  return { ok: true, value: { positional, values } };
}

export function workflowIntegerOption(value: string | undefined, fallback?: number, maximum = 262144): WorkflowLearningResult<number> {
  const number = value === undefined ? fallback : /^\d+$/.test(value) ? Number(value) : undefined;
  return number !== undefined && Number.isSafeInteger(number) && number > 0 && number <= maximum
    ? { ok: true, value: number } : workflowFailure("workflow_usage", `a positive integer no greater than ${maximum} is required`);
}
