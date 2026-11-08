import type { ExpertCommand, ExpertIdentity, ExpertLibrary, ExpertVersion } from "../../../../../subagent/experts/index.js";
import { COLLABORATION_RESOURCE_LIMITS } from "../../../../../protocol/collaboration-resource.js";

const DEFAULT_LIMIT = 8, MAX_ITEMS = 12, MAX_SUMMARY_CHARS = 12000;

export type CollaborationExpertCandidate = ExpertIdentity & {
  readonly ownerRef: string; readonly displayName: string; readonly specialty: string;
  readonly situations: readonly string[]; readonly responsibilities: readonly string[];
  readonly baseRole: ExpertVersion["configuration"]["baseRole"];
  readonly toolRefs: readonly string[];
  readonly methods: readonly Pick<ExpertVersion["configuration"]["methods"][number], "title" | "sourceUris">[];
  readonly getCommand: Extract<ExpertCommand, { readonly operation: "get" }>;
};

type DiscoveryItems = {
  readonly items: readonly CollaborationExpertCandidate[]; readonly total: number; readonly omitted: number;
  readonly sourceRefs: readonly string[]; readonly omittedFields: readonly string[]; readonly note: string;
};

export type CollaborationExpertDiscovery = DiscoveryItems & (
  { readonly mode: "query_matches"; readonly queryMatch: true }
  | { readonly mode: "catalogue_fallback"; readonly queryMatch: false }
);

function candidate(expert: ExpertVersion): CollaborationExpertCandidate {
  const configuration = expert.configuration;
  return { expertId: expert.expertId, version: expert.version, experienceKey: expert.experienceKey,
    ownerRef: `expert:${expert.expertId}@${expert.version}`, displayName: configuration.displayName, specialty: configuration.specialty,
    situations: [...configuration.situations], responsibilities: [...configuration.responsibilities], baseRole: configuration.baseRole,
    toolRefs: [...configuration.toolRefs], methods: configuration.methods.map(method => ({ title: method.title, sourceUris: [...method.sourceUris] })),
    getCommand: { operation: "get", expertId: expert.expertId, version: expert.version } };
}

/** Lexical misses fall back to the authoritative active catalogue; discovery neither ranks capability nor adopts experts. */
export function discoverCollaborationExperts(library: Pick<ExpertLibrary, "query">,
  input: { readonly query: string; readonly limit?: number }): CollaborationExpertDiscovery {
  const limit = input.limit ?? DEFAULT_LIMIT;
  if (typeof input.query !== "string" || !input.query.trim() || input.query.length > COLLABORATION_RESOURCE_LIMITS.queryMaxChars
    || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_ITEMS) throw new RangeError("expert_discovery_input_invalid");

  const matches = library.query(input.query), experts = matches.length ? matches : library.query();
  const mode = matches.length ? { mode: "query_matches" as const, queryMatch: true as const }
    : { mode: "catalogue_fallback" as const, queryMatch: false as const };
  const project = (items: readonly CollaborationExpertCandidate[]): CollaborationExpertDiscovery => ({ ...mode, items,
    total: experts.length, omitted: experts.length - items.length, sourceRefs: items.map(item => item.ownerRef),
    omittedFields: ["role configuration beyond baseRole", "constraints", "collaboration", "methods.instructions", "sources excerpts"],
    note: "Read-only discovery. Query matches are the public library's lexical matches. Catalogue fallback is a bounded list of existing active experts, not semantic matching, suitability or a best-expert recommendation. Omitted counts include the item limit and whole-candidate character budget. Methods show titles and full source URIs; use the candidate's getCommand through PA library_expert for the complete authoritative configuration. Discovery grants no construction, adoption or tool permission." });
  const items: CollaborationExpertCandidate[] = [];

  for (const expert of experts) {
    if (items.length === limit) break;
    const proposed = candidate(expert);
    // Identities and source URIs stay whole; oversized candidates never become truncated evidence.
    if (JSON.stringify(project([...items, proposed])).length <= MAX_SUMMARY_CHARS) items.push(proposed);
  }

  return project(items);
}
