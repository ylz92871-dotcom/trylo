import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import type { CentralRuntimeMaterial } from "../../learning/central/runtime/contracts.js";
import { organizationFeedbackKey } from "../../learning/central/organization/retrieval.js";
import { createCentralOrganizationService, type CentralOrganizationOptions } from "./organization-service.js";
import { projectOrganizationDomainFeedback } from "./organization-feedback-sources.js";
import type { OrganizationFeedbackSelection } from "./organization-feedback-queue.js";
import { organizationFeedbackViews } from "./organization-feedback-views.js";
import { createOriginalOrganizationDecisionMaterial } from "./organization-decision-material.js";
import { createOrganizationFeedbackSnapshotReader } from "./organization-feedback-snapshot.js";
import { createOrganizationCasRetryBudget } from "./organization-cas.js";
import { organizationFeedbackSourceValue, publishOrganizationFeedbackWithCas } from "./organization-feedback-publication.js";

export type { OrganizationFeedbackSelection } from "./organization-feedback-queue.js";

export interface OrganizationFeedbackRefreshOptions extends CentralOrganizationOptions {
  readonly workspaceId: string;
  readonly service?: ReturnType<typeof createCentralOrganizationService>;
  /** Original projection replacement for source-owner contract/fault tests. Production uses the public five-domain bridge. */
  readonly project?: typeof projectOrganizationDomainFeedback;
}

/** Demand-directed read at actual domain references, including late feedback with
 * no prior organization knowledge. No polling, model call or notification write. */
export function createCentralOrganizationFeedbackRefresh(options: OrganizationFeedbackRefreshOptions) {
  const service = options.service ?? createCentralOrganizationService(options);
  const project = options.project ?? projectOrganizationDomainFeedback;
  const readSnapshot = createOrganizationFeedbackSnapshotReader(options, service, project);

  return {
    async refresh(input: OrganizationFeedbackSelection, signal: AbortSignal) {
      if (!options.enabled()) return { status: "disabled" as const };

      if (signal.aborted) return { status: "rejected" as const, reason: "organization_feedback_cancelled" };

      // One contention budget covers every entry. Normal
      // successful entries do not consume retries or impose a semantic batch cap.
      const budget = createOrganizationCasRetryBudget();
      const own = await readSnapshot(input, signal);
      if (own.status !== "ready") return own;

      budget.observedRevision = own.revision;
      const { view, queue } = own;
      const heads = new Map(view.feedback.map(row => [organizationFeedbackKey(row.value), row]));
      let expected = own.revision;
      const changed = new Set<string>();

      // Eight is a mechanical write batch, not a lifetime decision cutoff or a
      // request for another paid thought. Existing heads recover partial writes.
      for (let offset = 0; offset < queue.entries.length; offset += 8) {
        for (const entry of queue.entries.slice(offset, offset + 8)) {
          const candidate = entry.feedback;

          if (!options.enabled()) return { status: "disabled" as const };

          if (signal.aborted) return { status: "rejected" as const, reason: "organization_feedback_cancelled" };

          const key = organizationFeedbackKey(candidate), previous = heads.get(key);
          if (previous !== undefined && organizationFeedbackSourceValue(previous.value) === organizationFeedbackSourceValue(candidate)) continue;

          const saved = await publishOrganizationFeedbackWithCas({ scope: options.scope, entry, entries: queue.entries, heads,
            previous, expected, budget, signal,
            enabled: options.enabled, service, snapshot: () => readSnapshot(input, signal) });
          if (saved.status !== "saved") return saved;

          expected = saved.revision;
          heads.set(key, saved.row);
          changed.add(key);
        }
      }

      const bindings = queue.entries.map(entry => ({ row: heads.get(organizationFeedbackKey(entry.feedback))!, relation: entry.relation }))
        .sort((a, b) => Number(changed.has(organizationFeedbackKey(b.row.value))) - Number(changed.has(organizationFeedbackKey(a.row.value))));
      const relevant = new Set(bindings.map(binding => binding.row.value.decisionRef));
      const costUnits = new Map<string, Set<string>>();

      for (const row of heads.values()) {
        if (row.value.result.kind !== "cost") continue;

        const owners = costUnits.get(row.value.unitRef) ?? new Set<string>();

        owners.add(row.value.decisionRef);
        costUnits.set(row.value.unitRef, owners);

        if (row.value.unitRef.startsWith("original-root-cost:")) {
          for (const decision of view.decisions) {
            const refs = queue.safeReferences.get(decision.value.decisionRef) ?? [];
            if (row.value.sourceRefs.every(ref => refs.includes(ref))) owners.add(decision.value.decisionRef);
          }
        }
      }

      const sharedCosts = [...costUnits].filter(([, owners]) => owners.size > 1 && [...owners].some(ref => relevant.has(ref)))
        .map(([unitRef, owners]) => ({ unitRef, decisionRefs: [...owners], allocatedCostForEachDecision: "unknown" }));
      const materials: CentralRuntimeMaterial[] = [
        ...organizationFeedbackViews(options.scope, bindings),
        ...queue.decisions.filter(row => relevant.has(row.value.decisionRef)).map(createOriginalOrganizationDecisionMaterial),
        ...queue.background,
        ...(sharedCosts.length === 0 ? [] : [{ ref: `organization-shared-cost:${contentHashOf(sharedCosts)}`, kind: "organization" as const,
          text: canonicalJson({ role: "shared_original_cost_units_not_additive_decision_spend", units: sharedCosts,
            instruction: "The same original unitRef across decisions is one reported cost unit. Count it once across decisions; its allocated share for each decision is unknown. It is not separate spend or economic benefit for every decision." }), sourceRefs: [] }]),
      ];

      return { status: "ready" as const, revision: expected, materials, sourceRefs: queue.sourceRefs, omittedDecisions: 0 };
    },
  };
}
