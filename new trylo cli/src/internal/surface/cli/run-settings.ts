import { EXIT_CODES } from "../../protocol/cli-stream.js";
import { isOutputFormat, type OutputFormat, type RunCommandOptions } from "./args.js";
import type { ConfigLoadIo } from "./config-load.js";
import type { CliContext } from "./context.js";
import { fail, type RunFailure } from "./run-failure.js";
import { tryloHome } from "./session-paths.js";

/**
 * Turning merged config + flags into the settings a run actually uses.
 *
 * The values here are already merged by the config loader; this module only
 * validates them against the closed sets the CLI supports and rejects an
 * unusable value rather than silently substituting a default.
 */

export type ResolvedSettings = {
  /**
   * Any provider id: the merged config carries whatever was set, and whether
   * it names a shipped or declared provider is decided by the resolver, not
   * duplicated here.
   */
  readonly providerId: string;
  readonly model: string;
  readonly endpoint: string;
  readonly format: OutputFormat;
  readonly maxIterations?: number;
  readonly maxTokens?: number;
  /**
   * Optional working-window preference. Execution defaults it to 200K and
   * clamps it to every declared provider/model capacity.
   */
  readonly contextTokenLimit?: number;
  readonly modelContextWindow?: number;
  /**
   * The dollar ceiling (WP09.3/L07), from config or `--max-budget-usd`.
   * Pricing comes from the two keys beside it; a ceiling without pricing is
   * refused at preparation rather than silently unenforced.
   */
  readonly maxBudgetUsd?: number;
  readonly inputPricePerMTok?: number;
  readonly outputPricePerMTok?: number;
  /**
   * Path to the language-server file (WP12 L60). A path, never the servers:
   * the file is read and validated at the turn boundary, and absent means no
   * `lsp_navigate` in the catalog at all.
   */
  readonly lspConfigFile?: string;
  /**
   * The interpreter for `run_shell` command strings (WP05 C06/C07). A name,
   * never a program: resolution against this machine happens at the turn
   * boundary, and absent means the direct path byte for byte as before.
   */
  readonly shell?: string;
};

export function configIo(ctx: CliContext): ConfigLoadIo {
  return { readFile: ctx.readFile, profileDir: tryloHome(ctx.homeDir, ctx.env), cwd: ctx.cwd };
}

export function flagLayer(options: RunCommandOptions): Record<string, string | number> {
  return {
    ...(options.provider === undefined ? {} : { provider: options.provider }),
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.endpoint === undefined ? {} : { endpoint: options.endpoint }),
    ...(options.format === undefined ? {} : { format: options.format }),
    ...(options.maxIterations === undefined ? {} : { maxIterations: options.maxIterations }),
    ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
    ...(options.contextTokenLimit === undefined ? {} : { contextTokenLimit: options.contextTokenLimit }),
    ...(options.modelContextWindow === undefined ? {} : { modelContextWindow: options.modelContextWindow }),
    ...(options.maxBudgetUsd === undefined ? {} : { maxBudgetUsd: options.maxBudgetUsd }),
  };
}

function stringEntry(
  resolved: Readonly<Record<string, { readonly value: unknown }>>,
  key: string,
): string | undefined {
  const entry = resolved[key];
  return typeof entry?.value === "string" ? entry.value : undefined;
}

function numberEntry(
  resolved: Readonly<Record<string, { readonly value: unknown }>>,
  key: string,
): number | undefined {
  const entry = resolved[key];
  return typeof entry?.value === "number" ? entry.value : undefined;
}

export function resolveSettings(
  resolved: Readonly<Record<string, { readonly value: unknown }>>,
): ResolvedSettings | RunFailure {
  const providerRaw = stringEntry(resolved, "provider") ?? "fixture";
  const formatRaw = stringEntry(resolved, "format") ?? "text";
  if (!isOutputFormat(formatRaw)) {
    return fail(
      EXIT_CODES.CONFIG,
      `configured format is not supported: ${formatRaw}`,
      "set `format` to text or stream-json",
    );
  }
  const maxIterations = numberEntry(resolved, "maxIterations");
  const maxTokens = numberEntry(resolved, "maxTokens");
  const contextTokenLimit = numberEntry(resolved, "contextTokenLimit");
  const modelContextWindow = numberEntry(resolved, "modelContextWindow");
  const maxBudgetUsd = numberEntry(resolved, "maxBudgetUsd");
  const inputPricePerMTok = numberEntry(resolved, "inputPricePerMTok");
  const outputPricePerMTok = numberEntry(resolved, "outputPricePerMTok");
  const lspConfigFile = stringEntry(resolved, "lspConfigFile");
  const shell = stringEntry(resolved, "shell");
  return {
    providerId: providerRaw,
    model: stringEntry(resolved, "model") ?? "default",
    endpoint: stringEntry(resolved, "endpoint") ?? "",
    format: formatRaw,
    ...(maxIterations === undefined ? {} : { maxIterations }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
    ...(contextTokenLimit === undefined ? {} : { contextTokenLimit }),
    ...(modelContextWindow === undefined ? {} : { modelContextWindow }),
    ...(maxBudgetUsd === undefined ? {} : { maxBudgetUsd }),
    ...(inputPricePerMTok === undefined ? {} : { inputPricePerMTok }),
    ...(outputPricePerMTok === undefined ? {} : { outputPricePerMTok }),
    ...(lspConfigFile === undefined ? {} : { lspConfigFile }),
    ...(shell === undefined ? {} : { shell }),
  };
}
