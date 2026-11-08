import type { ToolTaskFeedback } from "./task-feedback.js";

export type ToolUsageLesson = {
  readonly decisionVersionId: string;
  readonly toolVersionId: string;
  readonly toolId: string;
  readonly usage: string;
  readonly situations: readonly string[];
  readonly exclusions: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly order: number;
};

export type ToolUsageAssessment = {
  readonly feedbackVersionId: string;
  readonly feedback: ToolTaskFeedback;
  readonly order: number;
  /** Host-derived from returned use records, never a model's claim of having applied advice. */
  readonly observedLessonRefs?: readonly string[];
};

export type ToolUsageStanding = "proposed" | "supported" | "contested" | "withdrawn" | "superseded";

type ConditionStanding = { readonly situation: string; readonly standing: ToolUsageStanding; readonly assessmentRefs: readonly string[] };

export type AssessedToolUsageLesson = ToolUsageLesson & {
  readonly standing: ToolUsageStanding;
  readonly assessmentRefs: readonly string[];
  readonly effectiveSituations: readonly string[];
  readonly conditionStandings: readonly ConditionStanding[];
};

/** A usage lesson changes what the model sees, never tool availability. Same-version
 * corrections can retract advice; neither a model opinion nor reported savings is a verdict. */
export function assessToolUsageLessons(lessons: readonly ToolUsageLesson[], assessments: readonly ToolUsageAssessment[]): readonly AssessedToolUsageLesson[] {
  return lessons.map(lesson => {
    const later = lessons.filter(other => other.toolVersionId === lesson.toolVersionId && other.order > lesson.order);
    const conditionStandings = lesson.situations.map(situation => {
      const relevant = assessments.filter(entry => entry.order > lesson.order && entry.feedback.versionId === lesson.toolVersionId
        && situation === entry.feedback.situation && (entry.feedback.source === "user" || entry.feedback.source === "verifier"))
        .sort((left, right) => left.order - right.order);
      let standing: ToolUsageStanding = later.some(other => other.situations.includes(situation)) ? "superseded" : "proposed";

      for (const { feedback, observedLessonRefs } of relevant) {
        if (standing === "superseded") break;
        if (feedback.recommendation === "avoid") standing = "withdrawn";
        else if (feedback.attribution === "usage" && (feedback.recommendation === "change_usage" || feedback.outcome === "unsolved" || feedback.outcome === "partial")) standing = "contested";
        else if (feedback.recommendation === "retain" && feedback.outcome === "solved"
          && observedLessonRefs?.includes(lesson.decisionVersionId)) standing = "supported";
      }

      return { situation, standing, assessmentRefs: relevant.map(entry => entry.feedbackVersionId) };
    });
    const effective = conditionStandings.filter(condition => condition.standing === "proposed" || condition.standing === "supported");

    return { ...lesson, standing: lessonStanding(conditionStandings), conditionStandings, assessmentRefs: conditionStandings.flatMap(condition => condition.assessmentRefs),
      effectiveSituations: effective.map(condition => condition.situation) };
  });
}

function lessonStanding(conditions: readonly ConditionStanding[]): ToolUsageStanding {
  const usable = conditions.filter(condition => condition.standing === "proposed" || condition.standing === "supported");
  if (usable.length > 0) return usable.every(condition => condition.standing === "supported") ? "supported" : "proposed";
  if (conditions.some(condition => condition.standing === "withdrawn")) return "withdrawn";
  return conditions.some(condition => condition.standing === "contested") ? "contested" : "superseded";
}

/** Conditions remain visible even without a situation tag: the normal execution
 * model can assess semantic relevance without another retrieval/model call. */
export function toolUsageLessonGuidance(lessons: readonly AssessedToolUsageLesson[], taskSituation?: string): readonly string[] {
  return toolUsageLessonAdvice(lessons, taskSituation).map(row => row.text);
}

export function toolUsageLessonAdvice(lessons: readonly AssessedToolUsageLesson[], taskSituation?: string): readonly { readonly decisionVersionId: string; readonly text: string }[] {
  const eligible = lessons.filter(lesson => lesson.standing === "proposed" || lesson.standing === "supported")
    .sort((left, right) => Number(right.effectiveSituations.includes(taskSituation ?? "")) - Number(left.effectiveSituations.includes(taskSituation ?? "")) || right.order - left.order);
  return eligible.flatMap(lesson => {
    const status = lesson.standing === "supported" ? "task feedback supports this proposal" : "model proposal";
    const text = `Conditional usage (${status}; ${lesson.decisionVersionId.slice(-12)}): when ${lesson.effectiveSituations.join("; ")}, ${lesson.usage}`
    + (lesson.exclusions.length === 0 ? "" : ` Do not apply when ${lesson.exclusions.join("; ")}.`)
    + " Assess relevance; advice grants no authority.";

    // Never truncate an exception away to fit the provider description. Oversized
    // lessons remain in the explicit context view with all of their conditions.
    return text.length <= 384 ? [{ decisionVersionId: lesson.decisionVersionId, text }] : [];
  }).slice(0, 2).reverse();
}

/** Exact matching is only a preference for the display budget. Counterexamples and
 * corrections remain conditional text for the normal model to interpret semantically. */
export function toolFeedbackGuidance(assessments: readonly ToolUsageAssessment[], taskSituation?: string): readonly string[] {
  const relevant = [...assessments].sort((left, right) => Number(right.feedback.situation === taskSituation)
    - Number(left.feedback.situation === taskSituation) || right.order - left.order);
  const latestBySituation = new Map<string, ToolUsageAssessment>();

  for (const entry of relevant) if ((entry.feedback.source === "user" || entry.feedback.source === "verifier")
    && !latestBySituation.has(entry.feedback.situation)) latestBySituation.set(entry.feedback.situation, entry);

  const chosen = [...latestBySituation.values()].find(entry => entry.feedback.recommendation === "avoid" || entry.feedback.recommendation === "change_usage"
    || entry.feedback.outcome === "unsolved" || entry.feedback.outcome === "partial") ?? relevant[0];

  return chosen === undefined ? [] : [`Task feedback ${chosen.feedback.feedbackId} (${chosen.feedback.source}; ${chosen.feedback.outcome}; situation=${chosen.feedback.situation}; attribution=${chosen.feedback.attribution}; recommendation=${chosen.feedback.recommendation}): ${chosen.feedback.summary}`];
}
