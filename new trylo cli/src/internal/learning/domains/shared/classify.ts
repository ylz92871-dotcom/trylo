import { blockDualSave } from "./dual-save.js";
import { domainFailure, type DomainFailure } from "./types.js";

export type CompoundProposalSuggestion = {
  readonly kind: "compound_proposal_suggestion";
  readonly status: "draft";
  readonly parts: readonly ["skill", "workflow"];
  readonly identity: string;
  readonly activationEligible: false;
};

export type Classification =
  | { readonly kind: "user_rule" }
  | { readonly kind: "prompt_patch"; readonly strongCandidate: false }
  | { readonly kind: "skill" }
  | { readonly kind: "workflow" }
  | CompoundProposalSuggestion
  | DomainFailure;

export function classifyLearningShape(input: {
  readonly explicitFutureDirective: boolean;
  readonly phrasingOnly: boolean;
  readonly multiStepWithChecks: boolean;
  readonly processGraph: boolean;
  readonly skillIdentity?: string;
  readonly workflowIdentity?: string;
}): Classification {
  const dual = blockDualSave(input.skillIdentity, input.workflowIdentity);
  if (dual !== undefined && input.skillIdentity !== undefined) {
    return {
      kind: "compound_proposal_suggestion",
      status: "draft",
      parts: ["skill", "workflow"],
      identity: input.skillIdentity,
      activationEligible: false,
    };
  }

  if (input.explicitFutureDirective && input.phrasingOnly) {
    return { kind: "user_rule" };
  }

  if (input.phrasingOnly) {
    return { kind: "prompt_patch", strongCandidate: false };
  }

  if (input.processGraph && input.multiStepWithChecks === false) {
    return { kind: "workflow" };
  }

  if (input.multiStepWithChecks && input.processGraph === false) {
    return { kind: "skill" };
  }

  if (input.multiStepWithChecks && input.processGraph) {
    return domainFailure(
      "needs_more_evidence",
      "ambiguous skill vs workflow shape without matching identities",
    );
  }

  return domainFailure("needs_more_evidence", "shape is too thin to classify");
}
