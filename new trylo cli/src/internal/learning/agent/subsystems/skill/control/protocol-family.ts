import { contentHashOf } from "../../../../control/hash.js";
import { identity } from "../../../../../validation/json-shape.js";

export type SkillReviewModel = { readonly providerId: string; readonly providerKind: string; readonly model: string;
  readonly reasoningEffort?: string };

export type SkillPolicyFamily = { readonly ref: string; readonly sourceRef: string; readonly response: "shared_or_exact_treatment" };

/** Native protocol identity is stable across allowance changes. Exact caps stay
 * in the execution policy; the central response owner compares shared and exact
 * treatments rather than assuming a cap has no effect. */
export function skillPolicyFamily(model?: SkillReviewModel): SkillPolicyFamily {
  if (model !== undefined && (![model.providerId, model.providerKind, model.model].every(identity)
    || model.reasoningEffort !== undefined && !identity(model.reasoningEffort))) throw new Error("hermes_review_model_metadata");

  const protocol = { nativeVersion: "0.19.0", mode: "implicit", source: "canonical-terminal-and-public-central-context",
    coverage: "official-catalog-and-native-read-before-revise", output: "confirmed-individual-native-pending",
    stop: "official-no-learning-or-finished-proposal-package-or-bounded-allowance",
    execution: "single-request-attempt-with-original-permission", ...(model === undefined ? {} : { model }) };
  const hash = contentHashOf(protocol);

  return { ref: `hermes-policy-family:${hash}`, sourceRef: `hermes-official-review-protocol:${hash}`, response: "shared_or_exact_treatment" };
}
