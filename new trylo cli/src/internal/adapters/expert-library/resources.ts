import type { SkillCatalogPort } from "../../ports/skills.js";
import type { ToolCallRequest, ToolOutcome } from "../../ports/tools.js";
import type { ExpertResourcePort, ExpertResources } from "../../subagent/experts/build.js";
import { ExpertLibraryError, type ExpertSource } from "../../subagent/experts/contracts.js";
import { runtimeToolId } from "../../tooling/library/index.js";
import { discoverExpertSources, expertDocumentText } from "./resource-discovery.js";
import { expertWebResponse, expertResourceFailure, isExpertWebUri, requireExpertResourceActive } from "./resource-response.js";

export type ExpertResourceOptions = {
  /** Must use the host's normal tool catalog, sandbox and PermissionPort path.
   * No raw ToolPort is accepted here: source collection must not bypass it. */
  readonly executeAuthorized: (call: ToolCallRequest, signal: AbortSignal) => Promise<ToolOutcome>;
  readonly availableToolNames: () => readonly string[];
  readonly skills?: SkillCatalogPort;
  /** Known publisher domains supplied by the host/user; unverified search hits remain community sources. */
  readonly officialDomains?: readonly string[];
  readonly maxFetches?: number;
};

/** Uses existing web tools and skill catalog, without owning a tool library. */
export function createToolExpertResources(options: ExpertResourceOptions): ExpertResourcePort {
  const maxFetches = options.maxFetches ?? 3;
  if (!Number.isSafeInteger(maxFetches) || maxFetches < 1 || maxFetches > 5) {
    throw new ExpertLibraryError("invalid_input", "Expert resource fetch budget must be between one and five pages");
  }

  return { async collect(input): Promise<ExpertResources> {
    checkCancelled(input.signal);
    const selectedSkills = input.request.userEdits.role?.skills ?? input.previous?.role.skills ?? [];
    const sources = installedSources(options.skills, input.request.instruction,
      selectedSkills);
    const catalog = options.availableToolNames();
    const candidates = new Map<string, string>();

    for (const uri of input.request.instruction.match(/https?:\/\/[^\s<>"'）)]+/g) ?? []) {
      if (isExpertWebUri(uri)) candidates.set(uri, uri);
    }

    // Search and fetch are finite scheduled construction work, never an
    // execution-loop reflection or an autonomous budget-owning optimizer.
    if (catalog.includes("web_search")) {
      const search = await options.executeAuthorized({ name: "web_search",
        toolCallId: `expert-${input.request.requestId}-r${input.request.revision}-search`,
        arguments: { query: `${input.request.instruction.slice(0, 1800)} official documentation specialist workflow open source resources` } }, input.signal);

      requireExpertResourceActive(search, input.signal);

      if (search.outcome === "result" && Array.isArray(search.value.sources)) {
        for (const item of search.value.sources) {
          if (item !== null && typeof item === "object" && !Array.isArray(item)
            && typeof item.url === "string" && isExpertWebUri(item.url) && typeof item.title === "string") candidates.set(item.url, item.title);
        }
      } else if (search.outcome !== "result" && sources.length === 0 && candidates.size === 0) {
        throw expertResourceFailure("Specialist web search", search);
      }
    }

    if (!catalog.includes("web_search") && catalog.includes("web_fetch") && candidates.size === 0 && sources.length === 0) {
      const discovered = await discoverExpertSources({ executeAuthorized: options.executeAuthorized, instruction: input.request.instruction,
        callId: `expert-${input.request.requestId}-r${input.request.revision}-index`, maxResults: maxFetches, signal: input.signal });
      for (const candidate of discovered) candidates.set(candidate.uri, candidate.title);
    }

    if (catalog.includes("web_fetch")) {
      let fetchIndex = 0;
      for (const [uri, title] of [...candidates].slice(0, maxFetches)) {
        const fetched = await options.executeAuthorized({ name: "web_fetch",
          toolCallId: `expert-${input.request.requestId}-r${input.request.revision}-fetch-${fetchIndex++}`,
          arguments: { url: uri } }, input.signal);

        requireExpertResourceActive(fetched, input.signal);

        if (fetched.outcome !== "result") {
          // Other independent sources may remain usable; a refused fetch is
          // never inserted as evidence or described as a successful source.
          if (sources.length === 0 && candidates.size === 1) throw expertResourceFailure("Specialist source fetch", fetched);
          continue;
        }

        const response = expertWebResponse(fetched);
        if (response === undefined) continue;

        const actualUri = response.url, text = expertDocumentText(actualUri, response.text);
        if (!text?.trim()) continue;

        const hostname = new URL(actualUri).hostname.toLowerCase();
        const official = hostname !== "api.github.com" && (options.officialDomains ?? []).some(domain => hostname === domain.toLowerCase()
          || hostname.endsWith(`.${domain.toLowerCase()}`));

        sources.push({ kind: official ? "official" : "community", title: title.slice(0, 500), uri: actualUri,
          excerpt: text.slice(0, 5000) });
      }
    }

    checkCancelled(input.signal);

    return { sources: [...new Map(sources.map(source => [source.uri, source])).values()],
      installedSkills: (options.skills?.list() ?? []).filter(skill => !skill.forkExecution
        && (!skill.disableModelInvocation || selectedSkills.includes(skill.name))).map(skill => ({ name: skill.name, description: skill.description })),
      toolNames: [...catalog], toolReferences: catalog.map(runtimeName => ({ ref: runtimeToolId(runtimeName), runtimeName })) };
  } };
}

function installedSources(catalog: SkillCatalogPort | undefined, instruction: string, selected: readonly string[]): ExpertSource[] {
  if (!catalog) return [];

  const query = instruction.toLowerCase();
  const tokens = query.split(/[^\p{L}\p{N}_-]+/u).filter(token => token.length > 2);
  const candidates = catalog.list().filter(skill => selected.includes(skill.name)
    || (!skill.disableModelInvocation && (query.includes(skill.name.toLowerCase())
      || tokens.some(token => skill.description.toLowerCase().includes(token))))).slice(0, 4);
  const sources: ExpertSource[] = [];

  for (const descriptor of candidates) {
    const loaded = catalog.load(descriptor.name, undefined);
    if (loaded.kind === "loaded" && !loaded.skill.descriptor.forkExecution) sources.push({ kind: "installed_skill",
      title: descriptor.name, uri: `skill:${descriptor.name}@${descriptor.contentHash}`, excerpt: loaded.skill.content.slice(0, 5000) });
  }

  return sources;
}

function checkCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new ExpertLibraryError("cancelled", "Expert resource collection was cancelled");
}
