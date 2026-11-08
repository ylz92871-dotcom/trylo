import { classifyLearningShape, type CompoundProposalSuggestion } from "./shared/classify.js";
import type { DomainFailure } from "./shared/types.js";
import { detectPromptPatch, type PromptDetectInput } from "../agent/subsystems/method/legacy-prompt/detector.js";
import type { PromptPatchDraft } from "../agent/subsystems/method/legacy-prompt/builder.js";
import { buildUserRule, type UserBuildResult } from "./user/builder.js";
import type { ScopeInput } from "./user/scope.js";
import { induceSkill, type SkillDraft, type SkillEpisode } from "./skill/inducer.js";
import { induceWorkflow, type WorkflowDraft, type WorkflowEpisode } from "./workflow/inducer.js";

export type DispatchInput = {
  readonly userEvent?: ScopeInput;
  readonly prompt?: PromptDetectInput;
  readonly skillEpisodes?: readonly SkillEpisode[];
  readonly workflowEpisodes?: readonly WorkflowEpisode[];
};

export type DispatchResult = {
  readonly user?: UserBuildResult;
  readonly prompt?: ReturnType<typeof detectPromptPatch>;
  readonly skill?: { readonly kind: "draft"; readonly draft: SkillDraft } | DomainFailure;
  readonly workflow?: { readonly kind: "draft"; readonly draft: WorkflowDraft } | DomainFailure;
  readonly compound?: CompoundProposalSuggestion;
  readonly activationEligible: false;
};

export function dispatchLearning(input: DispatchInput): DispatchResult {
  const user = input.userEvent === undefined ? undefined : buildUserRule(input.userEvent);
  const prompt = input.prompt === undefined ? undefined : detectPromptPatch(input.prompt);
  const skill =
    input.skillEpisodes === undefined ? undefined : induceSkill(input.skillEpisodes);
  const workflow =
    input.workflowEpisodes === undefined ? undefined : induceWorkflow(input.workflowEpisodes);
  if (
    skill?.kind === "draft" &&
    workflow?.kind === "draft" &&
    skill.draft.identity === workflow.draft.identity
  ) {
    const compound = classifyLearningShape({
      explicitFutureDirective: false,
      phrasingOnly: false,
      multiStepWithChecks: true,
      processGraph: true,
      skillIdentity: skill.draft.identity,
      workflowIdentity: workflow.draft.identity,
    });
    if (compound.kind === "compound_proposal_suggestion") {
      return {
        ...(user === undefined ? {} : { user }),
        ...(prompt === undefined ? {} : { prompt }),
        compound,
        activationEligible: false,
      };
    }
  }

  return {
    ...(user === undefined ? {} : { user }),
    ...(prompt === undefined ? {} : { prompt }),
    ...(skill === undefined ? {} : { skill }),
    ...(workflow === undefined ? {} : { workflow }),
    activationEligible: false,
  };
}

export type { PromptPatchDraft };
