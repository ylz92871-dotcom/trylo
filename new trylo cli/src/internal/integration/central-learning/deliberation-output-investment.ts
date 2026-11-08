import type { CentralDeliberationRequest } from "../../learning/central/runtime/contracts.js";
import { CENTRAL_MIN_OUTPUT_TOKENS } from "../../learning/central/runtime/generation.js";
import { CentralDeliberationError } from "./deliberation-contract.js";

/** A prospective quote only. The driver must rebuild its canonical issue state
 * with this choice; the driver owns host selection and unissued-history proof.
 * A delivery projection may never rewrite an issued thought. */
export function selectCentralAutomaticOutput(request: CentralDeliberationRequest, defaultOutput: number,
  prepare: (candidate: CentralDeliberationRequest) => void): number | undefined {
  if (request.operation.kind !== "think" || request.operation.maxOutputTokens !== undefined
    || request.configuration.generationLimits === undefined) return undefined;

  const fits = (candidate: CentralDeliberationRequest) => {
    try {
      prepare(candidate);
      return true;
    }
    catch (error) {
      if (error instanceof CentralDeliberationError && error.reason === "central_deliberation_context_capacity") return false;
      throw error;
    }
  };
  if (fits(request)) return undefined;

  let low = CENTRAL_MIN_OUTPUT_TOKENS, high = defaultOutput - 1, selected: number | undefined;

  // The complete wire, including the explicit operation field, is re-quoted at
  // each integer boundary. Optional history fills space only after generation
  // and necessary delivery fit; a minimum-output packed view is not the basis.
  while (low <= high) {
    const maxOutputTokens = Math.floor((low + high) / 2), operation = { ...request.operation, maxOutputTokens };
    const candidate = { ...request, operation, state: { ...request.state,
      completed: request.state.completed.map(row => row.operation.operationId === operation.operationId ? { ...row, operation } : row) } };
    if (fits(candidate)) {
      selected = maxOutputTokens;
      low = maxOutputTokens + 1;
    }
    else high = maxOutputTokens - 1;
  }

  return selected;
}
