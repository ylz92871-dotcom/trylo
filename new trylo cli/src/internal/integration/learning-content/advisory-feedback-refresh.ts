import type { SessionPort } from "../../ports/session.js";
import { createBoardReader } from "../../adapters/learning-store/file-event-store.js";
import { canonicalJson } from "../../learning/control/hash.js";
import { organizationFeedbackKey } from "../../learning/central/organization/retrieval.js";
import { createCentralOrganizationService } from "../central-learning/organization-service.js";
import { consumeOrganizationCasStale, createOrganizationCasRetryBudget } from "../central-learning/organization-cas.js";
import { projectAdvisorySessionFeedbackWithSources } from "./sources/advisory-feedback.js";
import { sessionContentRecordRef } from "./sources/session-decode.js";

export type AdvisoryFeedbackRefresh = { readonly status: "saved"; readonly sourceRefs: readonly string[]; readonly intentRefs: readonly string[] }
  | { readonly status: "disabled" | "waiting" | "rejected"; readonly reason: string; readonly sourceRefs: readonly string[] };

/** Actual PA/session facts return to the original organization writer. This
 * observer creates no learning claim, quality verdict, model request or budget. */
export function createAdvisoryFeedbackRefresh(options: { readonly boardRoot: string; readonly scope: string;
  readonly sessionId: string; readonly session: Pick<SessionPort, "readRecords">; readonly enabled: () => boolean;
  readonly secrets?: readonly string[] }) {
  const organization = createCentralOrganizationService(options);
  return async (signal: AbortSignal): Promise<AdvisoryFeedbackRefresh> => {
    const saved: string[] = [];
    try {
    if (!options.enabled() || signal.aborted) return { status: "disabled", reason: "advisory_feedback_inactive", sourceRefs: [] };

    const journal = await options.session.readRecords();
    if (!journal.ok || journal.view.tornTail) return { status: "rejected", reason: "advisory_feedback_session_unconfirmed", sourceRefs: [] };

    const sourceSequences = new Map(journal.view.records.map(record => [sessionContentRecordRef(options.sessionId, record.sequence), record.sequence]));
    const loaded = await createBoardReader(options.boardRoot).load();
    if (!loaded.ok) return { status: "rejected", reason: loaded.reason, sourceRefs: [] };

    const proposed = projectAdvisorySessionFeedbackWithSources({ board: loaded.state, scope: options.scope, sessionId: options.sessionId,
      records: journal.view.records, ...(options.secrets === undefined ? {} : { secrets: options.secrets }) });
    const budget = createOrganizationCasRetryBudget(), intents = new Set<string>();

    for (const candidate of proposed.feedback) {
      for (;;) {
        if (!options.enabled() || signal.aborted) return { status: "disabled", reason: "advisory_feedback_inactive", sourceRefs: saved };

        const current = await organization.read();
        if (current.status !== "ready") return { status: "rejected", reason: current.status === "rejected" ? current.reason : "collect_disabled", sourceRefs: saved };

        const decision = current.projection.decisions.find(row => row.value.decisionRef === candidate.decisionRef);
        if (decision === undefined) return { status: "waiting", reason: "advisory_original_decision_unavailable", sourceRefs: saved };

        const previous = current.projection.feedback.find(row => organizationFeedbackKey(row.value) === organizationFeedbackKey({ ...candidate, supersedes: null }));
        if (previous !== undefined) {
          const { supersedes: _supersedes, ...sameSource } = previous.value;

          if (canonicalJson(sameSource) === canonicalJson(candidate)) break;

          if (previous.value.result.kind === "adoption" && previous.value.result.state === "used"
            && candidate.result.kind === "adoption" && candidate.result.state === "not_observed") break;

          // An older fixed session read cannot supersede an already observed
          // later report/user/task source from that same original journal.
          if (previous.value.sourceRefs.some(ref => /^session-content:[a-f0-9]{64}$/.test(ref)
            && !sourceSequences.has(ref) && !candidate.sourceRefs.includes(ref))) break;

          if (sessionSourceSequence(previous.value.sourceRefs, sourceSequences) > sessionSourceSequence(candidate.sourceRefs, sourceSequences)) break;
        }

        if (!options.enabled() || signal.aborted) return { status: "disabled", reason: "advisory_feedback_inactive", sourceRefs: saved };

        const result = await organization.observe({ ...candidate, supersedes: previous?.factId ?? null }, current.revision);
        if (result.status === "stale") {
          consumeOrganizationCasStale(budget, "publication");
          continue;
        }

        if (result.status !== "saved") return { status: "rejected", reason: result.status === "rejected" ? result.reason : "collect_disabled", sourceRefs: saved };

        if (!result.idempotent) {
          saved.push(result.factId);
          const source = proposed.sourceUnits.find(unit => unit.unitRef === candidate.unitRef);
          if (source !== undefined) intents.add(source.intentId);
        }

        break;
      }
    }

    return { status: "saved", sourceRefs: saved, intentRefs: [...intents] };
    } catch (error) {
      return { status: "rejected", reason: error instanceof Error ? error.message : "advisory_feedback_unconfirmed", sourceRefs: saved };
    }
  };
}

function sessionSourceSequence(refs: readonly string[], sequences: ReadonlyMap<string, number>): number {
  return Math.max(-1, ...refs.flatMap(ref => sequences.has(ref) ? [sequences.get(ref)!] : []));
}
