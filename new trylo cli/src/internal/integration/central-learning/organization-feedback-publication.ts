import type { OrganizationFeedback, OrganizationStored } from "../../learning/central/organization/contracts.js";
import { buildOrganizationRecord } from "../../learning/central/organization/records.js";
import { organizationFeedbackKey } from "../../learning/central/organization/retrieval.js";
import { canonicalJson } from "../../learning/control/hash.js";
import type { createCentralOrganizationService } from "./organization-service.js";
import type { createOrganizationFeedbackSnapshotReader } from "./organization-feedback-snapshot.js";
import type { organizationFeedbackQueue } from "./organization-feedback-queue.js";
import { publishOrganizationWithCas, type OrganizationCasRetryBudget } from "./organization-cas.js";

export const organizationFeedbackSourceValue = (feedback: OrganizationFeedback) => {
  const { supersedes: _revision, ...value } = feedback;
  return canonicalJson(value);
};

type FeedbackSnapshot = Awaited<ReturnType<ReturnType<typeof createOrganizationFeedbackSnapshotReader>>>;

type FeedbackEntry = ReturnType<typeof organizationFeedbackQueue>["entries"][number];

/** Rebase a fixed source unit only after its original body, relationship and
 * semantic ancestor survive a fresh original-prefix projection. */
export async function publishOrganizationFeedbackWithCas(input: {
  readonly scope: string; readonly entry: FeedbackEntry; readonly previous: OrganizationStored<OrganizationFeedback> | undefined;
  readonly expected: number; readonly budget: OrganizationCasRetryBudget; readonly signal: AbortSignal; readonly enabled: () => boolean;
  readonly entries: readonly FeedbackEntry[];
  readonly heads: ReadonlyMap<string, OrganizationStored<OrganizationFeedback>>;
  readonly snapshot: () => Promise<FeedbackSnapshot>;
  readonly service: Pick<ReturnType<typeof createCentralOrganizationService>, "observe">;
}) {
  const candidate = input.entry.feedback, key = organizationFeedbackKey(candidate);
  const value = { ...candidate, supersedes: input.previous?.factId ?? null };
  const draftId = buildOrganizationRecord(input.scope, value).id;
  let recheck = false, verifiedHead: OrganizationStored<OrganizationFeedback> | undefined;
  const read = async () => {
    if (!recheck) return { status: "ready" as const, revision: input.expected };

    const current = await input.snapshot();
    if (current.status !== "ready") return current;

    const effective = new Map(current.queue.entries.map(entry => [organizationFeedbackKey(entry.feedback), entry]));
    const heads = new Map(current.view.feedback.map(row => [organizationFeedbackKey(row.value), row]));

    // A fresh revision may only accompany the original whole output set. This
    // includes earlier skipped or committed entries, not just the pending key.
    for (const original of input.entries) {
      const originalKey = organizationFeedbackKey(original.feedback), source = effective.get(originalKey);
      if (source === undefined || organizationFeedbackSourceValue(source.feedback) !== organizationFeedbackSourceValue(original.feedback)
        || source.relation !== original.relation) {
        return { status: "rejected" as const, reason: "organization_feedback_source_changed" };
      }

      const actualHead = heads.get(originalKey)?.factId ?? null, expectedHead = input.heads.get(originalKey)?.factId ?? null;
      if (actualHead !== expectedHead && !(originalKey === key && actualHead === draftId)) {
        return { status: "rejected" as const, reason: "organization_feedback_revision_conflict" };
      }
    }

    verifiedHead = heads.get(key);

    return { status: "ready" as const, revision: current.revision };
  };
  const saved = await publishOrganizationWithCas({ record: value, phase: "recall", budget: input.budget, read,

    publish: async (fixed, revision) => {
      const result = await input.service.observe(fixed, revision);
      if (result.status === "stale") recheck = true;
      return result;
    }, enabled: input.enabled, signal: input.signal });
  if (saved.status !== "saved") return saved;

  if (!saved.idempotent) return { ...saved, row: { factId: saved.factId, sequence: saved.revision, value } };

  // A known commit is not an unwritten failure. Verify it with reads only, and
  // retain its actual original sequence rather than the current global revision.
  recheck = true;
  const checked = await read();
  if (checked.status !== "ready") return checked;

  if (verifiedHead?.factId !== saved.factId) return { status: "rejected" as const, reason: "organization_feedback_revision_conflict" };

  return { ...saved, revision: checked.revision, row: verifiedHead };
}
