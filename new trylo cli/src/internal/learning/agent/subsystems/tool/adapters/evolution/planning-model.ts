import type { ToolRunnerPort } from "../../../../../../ports/tool-runner-port.js";
import { toolLearningPlanningPrompt, type ToolLearningContext } from "../../domain/evolution/learning-plan.js";
import { ToolLearningServiceError } from "../../domain/evolution/service-error.js";

/** Tool-free planning uses the existing bounded worker transport; its answer is untrusted JSON. */
export async function planToolLearning(runner: ToolRunnerPort, context: ToolLearningContext,
  options: { readonly taskId: string; readonly signal: AbortSignal; readonly timeoutMs?: number }): Promise<unknown> {
  return requestToolLearningJson(runner, toolLearningPlanningPrompt(context), options);
}

/** The same tool-free, centrally funded transport serves contract design and source adaptation. */
export async function requestToolLearningJson(runner: ToolRunnerPort, prompt: string,
  options: { readonly taskId: string; readonly signal: AbortSignal; readonly timeoutMs?: number }): Promise<unknown> {
  const { taskId, signal, timeoutMs } = options;
  let cancellation: Promise<boolean> | undefined;
  const cancel = () => { cancellation = runner.cancel(taskId, "tool planning cancelled"); };

  signal.addEventListener("abort", cancel, { once: true });

  try {
    if (signal.aborted) throw new ToolLearningServiceError("tool_planning_cancelled");

    await runner.submit({ taskId, name: "tool-learning-plan", input: { prompt }, timeoutMs });

    if (signal.aborted) {
      await runner.cancel(taskId);
      throw new ToolLearningServiceError("tool_planning_cancelled");
    }

    const result = await runner.wait(taskId, timeoutMs);
    if (result.observed === "timeout") {
      await runner.cancel(taskId, "tool planning deadline");
      throw new ToolLearningServiceError("tool_planning_timeout");
    }

    if (result.status === "timed_out") throw new ToolLearningServiceError("tool_planning_timeout");

    if (result.status === "cancelled" || signal.aborted) throw new ToolLearningServiceError("tool_planning_cancelled");

    if (result.status !== "completed" || typeof result.output !== "string") {
      const diagnostic = /^tool_evolution_([a-z_]+)(?: \[([a-z_]+):[a-z_]+\])?$/u.exec(result.error?.message ?? "");
      throw new ToolLearningServiceError(diagnostic === null ? "tool_planning_unavailable"
        : `tool_planning_${diagnostic[1]}${diagnostic[2] === undefined ? "" : `_${diagnostic[2]}`}`);
    }

    try { return JSON.parse(result.output) as unknown; }
    catch { throw new ToolLearningServiceError("tool_planning_invalid_json"); }
  } finally {
    signal.removeEventListener("abort", cancel);
    if (cancellation !== undefined) await cancellation;
  }
}
