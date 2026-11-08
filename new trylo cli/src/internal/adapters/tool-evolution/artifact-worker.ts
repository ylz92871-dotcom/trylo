import { emptyUsage, mergeUsage, type ProviderEvent, type ProviderPort, type ProviderUsage } from "../../ports/provider.js";
import type { SubagentTaskExecutor } from "../../subagent/tool-runner.js";
import type { SubagentContext } from "../../subagent/types.js";

/** One bounded, tool-free generation request. The caller validates the artifact. */
export type ToolEvolutionWorkerOptions = {
  readonly provider: ProviderPort;
  readonly model: string;
  readonly maxPromptChars?: number;
  readonly maxOutputChars?: number;
  readonly maxOutputTokens?: number;
  readonly maxEvents?: number;
};

export type ToolEvolutionWorkerFailure =
  | "invalid_task_prompt"
  | "provider_isolation_unavailable"
  | "provider_error"
  | "tool_call_forbidden"
  | "incomplete_generation"
  | "output_limit"
  | "event_limit"
  | "cancelled";

export class ToolEvolutionWorkerError extends Error {
  constructor(readonly code: ToolEvolutionWorkerFailure, diagnostic?: Pick<Extract<ProviderEvent, { type: "error" }>, "class" | "phase">) {
    super(`tool_evolution_${code}${diagnostic === undefined ? "" : ` [${diagnostic.class}:${diagnostic.phase}]`}`);
    this.name = "ToolEvolutionWorkerError";
  }
}


type WorkerLimits = { readonly prompt: number | undefined; readonly output: number | undefined;
  readonly tokens: number | undefined; readonly events: number | undefined };

type CandidateRequest = { readonly provider: ProviderPort; readonly model: string; readonly taskId: string; readonly prompt: string };

export type ArtifactWorkerOptions = ToolEvolutionWorkerOptions & {
  readonly instruction: string;
  readonly requestPrefix: string;
};

/** Shared transport mechanics; domain instructions remain owned by each learning subsystem. */
export function createArtifactWorker(options: ArtifactWorkerOptions): SubagentTaskExecutor {
  const limits: WorkerLimits = {
    prompt: positiveLimit(options.maxPromptChars),
    output: positiveLimit(options.maxOutputChars),
    tokens: positiveLimit(options.maxOutputTokens),
    events: positiveLimit(options.maxEvents),
  };

  if (options.model.trim().length === 0 || !options.instruction.trim() || !/^[a-z][a-z0-9-]{0,63}$/u.test(options.requestPrefix)) {
    throw new Error("artifact worker requires a model, domain instruction and bounded request prefix");
  }

  return async (task, context): Promise<string> => {
    const prompt = task.input["prompt"];
    if (typeof prompt !== "string" || prompt.trim().length === 0 || limits.prompt !== undefined && prompt.length > limits.prompt) {
      throw new ToolEvolutionWorkerError("invalid_task_prompt");
    }
    if (context.signal.aborted) throw new ToolEvolutionWorkerError("cancelled");
    return generateCandidate({ provider: options.provider, model: options.model, taskId: task.taskId, prompt }, context, limits, options);
  };
}

async function generateCandidate(request: CandidateRequest, context: SubagentContext, limits: WorkerLimits,
  domain: Pick<ArtifactWorkerOptions, "instruction" | "requestPrefix">): Promise<string> {
  const controller = new AbortController();
  const abort = (): void => controller.abort();

  context.signal.addEventListener("abort", abort, { once: true });
  let usage: ProviderUsage = emptyUsage();

  try {
    if (context.signal.aborted) throw new ToolEvolutionWorkerError("cancelled");

    const provider = isolatedProvider(request.provider);

    context.reportProgress("Generating a candidate tool artifact");
    const text = await collectCandidate(provider.stream({
      attemptId: `${domain.requestPrefix}:${request.taskId}`,
      model: request.model,
      messages: [
        { role: "system", content: domain.instruction },
        { role: "user", content: request.prompt },
      ],
      tools: [],
      ...(limits.tokens === undefined ? {} : { maxOutputTokens: limits.tokens }),
      ...(provider.responseFormats?.includes("json_object") ? { responseFormat: { type: "json_object" as const } } : {}),
    }, controller.signal), context.signal, limits, incoming => { usage = mergeUsage(usage, incoming); });

    context.reportProgress("Candidate generated; independent verification is still required");

    return text;
  } catch (error) {
    if (context.signal.aborted) throw new ToolEvolutionWorkerError("cancelled");
    if (error instanceof ToolEvolutionWorkerError) throw error;
    throw new ToolEvolutionWorkerError("provider_error");
  } finally {
    controller.abort();
    context.signal.removeEventListener("abort", abort);
    context.recordUsage(usage.inputTokens, usage.outputTokens);
  }
}

async function collectCandidate(
  stream: AsyncIterable<ProviderEvent>, signal: AbortSignal, limits: WorkerLimits,
  onUsage: (usage: ProviderUsage) => void,
): Promise<string> {
  let text = "";
  let events = 0;

  for await (const event of stream) {
    if (signal.aborted || event.type === "cancel_ack") throw new ToolEvolutionWorkerError("cancelled");

    events += 1;

    if (limits.events !== undefined && events > limits.events) throw new ToolEvolutionWorkerError("event_limit");

    if (event.type === "usage") onUsage(event.usage);

    if (event.type === "text_delta") {
      if (limits.output !== undefined && text.length + event.text.length > limits.output) throw new ToolEvolutionWorkerError("output_limit");
      text += event.text;
    }

    if (event.type.startsWith("tool_")) throw new ToolEvolutionWorkerError("tool_call_forbidden");

    if (event.type === "error") throw new ToolEvolutionWorkerError("provider_error", event);

    if (event.type === "finish") {
      if (event.reason !== "stop" || event.requiresFollowUp || text.trim().length === 0) {
        throw new ToolEvolutionWorkerError("incomplete_generation");
      }
      return text.trim();
    }
  }

  throw new ToolEvolutionWorkerError("incomplete_generation");
}

function isolatedProvider(provider: ProviderPort): ProviderPort {
  const fork = provider.fork?.();
  if (fork !== undefined && (fork !== provider || provider.continuation === undefined)) return fork;
  if (provider.continuation !== undefined) throw new ToolEvolutionWorkerError("provider_isolation_unavailable");
  return provider;
}

function positiveLimit(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("tool evolution limits must be positive integers");
  return value;
}
