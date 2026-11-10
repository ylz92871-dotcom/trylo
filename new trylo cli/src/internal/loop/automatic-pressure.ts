import type { ProviderRequest } from "../ports/provider.js";
import type { CompactionInput, CompactionWiring, ReportedRequestBasis } from "./compact-boundary.js";
import { toolSpecs } from "./request.js";
import { currentPromptMessages, evaluatePreparedRequestBudget, requestTokenBasis, localViewBasis, type PreparedRequestBudgetEvaluation } from "./prompt-measurement.js";

/** Optional shipping estimate for automatic maintenance. Admission and actual
 * provider rejection keep their independent, stronger evidence contract. */
export function automaticRequestTokens(request: ProviderRequest, wiring: CompactionWiring,
  reported: ReportedRequestBasis | undefined, windowId: string | undefined,
  evaluation: PreparedRequestBudgetEvaluation): number {
  const estimate = wiring.estimateAutomaticTokens;
  if (estimate === undefined) return evaluation.decision.tokens;
  const native = evaluation.measurement.nativeIdentity;
  const local = estimate(request.messages, request.tools)
    + (native?.messageOverheadTokens.reduce((sum, tokens) => sum + tokens, 0) ?? 0);
  return evaluatePreparedRequestBudget(request, local, reported, windowId,
    messages => estimate(messages, []), native, messages => estimate(messages, []),
    evaluation.measurement.persistableInput, "automatic").decision.tokens;
}

/** Price candidate retention through the same frozen prepared presentation. */
export function automaticViewTokens(input: CompactionInput): number {
  return input.wiring?.estimateAutomaticTokens === undefined ? localViewBasis(input)
    : input.wiring.estimateAutomaticTokens(currentPromptMessages(input), input.tools === undefined ? [] : toolSpecs(input.tools));
}

/** Unprepared gaps use the original measured-prefix proof. A changed request
 * is re-estimated; it cannot borrow an unrelated complete token observation. */
export function automaticGapTokens(input: CompactionInput): number {
  if (input.wiring?.estimateAutomaticTokens === undefined) return requestTokenBasis(input);
  const estimate = input.wiring.estimateAutomaticTokens;
  return requestTokenBasis({ ...input, wiring: { ...input.wiring,
    estimatePromptTokens: messages => estimate(messages, []),
    estimateOverheadTokens: tools => estimate([], toolSpecs(tools)),
  } });
}

