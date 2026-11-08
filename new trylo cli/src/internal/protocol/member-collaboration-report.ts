/** Member-authored observations, not checked verdicts, permissions or learning requests. */
export type MemberCollaborationReport = {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly summary: string;
  readonly facts: readonly string[];
  readonly suspectedCauses: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly issueRef?: string;
  readonly dimension?: string;
  readonly operation?: "request_context" | "synchronize" | "share_reference";
  readonly learningActionId?: string;
};

/** Execution assigns these coordinates; model arguments cannot choose the sender. */
export type MemberCollaborationReportContext = {
  readonly executionId: string;
  readonly taskId: string;
  readonly round: number;
  readonly role: string;
  readonly memberId?: string;
  readonly teamRunId?: string;
  /** Existing attempt identity may span several business provider requests. */
  readonly requestId?: string;
  /** Host-observed stream ordinal within this physical worker, not a provider-issued ID or authority. */
  readonly requestSequence?: number;
};

export type MemberCollaborationReportObserver = (context: MemberCollaborationReportContext,
  report: MemberCollaborationReport) => Promise<void>;

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, max: number): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= max;
const list = (value: unknown, max: number, length: number): value is string[] => Array.isArray(value)
  && value.length <= max && value.every(item => text(item, length));
const optionalText = (value: unknown, max: number) => value === undefined || text(value, max);

/** Normalize the tool boundary once. References and causal explanations may be absent. */
export function parseMemberCollaborationReport(value: unknown, id: string): MemberCollaborationReport | undefined {
  if (!record(value) || !text(id, 512) || (value.schemaVersion !== undefined && value.schemaVersion !== 1)
    || !text(value.summary, 1200) || !list(value.facts, 8, 400) || value.facts.length === 0
    || (value.suspectedCauses !== undefined && !list(value.suspectedCauses, 4, 400))
    || (value.evidenceRefs !== undefined && !list(value.evidenceRefs, 16, 512))
    || !optionalText(value.issueRef, 512) || !optionalText(value.dimension, 128) || !optionalText(value.learningActionId, 200)
    || (value.operation !== undefined && value.operation !== "request_context" && value.operation !== "synchronize" && value.operation !== "share_reference")) return undefined;

  const result: MemberCollaborationReport = { schemaVersion: 1, id, summary: value.summary.trim(), facts: value.facts.map(item => item.trim()),
    suspectedCauses: list(value.suspectedCauses, 4, 400) ? value.suspectedCauses.map(item => item.trim()) : [],
    evidenceRefs: list(value.evidenceRefs, 16, 512) ? value.evidenceRefs.map(item => item.trim()) : [],
    ...(typeof value.issueRef === "string" ? { issueRef: value.issueRef.trim() } : {}),
    ...(typeof value.dimension === "string" ? { dimension: value.dimension.trim() } : {}),
    ...(value.operation === undefined ? {} : { operation: value.operation }),
    ...(typeof value.learningActionId === "string" ? { learningActionId: value.learningActionId.trim() } : {}) };

  return JSON.stringify(result).length <= 10000 ? result : undefined;
}

export function isMemberCollaborationReport(value: unknown): value is MemberCollaborationReport {
  return record(value) && value.schemaVersion === 1 && typeof value.id === "string"
    && Array.isArray(value.suspectedCauses) && Array.isArray(value.evidenceRefs)
    && parseMemberCollaborationReport(value, value.id) !== undefined;
}

export const MEMBER_COLLABORATION_CONTENT_SCHEMA = { type: "object", additionalProperties: false, properties: {
  summary: { type: "string", minLength: 1, maxLength: 1200 },
  facts: { type: "array", minItems: 1, maxItems: 8, items: { type: "string", minLength: 1, maxLength: 400 } },
  suspectedCauses: { type: "array", maxItems: 4, items: { type: "string", minLength: 1, maxLength: 400 } },
  evidenceRefs: { type: "array", maxItems: 16, items: { type: "string", minLength: 1, maxLength: 512 } },
  issueRef: { type: "string", minLength: 1, maxLength: 512 }, dimension: { type: "string", minLength: 1, maxLength: 128 },
  operation: { type: "string", enum: ["request_context", "synchronize", "share_reference"] },
  learningActionId: { type: "string", minLength: 1, maxLength: 200 },
}, required: ["summary", "facts"] } as const;
