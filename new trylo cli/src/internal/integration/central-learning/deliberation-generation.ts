import type { CentralDeliberationRequest } from "../../learning/central/runtime/contracts.js";
import { CENTRAL_DEFAULT_OUTPUT_TOKENS, CENTRAL_MAX_OUTPUT_TOKENS,
  isCentralGenerationLimits, isCentralThinkMaxOutputTokens, type CentralGenerationLimits } from "../../learning/central/runtime/generation.js";
import { CentralDeliberationError } from "./deliberation-contract.js";

/** A supplied host policy chooses generation defaults and bounds, never root
 * credit. The legacy single setting still means both default and ceiling;
 * omission of both preserves the original 8192/16384 policy. */
export function centralGenerationLimits(explicitMaximum?: number, policy?: CentralGenerationLimits): CentralGenerationLimits {
  if (explicitMaximum !== undefined && !isCentralThinkMaxOutputTokens(explicitMaximum)
    || policy !== undefined && (!isCentralGenerationLimits(policy)
      || explicitMaximum !== undefined && (policy.defaultMaxOutputTokens !== explicitMaximum || policy.maxOutputTokens !== explicitMaximum))) {
    throw new CentralDeliberationError("central_deliberation_options_invalid");
  }

  if (policy !== undefined) return { defaultMaxOutputTokens: policy.defaultMaxOutputTokens, maxOutputTokens: policy.maxOutputTokens };

  return { defaultMaxOutputTokens: explicitMaximum ?? CENTRAL_DEFAULT_OUTPUT_TOKENS,
    maxOutputTokens: explicitMaximum ?? CENTRAL_MAX_OUTPUT_TOKENS };
}

/** Resolve once for this immutable operation before quoting. Neither a failed
 * fit nor a later balance change can silently choose a different output cap. */
export function centralThinkOutputTokens(request: CentralDeliberationRequest,
  host: CentralGenerationLimits): number {
  const advertised = request.configuration.generationLimits;
  if (advertised !== undefined && (!isCentralGenerationLimits(advertised)
    || advertised.maxOutputTokens > host.maxOutputTokens || advertised.defaultMaxOutputTokens !== host.defaultMaxOutputTokens)) {
    throw new CentralDeliberationError("central_deliberation_generation_capability_invalid");
  }

  const selected = request.operation.kind === "think" ? request.operation.maxOutputTokens : undefined;
  if (selected !== undefined && (advertised === undefined || !isCentralThinkMaxOutputTokens(selected)
    || selected > advertised.maxOutputTokens || selected > host.maxOutputTokens)) {
    throw new CentralDeliberationError("central_deliberation_generation_capability_invalid");
  }

  return selected ?? advertised?.defaultMaxOutputTokens ?? host.defaultMaxOutputTokens;
}
