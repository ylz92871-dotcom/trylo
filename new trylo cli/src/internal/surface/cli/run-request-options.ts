import type { SystemPromptDirective } from "../../ports/provider.js";
import { EXIT_CODES } from "../../protocol/cli-stream.js";
import { loadResponseSchema } from "../../adapters/provider/structured-output.js";
import { validateFallback } from "../../adapters/provider/fallback-resolver.js";
import { catalogFromDeclaredModels, demandStructuredSupport } from "../../adapters/provider/model-catalog.js";
import type { ResolvedRequestOptions, RunCommandOptions } from "./args.js";
import { fail, type RunFailure } from "./run-failure.js";

/**
 * Resolve a run's caller-prompt/schema/fallback flags (WP18.2 L05, WP18.3
 * C74/L67).
 *
 * One function because the four facts share one discipline: raw CLI values
 * are validated here, files are read here, and anything unusable refuses the
 * run with a code and a next step — never with a silent default. A connection
 * switch carries the already-resolved value (`resolvedRequest`), so a
 * mid-session switch does not re-read files that may have changed under it.
 */

export type RequestModelSelection = {
  readonly model: string;
  readonly declaredModels: ReadonlyArray<string>;
};

export type RequestOptionsReader = {
  readonly readFile: (absolutePath: string) => string | undefined;
};

function readPromptFile(
  reader: RequestOptionsReader,
  path: string | undefined,
  flag: string,
): { readonly text?: string } | RunFailure {
  if (path === undefined) {
    return {};
  }

  const content = reader.readFile(path);
  if (content === undefined) {
    return fail(
      EXIT_CODES.CONFIG,
      `cannot read ${flag} file: ${path}`,
      "pass a readable file, or drop the flag",
    );
  }

  return { text: content };
}

function resolveSystemPrompt(
  reader: RequestOptionsReader,
  options: RunCommandOptions,
): { readonly systemPrompt?: SystemPromptDirective; readonly systemPromptAppend?: string } | RunFailure {
  if (options.resolvedRequest !== undefined) {
    const carried = options.resolvedRequest;
    return {
      ...(carried.systemPrompt === undefined ? {} : { systemPrompt: carried.systemPrompt }),
      ...(carried.systemPromptAppend === undefined ? {} : { systemPromptAppend: carried.systemPromptAppend }),
    };
  }

  const replaceInline = options.systemPrompt;
  const replaceFile = readPromptFile(reader, options.systemPromptFile, "--system-prompt-file");
  if ("exitCode" in replaceFile) {
    return replaceFile;
  }

  const appendInline = options.appendSystemPrompt;
  const appendFile = readPromptFile(reader, options.appendSystemPromptFile, "--append-system-prompt-file");
  if ("exitCode" in appendFile) {
    return appendFile;
  }

  const replaceText = replaceInline ?? replaceFile.text;
  const appendText = appendInline ?? appendFile.text;

  return {
    ...(replaceText === undefined || replaceText.trim().length === 0
      ? {}
      : { systemPrompt: { mode: "replace" as const, text: replaceText } }),
    ...(appendText === undefined || appendText.trim().length === 0
      ? {}
      : { systemPromptAppend: appendText }),
  };
}

function resolveResponseSchema(
  reader: RequestOptionsReader,
  options: RunCommandOptions,
  selection: RequestModelSelection,
): { readonly responseSchema?: NonNullable<ResolvedRequestOptions["responseSchema"]> } | RunFailure {
  if (options.resolvedRequest !== undefined) {
    const carried = options.resolvedRequest;
    return carried.responseSchema === undefined ? {} : { responseSchema: carried.responseSchema };
  }

  if (options.outputSchema === undefined) {
    return {};
  }

  const text = reader.readFile(options.outputSchema);
  if (text === undefined) {
    return fail(
      EXIT_CODES.CONFIG,
      `cannot read --output-schema file: ${options.outputSchema}`,
      "pass a readable JSON Schema file, or drop the flag",
    );
  }

  const loaded = loadResponseSchema(text);
  if (!loaded.ok) {
    return fail(
      EXIT_CODES.CONFIG,
      `--output-schema is not usable: ${loaded.failure.code}: ${loaded.failure.detail}`,
      "pass a file holding a non-empty JSON Schema object",
    );
  }

  // Refuse before sending when the declaration positively says the model
  // cannot honour structure. Undeclared models pass through and the endpoint
  // decides; its 400 refusal surfaces as `invalid_request`, never as silent
  // plain text.
  const gate = demandStructuredSupport(catalogFromDeclaredModels(selection.declaredModels), selection.model);
  if (!gate.ok) {
    return fail(
      EXIT_CODES.CONFIG,
      `model ${selection.model} does not declare structured output; not sending --output-schema`,
      "pick a model that declares it, or drop the flag",
    );
  }

  return { responseSchema: loaded.schema };
}

/**
 * Turn raw flags (or a switch's carried values) into the scaffold's facts.
 * Every refusal names the flag and the fix; nothing here falls back to a
 * default the person never asked for.
 */
export function resolveRequestOptions(
  reader: RequestOptionsReader,
  options: RunCommandOptions,
  selection: RequestModelSelection,
): ResolvedRequestOptions | RunFailure {
  if (options.resolvedRequest !== undefined) {
    const carried = options.resolvedRequest;
    const fallback = carried.fallbackModel;
    if (fallback !== undefined) {
      const checked = validateFallback(selection.model, fallback);
      if (!checked.ok) {
        return fail(EXIT_CODES.USAGE, checked.detail, "pass a fallback model different from the run's model");
      }
    }

    return { ...carried };
  }

  const prompt = resolveSystemPrompt(reader, options);
  if ("exitCode" in prompt) {
    return prompt;
  }

  const schema = resolveResponseSchema(reader, options, selection);
  if ("exitCode" in schema) {
    return schema;
  }

  const fallback = options.fallbackModel;
  const reasoning = options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort };

  if (fallback !== undefined) {
    const checked = validateFallback(selection.model, fallback);
    if (!checked.ok) {
      return fail(EXIT_CODES.USAGE, checked.detail, "pass a fallback model different from the run's model");
    }

    return {
      ...prompt,
      ...schema,
      ...reasoning,
      ...(checked.declaration.fallback === undefined ? {} : { fallbackModel: checked.declaration.fallback }),
    };
  }

  return { ...prompt, ...schema, ...reasoning };
}
