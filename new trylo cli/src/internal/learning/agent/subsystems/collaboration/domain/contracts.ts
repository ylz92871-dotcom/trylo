import type { SubagentHandoff } from "../../../../../protocol/subagent-handoff.js";
import type { BoardCommand } from "../../../../control/commands.js";
import type { ReduceResult } from "../../../../control/result.js";
import type { StoreLoadErr, StoreLoadResult } from "../../../../control/store-port.js";

export const HANDOFF_FIELDS = ["artifacts", "evidence", "pending", "blockers"] as const;

export type HandoffField = (typeof HANDOFF_FIELDS)[number];

export type CollaborationObject = "handoff" | "synchronization" | "division" | "review";

/** Facts describe cooperation, never authority, member skill ranks or execution state. */
export type CollaborationContext = {
  readonly scope: string;
  readonly teamRunId: string;
  readonly taskId: string;
  readonly memberId: string;
  readonly role: string;
  readonly round: number;
  readonly dependency: "artifact" | "independent";
};

/** Checker identity is supplied by the trusted execution adapter, never parsed from model prose. */
export type CollaborationResult = {
  readonly status: "completed" | "failed" | "cancelled" | "unknown";
  readonly check: "passed" | "failed" | "unverified";
  readonly reworkCount: number;
  readonly missingFields: readonly HandoffField[];
  readonly capability: "sufficient" | "insufficient" | "unknown";
  readonly evidenceRefs: readonly string[];
  readonly source: "external_checker" | "user" | "member_report";
};

type FactBase = { readonly schemaVersion: 1; readonly factId: string; readonly scope: string; readonly recordedAt: string };

export type CollaborationEpisode = FactBase & {
  readonly kind: "episode";
  readonly context: CollaborationContext;
  readonly assignmentRef: string;
  readonly handoff?: SubagentHandoff;
  readonly result: CollaborationResult;
};

export type CollaborationFielding = FactBase & {
  readonly kind: "fielding";
  readonly context: CollaborationContext;
  readonly versionId: string;
  readonly proposalId: string;
  readonly requestId: string;
  readonly correctionIds: readonly string[];
};

export type CollaborationOutcome = FactBase & {
  readonly kind: "outcome";
  readonly fieldingId: string;
  readonly result: CollaborationResult;
};

export type CorrectionScope = { readonly kind: "once"; readonly taskId: string }
  | { readonly kind: "class"; readonly dependency: CollaborationContext["dependency"]; readonly role: string }
  | { readonly kind: "longterm" };

export type CollaborationCorrection = FactBase & {
  readonly kind: "correction";
  readonly targetVersionId: string;
  readonly appliesTo: CorrectionScope;
  readonly action: "skip" | "require_evidence";
  readonly evidenceRef: string;
};

export type CollaborationDiagnosisFact = FactBase & {
  readonly kind: "diagnosis";
  readonly subjectFactId: string;
  readonly diagnosis: "coordination" | "member_capability" | "unverified" | "not_applicable" | "supports";
  readonly versionId?: string;
};

export type CollaborationFact = CollaborationEpisode | CollaborationFielding | CollaborationOutcome | CollaborationCorrection | CollaborationDiagnosisFact;

/** Reuses the immutable Board workflow asset envelope; this is a distinct content format. */
export type CollaborationPractice = {
  readonly schema: "collaboration-practice/v1";
  readonly object: "handoff";
  readonly problem: "handoff_missing_context";
  readonly dependency: "artifact";
  readonly requiredFields: readonly HandoffField[];
  readonly sourceEpisodeIds: readonly string[];
  readonly sourceOutcomeIds: readonly string[];
};

export type CollaborationBudget = { readonly maxEpisodes: number; readonly maxPromptChars: number };

export type CollaborationBoardPort = {
  load(): Promise<StoreLoadResult>;
  apply(command: BoardCommand, signal?: AbortSignal): Promise<ReduceResult | StoreLoadErr>;
  readArchive?(query: import("./v2-contracts.js").CollaborationArchiveQueryV2): Promise<{
    readonly ok: true; readonly records: readonly Extract<BoardCommand, { type: "record_collaboration_v2" }>[];
  } | CollaborationFailure>;
};

export type CollaborationFailure = { readonly ok: false; readonly reason: string; readonly detail?: string };

export type CollaborationSelection = {
  readonly kind: "selected";
  readonly versionId: string;
  readonly proposalId: string;
  readonly guidance: string;
  readonly context: CollaborationContext;
  readonly correctionIds: readonly string[];
} | { readonly kind: "skip"; readonly reason: string };
