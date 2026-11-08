import {
  domainFailure,
  type DomainFailure,
  type ExternalVerdict,
  type PrivacyStamp,
  type PromptOp,
  type TaskFamily,
  type VersionPins,
  type WeakSignal,
} from "../../../../domains/shared/types.js";
import { incomparableReasons, taskFamiliesComparable, versionConfounders } from "./task-family.js";
import { patchesEquivalent } from "./patch.js";

export const DEFAULT_PROMPT_GAIN_THRESHOLD = 2;

export type PromptGainEpisode = {
  readonly id: string;
  readonly conversationId: string;
  readonly taskFamily: TaskFamily;
  readonly baselinePromptHash: string;
  readonly candidatePromptHash: string;
  readonly candidatePatch: readonly PromptOp[];
  readonly versions: VersionPins;
  readonly baselineExternal: ExternalVerdict;
  readonly candidateExternal: ExternalVerdict;
  readonly weakSignals: readonly WeakSignal[];
  readonly privacy: PrivacyStamp;
};

export type PromptAttributionRecord = {
  readonly baselinePromptHash: string;
  readonly candidatePatch: readonly PromptOp[];
  readonly taskFamily: TaskFamily;
  readonly versions: VersionPins;
  readonly causalObservationRefs: readonly [string, string];
  readonly externalResult: ExternalVerdict;
  readonly expectedBenefit: string;
  readonly regressionRisks: readonly string[];
  readonly privacy: PrivacyStamp;
  readonly threshold: number;
  readonly proposalEligible: true;
  readonly activationEligible: false;
};

export type AttributionResult =
  | { readonly kind: "proposal_eligible"; readonly record: PromptAttributionRecord }
  | DomainFailure;

const RESULT_RANK: Record<ExternalVerdict["result"], number> = {
  fail: 0,
  partial: 1,
  pass: 2,
};

export function episodeImproved(episode: PromptGainEpisode): boolean {
  return (
    RESULT_RANK[episode.candidateExternal.result] >
    RESULT_RANK[episode.baselineExternal.result]
  );
}

export function hasIndependentExternal(episode: PromptGainEpisode): boolean {
  return (
    episode.candidateExternal.selfGenerated === false &&
    episode.baselineExternal.selfGenerated === false
  );
}

export function attributeTwoPromptGains(
  first: PromptGainEpisode,
  second: PromptGainEpisode,
  threshold: number = DEFAULT_PROMPT_GAIN_THRESHOLD,
): AttributionResult {
  if (first.conversationId === second.conversationId) {
    return domainFailure(
      "insufficient_evidence",
      "observations must come from two independent conversations",
      ["same_conversation"],
    );
  }

  if (!taskFamiliesComparable(first.taskFamily, second.taskFamily)) {
    return domainFailure(
      "insufficient_attribution",
      "task families are not comparable",
      incomparableReasons(first.taskFamily, second.taskFamily),
    );
  }

  const confounders = versionConfounders(first.versions, second.versions);
  if (confounders.length > 0) {
    return domainFailure(
      "insufficient_attribution",
      "model/tool/code/workflow changed with the prompt",
      confounders,
    );
  }

  if (first.baselinePromptHash !== second.baselinePromptHash) {
    return domainFailure(
      "insufficient_attribution",
      "baseline prompt hashes differ",
      ["baselinePromptHash"],
    );
  }

  if (!patchesEquivalent(first.candidatePatch, second.candidatePatch)) {
    return domainFailure(
      "insufficient_attribution",
      "candidate patches are not the same structured delta",
      ["candidatePatch"],
    );
  }

  if (!hasIndependentExternal(first) || !hasIndependentExternal(second)) {
    return domainFailure(
      "insufficient_evidence",
      "self-generated checks cannot anchor prompt attribution",
      ["self_generated_tests"],
    );
  }

  if (!episodeImproved(first) || !episodeImproved(second)) {
    return domainFailure(
      "insufficient_evidence",
      "both independent episodes must improve in the same direction",
      ["direction"],
    );
  }

  return {
    kind: "proposal_eligible",
    record: {
      baselinePromptHash: first.baselinePromptHash,
      candidatePatch: first.candidatePatch,
      taskFamily: first.taskFamily,
      versions: first.versions,
      causalObservationRefs: [first.id, second.id],
      externalResult: second.candidateExternal,
      expectedBenefit: "external verdict improved under a prompt-only delta",
      regressionRisks: [
        "prompt framing may overfit this task family",
        "unseen failure modes may regress",
      ],
      privacy: first.privacy,
      threshold,
      proposalEligible: true,
      activationEligible: false,
    },
  };
}

export function attributeSingleEpisode(episode: PromptGainEpisode): DomainFailure {
  void episode;
  return domainFailure(
    "insufficient_evidence",
    "one successful episode is not enough for a strong prompt candidate",
  );
}
