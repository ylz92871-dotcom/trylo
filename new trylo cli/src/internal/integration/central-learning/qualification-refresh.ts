import { createBoardReader } from "../../adapters/learning-store/file-event-store.js";
import { createRewardV2BoardPort } from "../reward/v2-board-port.js";
import { readCentralPursuitObservations } from "../learning-allocation/pursuit-observations.js";
import { buildCentralPursuitQualificationRevisionDraft } from "../learning-allocation/pursuit-revision.js";
import { refreshFrozenStageObservation } from "./stage-evidence.js";
import type { CentralLearningExecutionPort } from "./contracts.js";

/** One read-only owner review per pending original stage at an existing task or
 * explicit decision boundary. No worker retry, model call or polling loop. */
export async function refreshCentralQualifications(options: { readonly boardRoot: string; readonly scope: string;
  readonly ports: readonly CentralLearningExecutionPort[]; readonly enabled: () => boolean; readonly issueId?: string }, signal: AbortSignal) {
  const results: { readonly unitId: string; readonly status: string; readonly reason?: string }[] = [];

  if (!options.enabled() || signal.aborted) return results;

  const reader = createBoardReader(options.boardRoot), loaded = await reader.load();
  if (!loaded.ok) throw new Error(loaded.reason);

  const history = readCentralPursuitObservations(loaded.state, options.scope);
  if (history.status !== "ready") throw new Error(history.reason);

  for (const head of history.observations.filter(row => row.outcome === "pending")) {
    if (!options.enabled() || signal.aborted) break;

    const grant = loaded.state.centralLearningGrants?.find(row => row.grantId === head.grantId && row.scope === options.scope);
    if (grant === undefined || options.issueId !== undefined && grant.issueId !== options.issueId) continue;

    const port = options.ports.find(row => row.domain === (grant.domain ?? "collaboration"));
    if (port === undefined) continue;

    const reviewed = await refreshFrozenStageObservation({ boardRoot: options.boardRoot, scope: options.scope,
      grantId: head.grantId, stageRef: head.stageRef, port }, signal);
    if (reviewed.status !== "refreshed") {
      results.push({ unitId: head.unitId, status: reviewed.status,
        ...("reason" in reviewed ? { reason: reviewed.reason } : {}) });
      continue;
    }

    const evidenceRefs = [...new Set([...reviewed.observed.resultRefs, ...reviewed.observed.sourceRefs])].slice(0, 32);
    if (evidenceRefs.length === 0 || reviewed.observed.outcome === "qualified" && reviewed.observed.resultRefs.length === 0) {
      results.push({ unitId: head.unitId, status: "unknown", reason: "central_original_criterion_receipt_required" });
      continue;
    }

    const current = await reader.load();
    if (!current.ok) throw new Error(current.reason);

    const revision = buildCentralPursuitQualificationRevisionDraft({ board: current.state, scope: options.scope,
      unitId: head.unitId, expectedHeadFactId: reviewed.expectedHeadRef, review: { kind: "original_criterion_review",
        definitionRef: reviewed.frozen.candidate.objective.definitionRef, frameRef: reviewed.frozen.input.stageRef,
        origin: "domain_receipt", outcome: reviewed.observed.outcome, sourceRef: evidenceRefs[0]!, evidenceRefs } });
    if (revision.status !== "ready") {
      results.push({ unitId: head.unitId, status: revision.status, reason: revision.reason });
      continue;
    }

    if (!options.enabled() || signal.aborted) break;

    const written = await createRewardV2BoardPort(options.boardRoot, options.enabled).append(current.state.sequence, revision.draft);

    results.push({ unitId: head.unitId, status: written.status });
  }

  return results;
}
