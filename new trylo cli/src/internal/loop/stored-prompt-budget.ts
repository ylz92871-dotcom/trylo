import type { ProviderMessage, ProviderRequest } from "../ports/provider.js";
import type { StoredPromptInputBasisV1 } from "../ports/prompt-input.js";
import type { PromptBudgetBasisReason, PromptMeasurement } from "./prompt-measurement.js";
import { isStoredPromptInputBasisV1, promptInputCommitment, promptNativeSystemDigest } from "./prompt-input-basis.js";

type StoredBudgetEvaluation = { readonly kind: "matched"; readonly tokens: number; readonly addedTokens: number }
  | { readonly kind: "unavailable"; readonly reason: PromptBudgetBasisReason };

/** A compact checkpoint proves an ordered prefix, never an arbitrary
 * subsequence. The active turn's original array matcher remains unchanged. */
export function evaluateStoredPromptInputBasis(request: ProviderRequest, current: PromptMeasurement,
  stored: StoredPromptInputBasisV1, estimatePromptTokens: (messages: readonly ProviderMessage[]) => number,
  estimateTextPromptTokens?: (messages: readonly ProviderMessage[]) => number,
  automatic?: { readonly currentTokens: number }): StoredBudgetEvaluation {
  const no = (reason: PromptBudgetBasisReason): StoredBudgetEvaluation => ({ kind: "unavailable", reason });

  if (!isStoredPromptInputBasisV1(stored)) return no("invalid_report");

  if (stored.model !== request.model) return no("model_changed");

  const binding = current.persistableInput;
  if (binding === undefined) return no("input_binding_unavailable");

  if (stored.inputBindingDigest !== binding.inputBindingDigest) return no("input_binding_changed");

  if (stored.settingsDigest !== binding.settingsDigest) return no("request_settings_changed");

  if (stored.toolDigest !== current.toolDigest) return no("tools_changed");

  if (stored.windowDigest !== binding.windowDigest) return no("window_changed");

  const native = current.nativeIdentity;
  if (native === null || native !== undefined && estimateTextPromptTokens === undefined) return no("native_unverifiable");

  if (stored.nativeMode !== (native === undefined ? "none" : "measured")) return no("native_changed");

  const roles = current.messageRoles;
  if (roles === undefined || roles.length !== current.messageDigests.length) return no("invalid_report");

  const history: number[] = [], systems: number[] = [];

  for (const [index, role] of roles.entries()) (role === "system" ? systems : history).push(index);

  if (history.length < stored.nonSystem.count
    || promptInputCommitment(current, history.slice(0, stored.nonSystem.count)).digest !== stored.nonSystem.digest) return no("history_changed");

  if (native !== undefined && (systems.length < stored.systems.count
    || promptNativeSystemDigest(current, systems.slice(0, stored.systems.count)) !== stored.systems.nativeDigest)) return no("native_changed");

  const sameSystems = systems.length === stored.systems.count && promptInputCommitment(current, systems).digest === stored.systems.digest;
  const added = [...history.slice(stored.nonSystem.count), ...(sameSystems ? [] : systems)].sort((a, b) => a - b);
  const messages = added.map(index => request.messages[index]!);
  if (messages.some(message => (message.attachments?.length ?? 0) > 0 || (message.imageReferences?.length ?? 0) > 0)) return no("unpriced_media");

  const price = (indices: readonly number[]) => indices.length === 0 ? 0 : native === undefined
    ? estimatePromptTokens(indices.map(index => request.messages[index]!))
    : estimateTextPromptTokens!(indices.map(index => request.messages[index]!)) + indices.reduce((sum, index) => sum + native.messageOverheadTokens[index]!, 0);
  // The compact proof cannot reconstruct old system text. Admission keeps
  // charging the replacement in full; automatic maintenance re-estimates the
  // current presentation while retaining the observed input/history floor.
  const addedTokens = price(automatic !== undefined && !sameSystems ? history.slice(stored.nonSystem.count) : added);
  const tokens = Math.max(stored.input.tokens + addedTokens, automatic !== undefined && !sameSystems ? automatic.currentTokens : 0);
  if (!Number.isSafeInteger(addedTokens) || addedTokens < 0 || !Number.isSafeInteger(tokens)) return no("invalid_report");

  return { kind: "matched", tokens, addedTokens };
}
