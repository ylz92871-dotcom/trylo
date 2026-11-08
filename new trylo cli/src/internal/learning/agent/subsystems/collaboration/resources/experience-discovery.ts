import type { LearningIssue } from "../../../../control/coordination-contract.js";
import { isTeamLearningIssueReport } from "../../../../control/coordination-contract.js";
import type { CollaborationExperienceStore, ExperienceQueryItem, PrepareExperienceInput } from "../experience/index.js";
import { EXPERIENCE_QUERY_MAX_ITEMS } from "../experience/index.js";

const OWNER_LIMIT = 12;

export type ExperienceDiscoveryOwner = { readonly ref: string; readonly input: PrepareExperienceInput };

type OwnerView = { readonly ownerRef: string; readonly ok: true; readonly items: readonly ExperienceQueryItem[]; readonly omittedItemCount: number }
  | { readonly ownerRef: string; readonly ok: false; readonly reason: string };

export type CollaborationExperienceDiscovery = {
  readonly mode: "discovery_only"; readonly ownerViews: readonly OwnerView[]; readonly omittedOwnerCount: number;
  readonly sourceRefs: readonly string[]; readonly note: string;
};

/** Related report owners get a slot first; one large PA catalogue cannot hide every specialist. */
export async function discoverCollaborationExperience(store: Pick<CollaborationExperienceStore, "inspectExperience">,
  input: { readonly issue: LearningIssue; readonly owners: readonly ExperienceDiscoveryOwner[]; readonly query: string;
    readonly signal: AbortSignal }): Promise<CollaborationExperienceDiscovery> {
  const related = [...new Set([...input.issue.reports].reverse().filter(isTeamLearningIssueReport)
    .map(report => `member:${report.source.memberId}`))];
  const priority = (owner: ExperienceDiscoveryOwner) => {
    const index = related.indexOf(owner.ref);
    return index >= 0 ? index : owner.ref === "personal_agent" ? related.length : related.length + 1;
  };
  const owners = input.owners.slice().sort((left, right) => priority(left) - priority(right)).slice(0, OWNER_LIMIT);
  const inspected = [];

  for (const owner of owners) {
    if (input.signal.aborted) break;
    inspected.push({ owner, result: await store.inspectExperience(owner.input, { text: input.query, limit: EXPERIENCE_QUERY_MAX_ITEMS }) });
  }

  const selected = inspected.map((): ExperienceQueryItem[] => []);
  let count = 0;

  for (let round = 0; round < EXPERIENCE_QUERY_MAX_ITEMS && count < EXPERIENCE_QUERY_MAX_ITEMS; round++) {
    for (let index = 0; index < inspected.length && count < EXPERIENCE_QUERY_MAX_ITEMS; index++) {
      const result = inspected[index]!.result, item = result.ok ? result.items[round] : undefined;
      if (item !== undefined) {
        selected[index]!.push(item);
        count++;
      }
    }
  }

  const ownerViews: OwnerView[] = inspected.map(({ owner, result }, index) => result.ok
    ? { ownerRef: owner.ref, ok: true, items: selected[index]!, omittedItemCount: result.omittedCount + result.items.length - selected[index]!.length }
    : { ownerRef: owner.ref, ok: false, reason: result.reason });

  return { mode: "discovery_only", ownerViews, omittedOwnerCount: input.owners.length - inspected.length,
    sourceRefs: [...new Set(selected.flatMap(items => items.map(item => item.versionId)))],
    note: "This is a bounded discovery window. Report-related owners are inspected first, then PA and other supplied exact owners; items share slots round by round. Omitted owners/items are not evidence that their experience is absent. Discovery never loads or adopts a practice." };
}
