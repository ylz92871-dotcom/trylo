import type { TurnHostInput } from "./host.js";
import type { TopicLearningRuntime } from "../../integration/learning-topics/runtime.js";
import type { TopicLearningCycleResult } from "../../integration/learning-topics/system.js";

type TopicBoundaryInput = Pick<TurnHostInput, "cancelSignal" | "format" | "sink">;

function reportDegraded(input: TopicBoundaryInput, warning: string): void {
  try { input.sink.stderr(`${warning}\n`); }
  catch { /* Diagnostics are best-effort after the task has settled. */ }
}

function degradedWarnings(result: TopicLearningCycleResult): string[] {
  const warnings = result.results.filter(row => row.status === "failed" || row.status === "unknown")
    .map(row => `topic_learning_degraded:${row.domain}:${row.reason ?? row.status}`);
  if (result.status === "unknown" || result.status === "rejected") warnings.push(`topic_learning_degraded:${result.reason ?? result.status}`);
  return warnings;
}

/** A learning boundary may append its own summary; it cannot rewrite the settled execution outcome. */
export async function finishTopicLearning(input: TopicBoundaryInput,
  topics: Pick<TopicLearningRuntime, "finish"> | undefined): Promise<readonly string[]> {
  if (topics === undefined || input.cancelSignal?.aborted) return [];

  let summary: TopicLearningCycleResult | undefined;

  try { summary = await topics.finish(input.cancelSignal ?? new AbortController().signal); }
  catch {
    const warning = "topic_learning_degraded:boundary_unconfirmed";
    reportDegraded(input, warning);
    return [warning];
  }

  if (summary === undefined) return [];

  const warnings = degradedWarnings(summary);

  try {
    const message = JSON.stringify(summary);
    if (input.format === "stream-json") input.sink.stdout(`${JSON.stringify({ type: "warning", code: "topic_learning_result", message })}\n`);
    else input.sink.stderr(`topic_learning_result: ${message}\n`);
  } catch { warnings.push("topic_learning_degraded:projection_unavailable"); }

  return warnings;
}
