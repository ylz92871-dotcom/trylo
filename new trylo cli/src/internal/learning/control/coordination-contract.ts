import type { CentralBudgetAction, CentralBudgetBinding } from "./central-budget-contract.js";
import type { ResumeIncompleteCollaborationInput } from "./collaboration-failure-continuation-contract.js";

/** Central learning coordination. These records never authorize production tools or expert creation. */
export const CENTRAL_LEARNING_AGENT_DOMAINS = ["collaboration", "prompt", "tool", "workflow", "skill"] as const;

export type CentralLearningAgentDomain = (typeof CENTRAL_LEARNING_AGENT_DOMAINS)[number];

export type TeamLearningIssueSource = { readonly teamRunId: string; readonly taskId: string; readonly memberId: string };

/** A requested computation is not a new business observation or a Team event. */
export type ResearchLearningIssueSource = { readonly kind: "research_request"; readonly domain: CentralLearningAgentDomain;
  readonly requestRef: string; readonly intentRef: string };

export type LearningIssueSource = TeamLearningIssueSource
  | ResearchLearningIssueSource
  | { readonly subsystem: "method" | "tool" | "workflow" | "skill"; readonly taskId: string; readonly versionId: string };

export type LearningIssueReport = {
  readonly reportId: string;
  readonly source: LearningIssueSource;
  readonly facts: readonly string[];
  readonly hypotheses?: readonly string[];
  readonly evidenceRefs: readonly string[];
};

/** Legacy team consumers only see their own reports; method learning never fabricates team identities. */
export function isTeamLearningIssueReport(report: LearningIssueReport): report is LearningIssueReport & { readonly source: TeamLearningIssueSource } {
  return "teamRunId" in report.source;
}

export type LearningIssueDecision = { readonly kind: "unreviewed" }
  | { readonly kind: "resolved" | "ordinary_execution" | "focused_learning"; readonly reason: string;
      readonly sourceRefs: readonly string[]; readonly decidedAt: string; readonly revision: number };

export type LearningIssue = {
  readonly schemaVersion: 1; readonly issueId: string; readonly scope: string; readonly problemKey: string;
  readonly revision: number; readonly reports: readonly LearningIssueReport[]; readonly decision: LearningIssueDecision;
  readonly createdAt: string; readonly updatedAt: string; readonly jobId?: string; readonly grantId?: string;
};

/** One operation's bounded envelope. This is not a managed grant's lifetime limit. */
export type CentralLearningAllowance = {
  readonly schemaVersion: 2; readonly unit: "total_model_tokens";
  readonly maxTokens: number; readonly maxCalls: number; readonly maxSteps: number; readonly maxPromptChars: number;
};

/** Same persisted units, but cumulative across confirmed operations on one managed grant.
 * The original root bounds authorization; old spent and unknown reservations never reset. */
export type CentralLearningGrantAllowance = CentralLearningAllowance;

export type CentralLearningUsage = { readonly kind: "reported"; readonly totalTokens: number;
  readonly inputTokens?: number; readonly outputTokens?: number; readonly model?: string }
  | { readonly kind: "unknown"; readonly reason: string };

export type CentralLearningReservation = { readonly reservationId: string; readonly claimId: string; readonly maxTokens: number;
  readonly state: "reserved" | "settled"; readonly usage?: CentralLearningUsage };

export type CentralLearningClaim = { readonly claimId: string; readonly ownerId: string; readonly expiresAt: string; readonly step: number;
  /** Managed only: consecutive takeovers of an unconfirmed lease. A confirmed finish removes this claim. */
  readonly recoveryAttempts?: number };

export type CentralLearningGrant = {
  readonly schemaVersion: 2; readonly grantId: string; readonly issueId: string; readonly scope: string; readonly jobId: string;
  /** Absent on legacy grants, whose effective domain remains collaboration. */
  readonly domain?: CentralLearningAgentDomain;
  /** Explicit managed funding only. Older independent grants are never silently rebound. */
  readonly budgetId?: string; readonly authorizationRef?: string; readonly planRef?: string;
  readonly focusRevision: number; readonly allowance: CentralLearningGrantAllowance; readonly steps: number;
  readonly reservations: readonly CentralLearningReservation[]; readonly claim?: CentralLearningClaim;
  readonly status: "open" | "closed"; readonly closedReason?: string;
};

export type CentralLearningRemaining = { readonly tokens: number; readonly calls: number; readonly steps: number };

export type LearningDependencyState = { readonly kind: "waiting" | "unavailable"; readonly reason: string }
  | { readonly kind: "authorized"; readonly authorizationRef: string }
  | { readonly kind: "ready"; readonly resultRef: string; readonly resultVersion: string; readonly evidenceRefs: readonly string[] }
  | { readonly kind: "failed" | "rejected" | "cancelled"; readonly reason: string };

export type LearningDependencyDraft = { readonly dependencyId: string; readonly owner: "tool" | "expert" | "skill";
  readonly requestId?: string; readonly correlationRef: string; readonly state: LearningDependencyState };

/** A dependency is the Board's wait relationship, not a copy of a library's request authority. */
export type LearningDependency = LearningDependencyDraft & { readonly schemaVersion: 1; readonly issueId: string;
  readonly jobId: string; readonly grantId: string; readonly revision: number; readonly observedAt: string };

export type CentralLearningWorkResult = { readonly kind: "completed"; readonly resultRefs: readonly string[] }
  | { readonly kind: "waiting_dependency"; readonly dependencies: readonly LearningDependencyDraft[] }
  | { readonly kind: "failed" | "cancelled"; readonly reason: string; readonly resultRefs?: readonly string[] };

/** Methods may release their lease while preserving one bounded lifetime grant. Other workers retain their result contract. */
export type CentralLearningFinishResult = CentralLearningWorkResult | { readonly kind: "yielded"; readonly reason: string };

export type CoordinationAction =
  | CentralBudgetAction
  | ({ readonly kind: "resume_incomplete" } & ResumeIncompleteCollaborationInput)
  | { readonly kind: "report"; readonly scope: string; readonly problemKey: string; readonly issueId: string;
      readonly report: LearningIssueReport; readonly expectedRevision?: number }
  | { readonly kind: "decide"; readonly issueId: string; readonly expectedRevision: number;
      readonly decision: Exclude<LearningIssueDecision["kind"], "unreviewed">; readonly reason: string; readonly sourceRefs: readonly string[] }
  | { readonly kind: "fund"; readonly issueId: string; readonly expectedRevision: number; readonly grantId: string; readonly allowance: CentralLearningGrantAllowance;
      readonly domain?: CentralLearningAgentDomain; readonly expectedSequence?: number } & Partial<CentralBudgetBinding>
  | { readonly kind: "claim"; readonly jobId: string; readonly expectedAttempt: number; readonly claimId: string;
      readonly ownerId: string; readonly expiresAt: string;
      /** Optional exact source prefix for centrally prepared stages. Old claims retain their original semantics. */
      readonly expectedIssueRevision?: number }
  | { readonly kind: "renew"; readonly jobId: string; readonly claimId: string; readonly ownerId: string;
      readonly expectedStep: number; readonly expectedExpiresAt: string; readonly expiresAt: string;
      readonly expectedIssueRevision?: number }
  | { readonly kind: "finish"; readonly jobId: string; readonly claimId: string; readonly result: CentralLearningFinishResult;
      /** Recovery can bind its exact source prefix; legacy finish callers retain their existing semantics. */
      readonly expectedIssueRevision?: number }
  | { readonly kind: "dependency"; readonly dependencyId: string; readonly expectedRevision: number; readonly requestId?: string; readonly state: LearningDependencyState }
  | { readonly kind: "reserve"; readonly grantId: string; readonly claimId: string; readonly reservationId: string; readonly maxTokens: number }
  | { readonly kind: "settle"; readonly grantId: string; readonly reservationId: string; readonly usage: CentralLearningUsage };

export type CoordinateLearningCommand = { readonly type: "coordinate_learning"; readonly commandId: string;
  readonly issuedAt: string; readonly action: CoordinationAction };

export function centralLearningSpent(grant: CentralLearningGrant) {
  return { tokens: grant.reservations.reduce((sum, item) => sum + (item.usage?.kind === "reported" ? item.usage.totalTokens : item.maxTokens), 0),
    calls: grant.reservations.length, steps: grant.steps };
}

export function centralLearningRemaining(grant: CentralLearningGrant): CentralLearningRemaining {
  const spent = centralLearningSpent(grant);
  return { tokens: Math.max(0, grant.allowance.maxTokens - spent.tokens), calls: Math.max(0, grant.allowance.maxCalls - spent.calls),
    steps: Math.max(0, grant.allowance.maxSteps - spent.steps) };
}

/** Authorization only permits the original funded worker to build; it never means the resource is ready. */
export function learningDependencyResumable(dependency: Pick<LearningDependency, "state">): boolean {
  return dependency.state.kind === "ready" || dependency.state.kind === "authorized";
}
