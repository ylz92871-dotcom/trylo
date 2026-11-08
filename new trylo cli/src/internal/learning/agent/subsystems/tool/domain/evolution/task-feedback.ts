import { isIsoTime } from "./artifact.js";
import { isJsonValue, keysAre, recordOf, textOf } from "./parse.js";

export type ToolTaskMetrics = { readonly toolCalls?: number; readonly rework?: number; readonly cost?: number };

/** Assessments never rewrite execution quality or constitute activation/permission evidence. */
export type ToolTaskFeedback = {
  readonly schemaVersion: 1;
  readonly feedbackId: string;
  readonly versionId: string;
  readonly sessionId: string;
  readonly taskId: string;
  readonly useIds: readonly string[];
  readonly situation: string;
  readonly evidenceRefs: readonly string[];
  readonly source: "model" | "user" | "personal_agent" | "collaboration" | "verifier";
  readonly outcome: "solved" | "partial" | "unsolved" | "unknown";
  readonly attribution: "implementation" | "usage" | "configuration" | "environment" | "unknown";
  readonly summary: string;
  readonly recommendation: "retain" | "change_usage" | "improve" | "replace" | "avoid" | "unknown";
  readonly observedMetrics?: ToolTaskMetrics;
  readonly baselineMetrics?: ToolTaskMetrics;
};

export type ToolTaskFeedbackArtifact = {
  readonly type: "tool_task_feedback";
  readonly schemaVersion: 1;
  readonly scope: string;
  readonly contentHash: string;
  readonly occurredAt: string;
  readonly feedback: ToolTaskFeedback;
};

/** Agent assessments are hypotheses; only these independent sources add a new
 * external requirement without another host-recorded execution. */
export function toolFeedbackIsExternal(feedback: Pick<ToolTaskFeedback, "source">): boolean {
  return feedback.source === "user" || feedback.source === "verifier";
}

export function decodeToolTaskFeedback(value: unknown): ToolTaskFeedback | undefined {
  if (!recordOf(value) || !isJsonValue(value) || !keysAre(value,
    ["schemaVersion", "feedbackId", "versionId", "sessionId", "taskId", "useIds", "situation", "evidenceRefs", "source", "outcome", "attribution", "summary", "recommendation"],
    ["observedMetrics", "baselineMetrics"]) || value.schemaVersion !== 1
    || ![value.feedbackId, value.versionId, value.sessionId, value.taskId].every(item => textOf(item, 160))
    || !textOf(value.situation, 512) || !textOf(value.summary, 2048) || !ids(value.useIds, 1, 32) || !ids(value.evidenceRefs, 1, 16)
    || !["model", "user", "personal_agent", "collaboration", "verifier"].includes(String(value.source))
    || !["solved", "partial", "unsolved", "unknown"].includes(String(value.outcome))
    || !["implementation", "usage", "configuration", "environment", "unknown"].includes(String(value.attribution))
    || !["retain", "change_usage", "improve", "replace", "avoid", "unknown"].includes(String(value.recommendation))
    || (value.observedMetrics !== undefined && !metrics(value.observedMetrics))
    || (value.baselineMetrics !== undefined && !metrics(value.baselineMetrics))) return undefined;
  return value as ToolTaskFeedback;
}

export function decodeToolTaskFeedbackArtifact(value: unknown): ToolTaskFeedbackArtifact | undefined {
  if (!recordOf(value) || !isJsonValue(value) || !keysAre(value, ["type", "schemaVersion", "scope", "contentHash", "occurredAt", "feedback"])
    || value.type !== "tool_task_feedback" || value.schemaVersion !== 1 || !textOf(value.scope, 512)
    || typeof value.contentHash !== "string" || !/^[a-f0-9]{64}$/.test(value.contentHash) || !isIsoTime(value.occurredAt)) return undefined;
  const feedback = decodeToolTaskFeedback(value.feedback);
  return feedback === undefined ? undefined : { type: value.type, schemaVersion: 1, scope: value.scope,
    contentHash: value.contentHash, occurredAt: value.occurredAt, feedback };
}

export function toolTaskFeedbackContext(records: readonly ToolTaskFeedback[]): string | undefined {
  const relevant = records.slice(-8);
  return relevant.length === 0 ? undefined : JSON.stringify({ quality: "unverified", taskAssessments: relevant });
}

export function toolUsageGuidance(records: readonly ToolTaskFeedback[], situation?: string): readonly string[] {
  if (situation === undefined) return [];
  return records.filter(item => item.situation === situation).slice(-4).map(item =>
    `Task feedback ${item.feedbackId} (${item.source}; ${item.outcome}; attribution=${item.attribution}; recommendation=${item.recommendation}): ${item.summary}`);
}

function metrics(value: unknown): value is ToolTaskMetrics {
  return recordOf(value) && keysAre(value, [], ["toolCalls", "rework", "cost"]) && Object.keys(value).length > 0
    && Object.values(value).every(item => typeof item === "number" && Number.isFinite(item) && item >= 0);
}

function ids(value: unknown, min: number, max: number): value is readonly string[] {
  return Array.isArray(value) && value.length >= min && value.length <= max
    && value.every(item => textOf(item, 256)) && new Set(value).size === value.length;
}
