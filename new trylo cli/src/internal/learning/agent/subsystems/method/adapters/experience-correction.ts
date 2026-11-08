import { createBoardReader } from "../../../../../adapters/learning-store/file-event-store.js";
import { canonicalObservations } from "../domain/inference-observations.js";
import type { MethodObservation } from "../domain/inference.js";
import type { MethodArchivePort } from "../port.js";
import { isMethodApplicationReport, sameNormalizedApplicationReport, type MethodApplicationReport } from "../domain/application-report.js";

/** A tool may revise its report, not impersonate an independent verifier. */
export async function correctExperience(root: string, archive: MethodArchivePort, now: () => string,
  observationId: string, outcome: MethodObservation["outcome"], reason: string, application?: MethodApplicationReport): Promise<void> {
  if (application !== undefined && !isMethodApplicationReport(application)) throw new Error("invalid_method_correction_application");

  const loaded = await createBoardReader(root).load();
  if (!loaded.ok) throw new Error(`method_correction:${loaded.reason}`);

  const observations = loaded.state.feedbacks.flatMap(item => item.observation === undefined ? [] : [item.observation]);
  const prior = canonicalObservations(observations).find(item => item.observationId === observationId);
  if (prior === undefined || prior.source !== "self_report") throw new Error("method_correction_unattributable");

  if (prior.outcome === outcome && sameNormalizedApplicationReport(prior.application, application ?? prior.application)) return;

  const feedback = loaded.state.feedbacks.find(item => item.observation?.observationId === observationId);
  if (feedback?.exposureId === undefined) throw new Error("method_correction_origin_missing");

  const result = await archive.recordFeedback({ writeId: `${observationId}:${prior.revision + 1}`, versionId: prior.versionId,
    turnId: prior.taskId, exposureId: feedback.exposureId, helped: outcome === "helped", observedAt: now(),
    sourceEventId: reason, observation: { ...prior, outcome, revision: prior.revision + 1,
      ...(application === undefined ? {} : { application }) } });
  if (!result.ok) throw new Error(`method_correction:${result.reason}`);
}
