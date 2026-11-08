import { parsePromptOps } from "../../../../domains/shared/parse.js";
import { domainFailure, type DomainFailure } from "../../../../domains/shared/types.js";
import {
  attributeSingleEpisode,
  attributeTwoPromptGains,
  DEFAULT_PROMPT_GAIN_THRESHOLD,
  type PromptGainEpisode,
} from "./attribution.js";
import { buildPromptPatchDraft, type PromptPatchDraft } from "./builder.js";
import { forbiddenClaimsIn, forbiddenClaimsInOps, nearDuplicatePatches } from "./patch.js";

export type PromptDetectInput = {
  readonly episodes: readonly PromptGainEpisode[];
  readonly extraClaims?: readonly string[];
};

export type PromptDetectResult =
  | { readonly kind: "draft"; readonly draft: PromptPatchDraft }
  | DomainFailure;

export function detectPromptPatch(input: PromptDetectInput): PromptDetectResult {
  const smuggled = [
    ...forbiddenClaimsIn(input.extraClaims ?? []),
    ...input.episodes.flatMap((episode) => forbiddenClaimsInOps(episode.candidatePatch)),
  ];
  if (smuggled.length > 0) {
    return domainFailure(
      "forbidden_payload",
      "prompt patch cannot carry permission, tool switch, or workflow topology",
      smuggled,
    );
  }

  for (const episode of input.episodes) {
    if (episode.id.trim().length === 0 || episode.conversationId.trim().length === 0) {
      return domainFailure("malformed_input", "episode id and conversationId are required");
    }

    if (
      episode.baselinePromptHash.trim().length === 0 ||
      episode.candidatePromptHash.trim().length === 0
    ) {
      return domainFailure("malformed_input", "prompt hashes are required");
    }

    const ops = parsePromptOps(episode.candidatePatch);
    if (!ops.ok) {
      return domainFailure("malformed_input", ops.reason);
    }
  }

  if (input.episodes.length < DEFAULT_PROMPT_GAIN_THRESHOLD) {
    if (input.episodes[0] !== undefined) {
      return attributeSingleEpisode(input.episodes[0]);
    }
    return domainFailure("insufficient_evidence", "no prompt gain episodes supplied");
  }

  const first = input.episodes[0];
  const second = input.episodes[1];
  if (first === undefined || second === undefined) {
    return domainFailure("insufficient_evidence", "two episodes are required");
  }

  const attributed = attributeTwoPromptGains(first, second);
  if (attributed.kind === "failure") {
    return attributed;
  }

  return { kind: "draft", draft: buildPromptPatchDraft(attributed.record) };
}

export function dedupePromptDrafts(
  drafts: readonly PromptPatchDraft[],
): PromptPatchDraft[] {
  const seen = new Map<string, PromptPatchDraft>();

  for (const draft of drafts) {
    const key = `${draft.baselinePromptHash}|${JSON.stringify(draft.candidatePatch)}|${draft.taskFamilyId}`;
    const existing = seen.get(key);
    if (existing === undefined) {
      seen.set(key, draft);
    }
  }

  return [...seen.values()];
}

export function mergeNearDuplicateDrafts(
  drafts: readonly PromptPatchDraft[],
): PromptPatchDraft[] {
  const kept: PromptPatchDraft[] = [];

  for (const draft of drafts) {
    const duplicate = kept.find(
      (item) =>
        item.baselinePromptHash === draft.baselinePromptHash &&
        item.taskFamilyId === draft.taskFamilyId &&
        nearDuplicatePatches(item.candidatePatch, draft.candidatePatch),
    );
    if (duplicate === undefined) {
      kept.push(draft);
    }
  }

  return kept;
}

export function rejectPromptPatch(
  draft: PromptPatchDraft,
  reason: string,
): DomainFailure {
  void draft;
  return domainFailure("forbidden_payload", reason);
}
