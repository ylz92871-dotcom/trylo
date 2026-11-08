import type { ToolTaskFeedback, ToolTaskMetrics } from "./task-feedback.js";

/** Retain both successful uses and counterexamples. A flood of recent model reports
 * must not erase the latest user/verifier assessment or an unresolved failure. */
export function selectToolTaskAssessments(records: readonly ToolTaskFeedback[], limit = 8): readonly ToolTaskFeedback[] {
  const selected: ToolTaskFeedback[] = [];
  const add = (record: ToolTaskFeedback | undefined) => {
    if (record !== undefined && selected.length < limit && !selected.includes(record)) selected.push(record);
  };
  const recent = [...records].reverse();

  add(recent.find(record => record.source === "user" || record.source === "verifier"));
  add(recent.find(record => record.outcome === "unsolved" || record.outcome === "partial"));
  add(recent.find(record => record.outcome === "solved"));

  for (const record of recent) add(record);

  return selected.reverse();
}

/** Task outcome, execution return status and reported cost comparison are different
 * evidence. These summaries guide the next hypothesis and cannot certify a version. */
export function toolTaskFeedbackContext(records: readonly ToolTaskFeedback[]): string | undefined {
  if (records.length === 0) return undefined;

  const assessments = selectToolTaskAssessments(records);
  const tasks = new Set(records.map(record => `${record.sessionId}:${record.taskId}`));
  const situations = [...new Set(assessments.map(record => record.situation))].map(situation => {
    const relevant = records.filter(record => record.situation === situation);
    return { situation, assessedTasks: new Set(relevant.map(record => `${record.sessionId}:${record.taskId}`)).size,
      outcomes: [...new Set(relevant.map(record => record.outcome))],
      sources: [...new Set(relevant.map(record => record.source))] };
  });

  return JSON.stringify({ quality: "unverified", assessmentCount: records.length, distinctTasks: tasks.size,
    taskAssessments: assessments, situations,
    reportedComparisons: assessments.flatMap(record => record.observedMetrics === undefined || record.baselineMetrics === undefined ? []
      : [{ feedbackId: record.feedbackId, source: record.source, taskId: record.taskId, situation: record.situation,
        observed: record.observedMetrics, baseline: record.baselineMetrics, delta: metricDelta(record.observedMetrics, record.baselineMetrics),
        status: "reported_comparison_not_controlled_gain" }]) });
}

function metricDelta(observed: ToolTaskMetrics, baseline: ToolTaskMetrics): ToolTaskMetrics {
  const result: { toolCalls?: number; rework?: number; cost?: number } = {};
  for (const key of ["toolCalls", "rework", "cost"] as const) {
    const next = observed[key], prior = baseline[key];
    if (next !== undefined && prior !== undefined) result[key] = next - prior;
  }
  return result;
}
