import type { ToolPort } from "../../ports/tools.js";

/** Read-only host context, after the actual tool table is assembled and before execution. */
export type ToolPromptContext = (input: {
  readonly mountedTools: readonly string[];
  readonly signal?: AbortSignal;
}) => Promise<string | undefined>;

export async function resolveToolPrompt(input: {
  readonly toolPromptContext?: ToolPromptContext;
  readonly systemPromptAppend?: string;
  readonly cancelSignal?: AbortSignal;
}, tools: ToolPort): Promise<string | undefined> {
  if (input.toolPromptContext === undefined || input.cancelSignal?.aborted) return input.systemPromptAppend;
  const context = await input.toolPromptContext({ mountedTools: tools.snapshot().map(binding => binding.name),
    ...(input.cancelSignal === undefined ? {} : { signal: input.cancelSignal }) });
  return context ? [input.systemPromptAppend, context].filter(Boolean).join("\n\n") : input.systemPromptAppend;
}
