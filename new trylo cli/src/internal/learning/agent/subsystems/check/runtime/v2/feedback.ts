import { contentHashOf } from "../../../../../control/hash.js";
import type { CheckExperience } from "../../domain/v2/contracts.js";
import { isJsonValue, keysAre, recordOf, textOf } from "../../../../../domains/tool/evolution/parse.js";
import type { CheckerCatalog, CheckerCorrectionScope, CheckerFeedback, CheckerRun } from "./contracts.js";

/** Feedback is an owner assertion about immutable facts, not an edit to those facts or their standard. */
export function parseCheckerFeedback(raw: unknown, catalog: CheckerCatalog): CheckerFeedback | undefined {
  if (!isJsonValue(raw) || !recordOf(raw) || raw.schemaVersion !== 2 || raw.type !== "checker_feedback"
    || !keysAre(raw, ["schemaVersion", "type", "scope", "sessionId", "turnId", "sourceRef", "text", "runIds"], ["judgment", "appliesTo"])
    || ![raw.scope, raw.sessionId, raw.turnId, raw.sourceRef].every(value => textOf(value, 512)) || !textOf(raw.text, 8192)
    || !Array.isArray(raw.runIds) || raw.runIds.length > 32 || new Set(raw.runIds).size !== raw.runIds.length
    || !raw.runIds.every(ref => textOf(ref, 256)
      && catalog.runs.some(run => run.runId === ref && run.scope === raw.scope && run.sessionId === raw.sessionId))) return undefined;

  if (raw.judgment !== undefined && (!recordOf(raw.judgment) || !keysAre(raw.judgment, ["runId", "expected"])
    || !raw.runIds.includes(raw.judgment.runId) || !["pass", "fail", "not_applicable"].includes(String(raw.judgment.expected)))) return undefined;

  if (raw.appliesTo !== undefined && !validCorrectionScope(raw.appliesTo, raw.runIds, catalog)) return undefined;

  return structuredClone(raw) as CheckerFeedback;
}

function validCorrectionScope(value: unknown, runIds: readonly unknown[], catalog: CheckerCatalog): boolean {
  if (!recordOf(value)) return false;

  const runs = catalog.runs.filter(run => runIds.includes(run.runId));

  if (value.kind === "task") return keysAre(value, ["kind", "sessionId", "turnId"])
    && textOf(value.sessionId, 512) && textOf(value.turnId, 512)
    && runs.every(run => run.sessionId === value.sessionId && run.turnId === value.turnId);

  return (value.kind === "class" || value.kind === "long_term") && keysAre(value, ["kind", "requirementRef", "requirementDigest"])
    && textOf(value.requirementRef, 512) && typeof value.requirementDigest === "string" && /^[a-f0-9]{64}$/u.test(value.requirementDigest)
    && runs.length > 0 && runs.every(run => run.requirements.ref === value.requirementRef && run.requirements.digest === value.requirementDigest);
}

export function correctionScope(feedback: CheckerFeedback, run?: CheckerRun): CheckerCorrectionScope {
  return feedback.appliesTo ?? { kind: "task", sessionId: run?.sessionId ?? feedback.sessionId, turnId: run?.turnId ?? feedback.turnId };
}

export function feedbackSuspendsVersion(catalog: CheckerCatalog, versionId: string,
  task: { readonly sessionId: string; readonly turnId: string }): boolean {
  return catalog.feedbacks.some(feedback => {
    const judgment = feedback.judgment;
    if (judgment === undefined) return false;
    const run = catalog.runs.find(item => item.runId === judgment.runId && item.versionId === versionId);
    if (run === undefined || run.outcome.kind !== "checked" || run.outcome.verdict.status === judgment.expected) return false;
    const appliesTo = correctionScope(feedback, run);
    return appliesTo.kind !== "task" || (task.sessionId === appliesTo.sessionId && task.turnId === appliesTo.turnId);
  });
}

/** Early v2 task judgments were auto-promoted. Keep their history, while refusing to reuse them as shared gold. */
export function checkerExperienceHasSharedOracle(catalog: CheckerCatalog, experience: CheckExperience): boolean {
  const assessment = experience.assessment;
  if (assessment === undefined) return false;

  return !catalog.feedbacks.some(feedback => {
    const judgment = feedback.judgment;
    if (feedback.scope !== experience.scope || judgment === undefined || assessment.kind !== "user_correction"
      || assessment.sourceRef !== feedback.sourceRef
      || experience.id !== "checker-judgment:" + contentHashOf([feedback.sourceRef, judgment.runId])) return false;
    return correctionScope(feedback, catalog.runs.find(run => run.runId === judgment.runId)).kind === "task";
  });
}
