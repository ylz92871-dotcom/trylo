import type { AssessedToolUsageLesson } from "./usage-learning.js";
import type { ToolTaskFeedback } from "./task-feedback.js";

/** Historical support belongs to this exact old executable version. These facts
 * help plan a revision; they do not port advice or verification to its child. */
export type ToolParentUsageLesson = Omit<AssessedToolUsageLesson, "order"> & {
  readonly assessments: readonly { readonly feedbackRef: string; readonly feedback: ToolTaskFeedback;
    readonly returnedUseIds: readonly string[]; readonly observedLessonUseIds: readonly string[] }[];
  readonly omittedAssessmentCount: number;
};

export type ToolParentUsageHistory = {
  readonly parentVersionId: string;
  readonly historyScope: "bound" | "unknown";
  readonly coverage: "complete" | "partial";
  readonly sources: readonly { readonly toolVersionId: string; readonly contentHash: string; readonly lessons: readonly ToolParentUsageLesson[] }[];
  readonly omittedSourceCount: number;
  readonly omittedLessonCount: number;
};

export type ToolParentUsageContext = {
  readonly coverage: "complete" | "partial";
  readonly omittedParentVersionIds: readonly string[];
  readonly parents: readonly ToolParentUsageHistory[];
};
