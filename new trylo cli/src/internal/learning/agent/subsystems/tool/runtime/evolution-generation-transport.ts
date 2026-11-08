import type { ToolRunnerPort } from "../../../../../ports/tool-runner-port.js";

export type ToolEvolutionGeneratedText = { readonly kind: "text"; readonly text: string }
  | { readonly kind: "failed"; readonly code: string; readonly message: string } | { readonly kind: "cancelled" };

type Options = { readonly runner: ToolRunnerPort; readonly timeoutMs?: number };

/** One tool-free worker request. Source paging is interpreted by its domain host,
 * never by giving this worker an execution or filesystem surface. */
export async function requestToolEvolutionText(options: Options, taskId: string, prompt: string, signal: AbortSignal): Promise<ToolEvolutionGeneratedText> {
  let submitted = false;
  let cancellation: Promise<Awaited<ReturnType<typeof invokeToolEvolutionPort<boolean>>>> | undefined;
  const cancel = (): void => { cancellation = invokeToolEvolutionPort(() => options.runner.cancel(taskId, "tool evolution cancelled")); };

  signal.addEventListener("abort", cancel, { once: true });

  try {
    if (signal.aborted) return { kind: "cancelled" };

    await options.runner.submit({ taskId, name: "tool-evolution-generate", input: { prompt },
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }) });
    submitted = true;

    if (signal.aborted) {
      await options.runner.cancel(taskId, "tool evolution cancelled");
      return { kind: "cancelled" };
    }

    let result = await options.runner.wait(taskId, options.timeoutMs);

    // An observation window cannot terminate work. Only the explicit submitted
    // governance timeout or the caller's cancellation may stop this same task.
    while (result.observed === "timeout" && !signal.aborted) result = await options.runner.wait(taskId, options.timeoutMs);

    if (result.status === "cancelled" || signal.aborted) return { kind: "cancelled" };

    if (result.status !== "completed" || typeof result.output !== "string") return { kind: "failed", code: result.error?.code ?? "generation_failed",
      message: result.error?.message ?? "background worker did not return candidate text" };

    return { kind: "text", text: result.output };
  } catch (error) {
    if (submitted) {
      const stopped = await invokeToolEvolutionPort(() => options.runner.cancel(taskId, "tool evolution worker failure"));
      if (!stopped.ok || !stopped.value) return { kind: "failed", code: "generation_stop_unconfirmed", message: "background generation stop could not be confirmed" };
    }
    return signal.aborted ? { kind: "cancelled" } : { kind: "failed", code: "generation_failed", message: error instanceof Error ? error.message : String(error) };
  } finally {
    signal.removeEventListener("abort", cancel);
    // Cancellation cleanup is terminal here; it cannot throw into AbortController.
    if (cancellation !== undefined) await cancellation;
  }
}

/** External ports have outcome contracts; a thrown implementation failure must not fake completion. */
export async function invokeToolEvolutionPort<T>(run: () => Promise<T>): Promise<{ readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string }> {
  try { return { ok: true, value: await run() }; }
  catch (error) { return { ok: false, message: error instanceof Error ? error.message : String(error) }; }
}
