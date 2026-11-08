import { ExpertLibraryError, type ExpertExperiencePort } from "../../../../../subagent/experts/index.js";
import type { ExperienceContext } from "./contracts.js";
import { EXPERIENCE_CARD_MAX_CHARS } from "./contracts.js";
import type { CollaborationExperienceStore } from "./store.js";

/** The library supplies actual identity; the host supplies task conditions, never inferred role ownership. */
export function createExpertExperiencePort(options: { readonly store: Pick<CollaborationExperienceStore, "prepareExperience">;
  readonly contextFor?: (input: Parameters<ExpertExperiencePort["load"]>[0]) => ExperienceContext }): ExpertExperiencePort {
  return { async load(input) {
    if (input.signal.aborted) return { text: "", versionIds: [] };

    const result = await options.store.prepareExperience({ owner: { kind: "expert", experienceKey: input.experienceKey },
      expertVersion: input.version, ...(input.draft === undefined ? {} : { expertDraft: input.draft }),
      ...(options.contextFor === undefined ? {} : { context: options.contextFor(input) }),
      maxChars: Math.min(EXPERIENCE_CARD_MAX_CHARS, input.maxChars) });

    if (input.signal.aborted) return { text: "", versionIds: [] };

    if (!result.ok) {
      if (result.reason === "collect_disabled") return { text: "", versionIds: [] };
      throw new ExpertLibraryError("resource_unavailable", `Collaboration experience unavailable: ${result.reason}`);
    }

    return { text: result.text, versionIds: result.versionIds };
  } };
}
