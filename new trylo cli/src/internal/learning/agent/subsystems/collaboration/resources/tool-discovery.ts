import type { LearningIssue, TeamLearningIssueSource } from "../../../../control/coordination-contract.js";
import { isTeamLearningIssueReport } from "../../../../control/coordination-contract.js";
import type { LibraryResult, ToolLibrary, ToolLibraryCatalog } from "../../../../../tooling/library/index.js";
import { COLLABORATION_RESOURCE_LIMITS } from "../../../../../protocol/collaboration-resource.js";

const MEMBER_LIMIT = 4, CATALOG_LIMIT = 12, MEMBER_ITEM_LIMIT = 6;

type CatalogView = { readonly result: LibraryResult<ToolLibraryCatalog>; readonly truncated: boolean };

type MemberView = CatalogView & { readonly binding: "current_team"; readonly memberId: string; readonly reportSource: TeamLearningIssueSource }
  | { readonly binding: "unbound_report"; readonly memberId: string; readonly reportSource: TeamLearningIssueSource;
    readonly reason: "current_team_unknown" | "historical_team" };

export type CollaborationToolDiscovery = {
  readonly mode: "discovery_only"; readonly queriedMemberId: "personal_agent";
  readonly catalog: CatalogView; readonly memberViews: readonly MemberView[];
  readonly omittedMemberCount: number; readonly sourceRefs: readonly string[]; readonly note: string;
};

/** Read existing catalogues only. The library owns configuration, mount state and the frozen member ceiling. */
export async function discoverCollaborationTools(library: Pick<ToolLibrary, "query">,
  input: { readonly issue: LearningIssue; readonly query: string; readonly signal: AbortSignal;
    readonly currentTeamRunId?: string | undefined }): Promise<CollaborationToolDiscovery> {
  const sources = new Map<string, TeamLearningIssueSource>();

  for (const report of [...input.issue.reports].reverse()) {
    if (isTeamLearningIssueReport(report) && report.source.memberId !== "personal_agent") {
      const key = JSON.stringify([report.source.teamRunId, report.source.memberId]);
      if (!sources.has(key)) sources.set(key, report.source);
    }
  }

  const references = new Set<string>();
  const query = async (memberId: string, limit: number): Promise<CatalogView> => {
    const result = input.signal.aborted ? { ok: false as const, code: "cancelled", message: "Resource discovery cancelled" }
      : await library.query({ memberId, scope: input.issue.scope }, { text: input.query, limit });
    if (!result.ok) return { result, truncated: false };

    // Resource receipts admit 32 unique references. Never return unreferenceable extra content as if it were evidence.
    const items = result.value.items.filter(item => {
      if (!references.has(item.id) && references.size >= COLLABORATION_RESOURCE_LIMITS.maxResultRefs) return false;
      references.add(item.id);
      return true;
    });

    return { result: { ok: true, value: { ...result.value, items } }, truncated: result.value.total > items.length };
  };
  const catalog = await query("personal_agent", CATALOG_LIMIT), memberViews: MemberView[] = [];
  const ordered = [...sources.values()].sort((left, right) => Number(right.teamRunId === input.currentTeamRunId) - Number(left.teamRunId === input.currentTeamRunId));

  for (const source of ordered.slice(0, MEMBER_LIMIT)) {
    if (input.signal.aborted) break;
    if (input.currentTeamRunId === undefined || source.teamRunId !== input.currentTeamRunId) {
      memberViews.push({ binding: "unbound_report", memberId: source.memberId, reportSource: source,
        reason: input.currentTeamRunId === undefined ? "current_team_unknown" : "historical_team" });
    } else memberViews.push({ binding: "current_team", memberId: source.memberId, reportSource: source, ...await query(source.memberId, MEMBER_ITEM_LIMIT) });
  }

  return { mode: "discovery_only", queriedMemberId: "personal_agent", catalog, memberViews,
    omittedMemberCount: sources.size - memberViews.length, sourceRefs: [...references],
    note: "Member views are queried only when their report teamRunId matches the host's current frozen team. Unknown/historical teams remain unbound; matching member text alone cannot bind them. The public library rechecks configuration and task ceilings. Catalog availability/configurability is not permission to execute; each actual call still requires the original Permission and Sandbox admission." };
}
