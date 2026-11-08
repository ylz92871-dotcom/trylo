import { createOpenAiCompatibleProvider } from "../../adapters/provider/openai-compatible.js";
import type { CliContext } from "./context.js";
import { prepareConnectionDraft, type ConnectionDraft, type ConnectionFailure } from "./connection-draft.js";

export type ConnectionProbeResult =
  | { readonly ok: true; readonly endpoint: string; readonly model: string; readonly text: string; readonly durationMs: number; readonly scope: "text-only" }
  | (ConnectionFailure & { readonly durationMs: number });

/** Explicit user action. No tools, learning, persistence, model discovery or retry loop. */
export async function probeConnection(ctx: CliContext, draft: ConnectionDraft, cancel?: AbortSignal): Promise<ConnectionProbeResult> {
  const started = ctx.now();
  const prepared = prepareConnectionDraft(ctx, draft);
  if (!prepared.ok) return { ...prepared, durationMs: ctx.now() - started };

  const controller = new AbortController();
  const abort = () => controller.abort();

  cancel?.addEventListener("abort", abort, { once: true });

  if (cancel?.aborted) abort();

  const timer = setTimeout(abort, 30000);

  try {
    const provider = createOpenAiCompatibleProvider({ endpoint: prepared.declaration.endpoint, model: prepared.declaration.model, apiKey: prepared.apiKey, maxAttemptsBeforeHeaders: 1 });
    let text = "";
    let finished = false;

    for await (const event of provider.stream({ attemptId: ctx.newId("probe"), model: prepared.declaration.model, tools: [], maxOutputTokens: 32, messages: [{ role: "user", content: "Reply with OK." }] }, controller.signal)) {
      if (event.type === "text_delta") text += event.text;
      if (event.type === "finish") finished = true;
      if (event.type === "error") return { ok: false, code: event.class, detail: event.message, durationMs: ctx.now() - started };
    }

    if (!finished || text.trim() === "") return { ok: false, code: "empty_probe", detail: "No completed text response was received.", durationMs: ctx.now() - started };

    return { ok: true, endpoint: prepared.declaration.endpoint, model: prepared.declaration.model, text, durationMs: ctx.now() - started, scope: "text-only" };
  } finally {
    clearTimeout(timer);
    cancel?.removeEventListener("abort", abort);
  }
}
