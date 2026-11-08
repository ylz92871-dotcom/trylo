/** Versioned collaboration control read model. It projects owners; it does not own their state. */
export type CollaborationIssueViewV1 = {
  readonly issueId: string; readonly revision: number; readonly title: string; readonly decision: string;
  readonly reason?: string; readonly updatedAt: string;
  readonly reports: readonly { readonly reportId: string; readonly memberId: string; readonly facts: readonly string[];
    readonly suspectedCauses: readonly string[]; readonly evidenceRefs: readonly string[] }[];
  readonly learning?: { readonly jobId: string; readonly state: string; readonly grantId: string;
    readonly unit: "total_model_tokens"; readonly allowance: number; readonly spent: number; readonly remaining: number };
  readonly dependencies: readonly { readonly dependencyId: string; readonly owner: "tool" | "expert" | "skill";
    readonly requestId?: string; readonly state: string; readonly reason?: string; readonly approvalStage?: "creation" | "retention" }[];
  readonly adjustments: readonly { readonly adjustmentRef: string; readonly title: string; readonly details: string;
    readonly affectedMembers: readonly string[]; readonly state: string; readonly experienceVersionIds: readonly string[] }[];
  readonly feedback: readonly { readonly ref: string; readonly summary: string; readonly sourceRefs: readonly string[] }[];
};

export type CollaborationIssuesSnapshotV1 = { readonly schemaVersion: 1; readonly scope: string;
  readonly issues: readonly CollaborationIssueViewV1[] };

export type CollaborationIssueControlV1 = { readonly schemaVersion: 1; readonly action: "resolve";
  readonly issueId: string; readonly expectedRevision: number; readonly reason: string };

export type CollaborationIssueControlResultV1 = { readonly schemaVersion: 1; readonly ok: true; readonly revision: number }
  | { readonly schemaVersion: 1; readonly ok: false; readonly reason: string };

/** Management input cannot claim to be a PA model decision, grant, approval or arbitrary scope change. */
export function isCollaborationIssueControlV1(value: unknown): value is CollaborationIssueControlV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const text = (v: unknown, max: number): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(v);
  return Object.keys(row).length === 5 && Object.keys(row).every(key => ["schemaVersion", "action", "issueId", "expectedRevision", "reason"].includes(key))
    && row.schemaVersion === 1 && row.action === "resolve" && text(row.issueId, 512) && text(row.reason, 1000)
    && typeof row.expectedRevision === "number" && Number.isSafeInteger(row.expectedRevision) && row.expectedRevision > 0;
}
