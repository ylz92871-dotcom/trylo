import type { ExpertBuildPort, ExpertConfiguration, ExpertExperiencePort, ExpertRequest, ExpertSource } from "./contracts.js";
import { ExpertLibraryError } from "./contracts.js";
import { validateConfiguration } from "./validation.js";
import { EXPERT_EXPERIENCE_MAX_CHARS, normalizeExpertExperience, type ExpertGuidance } from "./experience.js";

export type { ExpertGuidance } from "./experience.js";

/** Resource collection is host-authorized IO; synthesis cannot invent evidence. */
export type ExpertResources = {
  readonly sources: readonly ExpertSource[];
  readonly installedSkills: readonly { readonly name: string; readonly description: string }[];
  readonly toolNames: readonly string[];
  readonly toolReferences?: readonly { readonly ref: string; readonly runtimeName: string }[];
};

export type ExpertResourcePort = {
  collect(input: { readonly request: ExpertRequest; readonly previous?: ExpertConfiguration;
    readonly signal: AbortSignal }): Promise<ExpertResources>;
};

export type ExpertSynthesisPort = {
  synthesize(input: { readonly request: ExpertRequest; readonly previous?: ExpertConfiguration;
    readonly resources: ExpertResources; readonly guidance?: ExpertGuidance; readonly signal: AbortSignal }): Promise<unknown>;
};

/** One builder is shared by settings, Personal Agent and collaboration. */
export function createExpertBuilder(options: { readonly resources: ExpertResourcePort;
  readonly synthesize: ExpertSynthesisPort; readonly experience?: ExpertExperiencePort }): ExpertBuildPort {
  return { async build(input) {
    assertBuildAuthorized(input.request, input.signal);
    const resources = await options.resources.collect(input);

    assertBuildAuthorized(input.request, input.signal);

    if (resources.sources.length === 0) {
      throw new ExpertLibraryError("resource_unavailable", "No specialist resource could be read; configure a reachable source or installed skill");
    }

    const guidance = options.experience === undefined || input.request.baseVersion === 0 ? undefined
      : normalizeExpertExperience(await options.experience.load({ expertId: input.request.expertId, version: input.request.baseVersion,
        experienceKey: input.request.experienceKey, task: input.request.instruction, maxChars: EXPERT_EXPERIENCE_MAX_CHARS, signal: input.signal }));

    assertBuildAuthorized(input.request, input.signal);
    const raw = await options.synthesize.synthesize({ ...input, resources, ...(guidance === undefined ? {} : { guidance }) });

    assertBuildAuthorized(input.request, input.signal);
    const candidate = validateConfiguration(raw);
    const evidence = new Map(resources.sources.map(source => [source.uri, source]));
    if (candidate.sources.some(source => !evidence.has(source.uri))) {
      throw new ExpertLibraryError("invalid_input", "The proposed configuration cites a source that was not retrieved");
    }

    if ((candidate.role.skills ?? []).some(name => !resources.installedSkills.some(skill => skill.name === name))) {
      throw new ExpertLibraryError("resource_unavailable", "The proposed configuration requests a skill that is not installed");
    }

    if (candidate.baseRole !== "worker" && (candidate.role.skills?.length ?? 0) > 0) {
      throw new ExpertLibraryError("resource_unavailable", "The existing team runtime preloads specialist skills only for worker seats");
    }

    if (resources.toolReferences !== undefined) {
      const known = new Set([...resources.toolReferences.map(item => item.ref),
        ...(input.previous?.toolRefs ?? []), ...(input.request.userEdits.toolRefs ?? [])]);
      if (candidate.toolRefs.some(ref => !known.has(ref))) {
        throw new ExpertLibraryError("invalid_input", "The proposed configuration invents a tool reference outside the current catalog");
      }
    }

    // The adapter's read evidence, including excerpts, is authoritative. Model
    // text may reference it but cannot rewrite provenance into invented facts.
    return { ...candidate, sources: candidate.sources.map(source => evidence.get(source.uri)!) };
  } };
}

function assertBuildAuthorized(request: ExpertRequest, signal: AbortSignal): void {
  if (signal.aborted) throw new ExpertLibraryError("cancelled", "Expert construction was cancelled");
  if (!request.creationAuthorization || (request.state !== "authorized" && request.state !== "revision_requested")) {
    throw new ExpertLibraryError("unauthorized", "Expert construction requires recorded user creation authorization");
  }
}
