import type { SessionPort } from "../../ports/session.js";
import type { BoardStore, StoreLoadResult } from "../../learning/control/store-port.js";
import { rewardRecordsOf } from "../../learning/control/reward-records.js";
import { estimateReportedFeedback } from "../../learning/reward/explanation/reported-estimate.js";
import type { ReportedFeedbackEstimate } from "../../learning/reward/explanation/reported-estimate.js";
import { MAX_FEEDBACK_UNITS } from "../../learning/reward/explanation/reveal-chains.js";
import { explainLegacyFeedback, explainLatestLegacyRevision, pendingReportQuestions } from "../../learning/reward/explanation/explanation-policy.js";
import { decodeFeedbackSource, type FeedbackSourceBinding, type FeedbackSourceSnapshot } from "./explanation-source.js";

type LegacyUnits = ReturnType<typeof explainLegacyFeedback>;

type Revision = ReturnType<typeof explainLatestLegacyRevision>;

type Question = ReturnType<typeof pendingReportQuestions>[number];

export type FeedbackExplanationRead = {
  readonly schemaVersion: 1;
  readonly ok: true;
  readonly source: Omit<FeedbackSourceSnapshot, "bindings">;
  readonly bindings: readonly FeedbackSourceBinding[];
  readonly reported: ReportedFeedbackEstimate;
  readonly questions: readonly Question[];
  readonly legacy: { readonly status: "available"; readonly revision: number; readonly units: LegacyUnits }
    | { readonly status: "unavailable"; readonly reason: string };
  readonly legacyRevision: { readonly status: "available"; readonly value: Revision }
    | { readonly status: "unavailable"; readonly reason: string };
} | { readonly schemaVersion: 1; readonly ok: false; readonly reason: string; readonly atSequence?: number };

export interface FeedbackExplanationInput {
  readonly enabled: () => boolean;
  readonly sessionId: string;
  readonly through?: number;
  readonly delta: number;
  readonly source: Pick<SessionPort, "readRecords">;
  readonly board: Pick<BoardStore, "load">;
}

const failure = (reason: string): FeedbackExplanationRead => ({ schemaVersion: 1, ok: false, reason });

async function loadBoard(board: Pick<BoardStore, "load">): Promise<StoreLoadResult> {
  try { return await board.load(); }
  catch { return { ok: false, reason: "board_unavailable", detail: "feedback explanation could not read the Board" }; }
}

/** One source snapshot and one Board snapshot, explicitly separate knowledge positions. Never writes. */
export async function readFeedbackExplanation(input: FeedbackExplanationInput): Promise<FeedbackExplanationRead> {
  if (!input.enabled()) return failure("feedback_read_disabled");

  if (!Number.isFinite(input.delta) || input.delta <= 0 || input.delta >= 1) return failure("invalid_feedback_delta");

  let view;

  try { view = await input.source.readRecords(); }
  catch { return failure("source_unavailable"); }

  if (!input.enabled()) return failure("feedback_read_disabled");

  if (!view.ok) return failure(view.code);

  const decoded = decodeFeedbackSource(view.view, input.sessionId, input.through);
  if (!decoded.ok) return { schemaVersion: 1, ...decoded };

  const { bindings, ...source } = decoded.source;

  if (bindings.length > MAX_FEEDBACK_UNITS) return failure("feedback_population_capacity");

  const reported = estimateReportedFeedback(bindings.map(row => row.unit), input.delta);
  const sourceQuestions = pendingReportQuestions(bindings);
  const loaded = await loadBoard(input.board);

  if (!input.enabled()) return failure("feedback_read_disabled");

  if (!loaded.ok) return { schemaVersion: 1, ok: true, source, bindings, reported, questions: sourceQuestions,
    legacy: { status: "unavailable", reason: loaded.reason }, legacyRevision: { status: "unavailable", reason: loaded.reason } };

  const records = rewardRecordsOf(loaded.state);
  const units = explainLegacyFeedback(records, bindings);
  const revision = explainLatestLegacyRevision(records, bindings);

  return { schemaVersion: 1, ok: true, source, bindings, reported,
    questions: [...sourceQuestions, ...units.flatMap(row => row.status === "matched" ? row.questions : [])],
    legacy: { status: "available", revision: loaded.state.sequence, units }, legacyRevision: { status: "available", value: revision } };
}
