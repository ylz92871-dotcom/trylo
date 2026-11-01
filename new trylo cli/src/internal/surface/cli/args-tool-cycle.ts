import type { RunCommandOptions } from "./args-primitives.js";
import { parseRun } from "./args-run.js";
import { isToolLearningJobId } from "../../learning/domains/tool/evolution/pipeline.js";

export type ToolCycleCommand =
  | { readonly kind: "jobs" }
  | { readonly kind: "recipes" }
  | { readonly kind: "status" }
  | { readonly kind: "expire"; readonly jobId: string }
  | { readonly kind: "recipe"; readonly requestFile: string; readonly automation: "manual" | "after_turn"; readonly workspace: boolean }
  | { readonly kind: "queue"; readonly capability: string; readonly scope?: string }
  | { readonly kind: "work"; readonly run: RunCommandOptions; readonly scope?: string; readonly maxJobs: number;
      readonly mode: "manual" | "after_turn"; readonly jobId?: string; readonly generationTimeoutMs?: number };

export function parseToolCycle(argv: readonly string[]): ToolCycleCommand | { readonly kind: "error"; readonly message: string } | undefined {
  const action = argv[0];
  if (!["jobs", "recipes", "recipe", "queue", "work", "expire", "status"].includes(action ?? "")) return undefined;
  const tokens = argv.slice(1).filter(token => token !== "--json");
  if (action === "jobs" || action === "recipes" || action === "status") return tokens.length === 0 ? { kind: action } : invalid("inventory accepts only --json");
  if (action === "expire") return tokens.length === 1 && position(tokens[0]) ? { kind: "expire", jobId: tokens[0] } : invalid("expire needs one inspected lost jobId");
  if (action === "recipe") {
    if (!position(tokens[0]) || tokens.slice(1).some(flag => flag !== "--auto" && flag !== "--workspace") || new Set(tokens).size !== tokens.length) return invalid("recipe needs request.json [--auto] [--workspace]");
    return { kind: "recipe", requestFile: tokens[0], automation: tokens.includes("--auto") ? "after_turn" : "manual", workspace: tokens.includes("--workspace") };
  }
  if (action === "queue") {
    if (!position(tokens[0]) || (tokens.length !== 1 && (tokens.length !== 3 || tokens[1] !== "--scope" || !position(tokens[2])))) return invalid("queue needs a quoted capability [--scope id]");
    return { kind: "queue", capability: tokens[0], ...(tokens[2] === undefined ? {} : { scope: tokens[2] }) };
  }
  const mode = tokens.includes("--after-turn") ? "after_turn" : "manual";
  if (tokens.filter(token => token === "--after-turn").length > 1) return invalid("repeated work mode");
  const workTokens = tokens.filter(token => token !== "--after-turn");
  const values = new Map<string, string>();
  const accepted = ["--scope", "--job-id", "--max-jobs", "--generation-timeout-ms", "--provider", "--model", "--endpoint", "--allow-tools", "--deny-tools"];
  const runTokens: string[] = [];
  for (let i = 0; i < workTokens.length; i += 2) {
    const flag = workTokens[i], value = workTokens[i + 1];
    if (flag === undefined || !accepted.includes(flag) || !position(value) || values.has(flag)) return invalid("invalid or repeated work option");
    values.set(flag, value);
    if (["--provider", "--model", "--endpoint", "--allow-tools", "--deny-tools"].includes(flag)) runTokens.push(flag, value);
  }
  const budget = values.get("--max-jobs") ?? "1", timeout = values.get("--generation-timeout-ms");
  if (!/^[1-3]$/.test(budget) || (timeout !== undefined && (!/^\d+$/.test(timeout) || Number(timeout) < 1 || Number(timeout) > 300_000))) return invalid("work budget must be 1..3 and generation timeout 1..300000 ms");
  const run = parseRun([...runTokens, "tool-learning-worker"]);
  if (run.kind !== "run") return invalid("invalid work provider or tool permissions");
  const scope = values.get("--scope");
  const jobId = values.get("--job-id");
  if (jobId !== undefined && !isToolLearningJobId(jobId)) return invalid("invalid job identity");
  return { kind: "work", run: run.options, mode, maxJobs: Number(budget), ...(scope === undefined ? {} : { scope }),
    ...(jobId === undefined ? {} : { jobId }),
    ...(timeout === undefined ? {} : { generationTimeoutMs: Number(timeout) }) };
}
function position(value: string | undefined): value is string { return value !== undefined && value.trim().length > 0 && !value.startsWith("-"); }
function invalid(message: string) { return { kind: "error" as const, message }; }
