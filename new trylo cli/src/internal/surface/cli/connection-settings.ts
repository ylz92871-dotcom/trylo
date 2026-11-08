import type { RunCommandOptions } from "./args.js";
import type { CliContext } from "./context.js";
import { loadConfig, type LayerSource } from "./config-load.js";
import { configIo, flagLayer, resolveSettings, type ResolvedSettings } from "./run-settings.js";
import { fail, type RunFailure } from "./run-failure.js";
import { selectForRun, type RunProvider } from "./provider-selection.js";
import { EXIT_CODES } from "../../protocol/cli-stream.js";

export type ConnectionSettings = {
  readonly provider: RunProvider;
  readonly settings: ResolvedSettings;
  readonly sources: ReadonlyArray<LayerSource>;
  readonly profileDir: string;
};

/** Shared by real run preparation and read-only configuration views. Never resolves a secret. */
export function resolveConnectionSettings(ctx: CliContext, options: RunCommandOptions): ConnectionSettings | RunFailure {
  const io = configIo(ctx);
  const loaded = loadConfig(io, flagLayer(options));
  if (!loaded.ok) {
    return fail(EXIT_CODES.CONFIG, `${loaded.failure.path ?? loaded.failure.layer} is not usable: ${loaded.failure.detail}`, "fix that configuration file; no silent fallback is applied");
  }

  const settings = resolveSettings(loaded.resolved);
  if ("exitCode" in settings) return settings;

  // Pricing belongs to connection validation, before any session acquires a writer.
  if (settings.maxBudgetUsd !== undefined && (settings.inputPricePerMTok === undefined || settings.outputPricePerMTok === undefined)) {
    return fail(EXIT_CODES.USAGE, "--max-budget-usd needs pricing: set inputPricePerMTok and outputPricePerMTok", "add both pricing keys to config (US dollars per million tokens) so the budget can be enforced");
  }

  const provider = selectForRun(ctx, { resolved: loaded.resolved, options, endpoint: settings.endpoint, model: settings.model });
  if ("exitCode" in provider) return provider;

  return { provider, settings, sources: loaded.sources, profileDir: io.profileDir };
}
