import { createBoardReader } from "../../adapters/learning-store/file-event-store.js";
import { readCentralRuntimeCompletedIndex } from "../../learning/central/runtime/records.js";
import { readOrganizationRecords } from "../../learning/central/organization/records.js";
import { isOrganizationRecordContentSafe, type CentralOrganizationOptions, type createCentralOrganizationService } from "./organization-service.js";
import { projectOrganizationDomainFeedback } from "./organization-feedback-sources.js";
import { buildOrganizationDecisionRelationIndex } from "./organization-feedback-relations.js";
import { organizationFeedbackQueue, type OrganizationFeedbackSelection } from "./organization-feedback-queue.js";
import { readOrganizationProductionEvidence } from "./organization-feedback-production-evidence.js";

class RefreshStopped extends Error {}

/** Source bodies, relationships and organization heads all derive from the same
 * original Board load, under the original service's shared export policy. */
export function createOrganizationFeedbackSnapshotReader(options: CentralOrganizationOptions & { readonly workspaceId: string },
  service: Pick<ReturnType<typeof createCentralOrganizationService>, "read">, project = projectOrganizationDomainFeedback) {
  return async (input: OrganizationFeedbackSelection, signal: AbortSignal) => {
    const stopped = () => !options.enabled() ? { status: "disabled" as const }
      : signal.aborted ? { status: "rejected" as const, reason: "organization_feedback_cancelled" } : undefined;
    const before = stopped();
    if (before !== undefined) return before;

    // Retain the original reader's disabled/rejected boundary; its separate
    // projection never supplies the following source snapshot's heads.
    const own = await service.read();
    const after = stopped();
    if (after !== undefined) return after;

    if (own.status !== "ready") return own;

    const loaded = await createBoardReader(options.boardRoot).load();
    if (!loaded.ok) return { status: "rejected" as const, reason: loaded.reason };

    const check = () => {
      if (!options.enabled()) throw new RefreshStopped("collect_disabled");
      if (signal.aborted) throw new RefreshStopped("organization_feedback_cancelled");
    };

    try {
      check();
      const view = readOrganizationRecords(loaded.state.rewardV2Facts ?? [], options.scope, loaded.state.sequence);
      if (![...view.decisions, ...view.feedbackHistory, ...view.knowledge]
        .every(row => isOrganizationRecordContentSafe(row.value, options, options.secrets ?? []))) {
        return { status: "rejected" as const, reason: "organization_sensitive_content" };
      }

      const completed = readCentralRuntimeCompletedIndex(loaded.state.rewardV2Facts ?? [], options.scope, loaded.state.sequence);
      const wantedReferences = new Set([...(input.decisionRefs ?? []), ...(input.issueRefs ?? []), ...(input.sourceRefs ?? [])]);

      for (const decision of view.decisions) if (wantedReferences.has(decision.value.decisionRef)) {
        for (const ref of decision.value.stageRefs) wantedReferences.add(ref);
      }

      const productions = await readOrganizationProductionEvidence(loaded.state, { boardRoot: options.boardRoot,
        scope: options.scope, workspaceId: options.workspaceId, check, wantedReferences }, completed);
      const queue = organizationFeedbackQueue({ board: loaded.state, view, selection: input,
        workspaceId: options.workspaceId,
        relations: buildOrganizationDecisionRelationIndex(loaded.state, view, { completed, productions }), project, check,
        ...(options.secrets === undefined ? {} : { secrets: options.secrets }) });

      check();

      return { status: "ready" as const, revision: loaded.state.sequence, view, queue };
    } catch (error) {
      if (error instanceof RefreshStopped) return error.message === "collect_disabled" ? { status: "disabled" as const }
        : { status: "rejected" as const, reason: error.message };
      throw error;
    }
  };
}
