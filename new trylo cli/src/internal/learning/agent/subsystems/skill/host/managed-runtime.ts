import type { HermesSkillOpportunity } from "../contracts.js";
import { skillFailureCode } from "../failure.js";
import type { SkillCentralWorker } from "../control/contracts.js";
import type { createSkillCoordination } from "../control/coordination.js";
import { resolveManagedSkillSource } from "../control/managed.js";
import type { SkillManagedRuntime } from "../control/managed.js";
import type { CentralLearningContextReader, CentralLearningSourceContext } from "../../../../control/source-context.js";
import { skillReviewWorkResult } from "../control/review-result.js";
import { skillStageFunding } from "../control/stage-funding.js";
import { isCentralLearningResources } from "../../../../control/central-learning-resources.js";
import { isCentralLearningAllowance } from "../../../../control/coordination-parse.js";
import type { CentralLearningRemaining } from "../../../../control/coordination-contract.js";
import type { SkillReviewReply } from "../review-process.js";
import type { SkillReviewModel } from "../control/protocol-family.js";
import type { SkillReviewCheckpoint } from "./review-continuation.js";

type Work = Parameters<SkillCentralWorker>[0];

// This bounds one native review package, not the original managed grant's lifetime.
const MAX_REVIEW_CALLS = 64;
const stageWork = (work: Work, limits: CentralLearningRemaining, maxPromptChars?: number): Work => ({ ...work,
  remaining: { tokens: Math.min(work.remaining.tokens, limits.tokens), calls: Math.min(work.remaining.calls, limits.calls),
    steps: Math.min(work.remaining.steps, limits.steps) }, funding: skillStageFunding(work, limits, maxPromptChars) });
// The operation view may narrow prompt admission without modifying the grant.
const reviewResources = (value: CentralLearningRemaining, maxPromptChars = 100000) => isCentralLearningResources(value)
  && isCentralLearningAllowance({ schemaVersion: 2, unit: "total_model_tokens", maxTokens: value.tokens,
    maxCalls: value.calls, maxSteps: value.steps, maxPromptChars });

type Options = {
  readonly scope: string;
  readonly coordination: Pick<ReturnType<typeof createSkillCoordination>, "inspect" | "run">
    & Partial<Pick<ReturnType<typeof createSkillCoordination>, "recoverExpired">>;
  readonly read: Parameters<typeof resolveManagedSkillSource>[0]["read"];
  readonly readResearch?: Parameters<typeof resolveManagedSkillSource>[0]["readResearch"];
  /** Original native seen/read operation; never a local second processed-source index. */
  readonly seen: (opportunity: HermesSkillOpportunity, signal: AbortSignal) => Promise<unknown>;
  readonly review: (opportunity: HermesSkillOpportunity, work: Work, checkpoint?: SkillReviewCheckpoint,
    reviewOrigin?: "central_research") => Promise<SkillReviewReply>;
  /** Explicit single-issue recovery; ordinary scheduling never invents one. */
  readonly continuation?: { readonly issueId: string; readonly read: () => Promise<SkillReviewCheckpoint> };
  readonly contextForIssue?: CentralLearningContextReader;
  /** Actual host connection metadata used by the same review execution. */
  readonly reviewModel?: () => SkillReviewModel;
};

/** Source and exact-grant execution for the original Hermes review process.
 * Provider, native processes and Permission are assembled by the original host. */
export function createHermesManagedSkillRuntime(options: Options): SkillManagedRuntime & { readonly worker: SkillCentralWorker } {
  const source = async (work: Pick<Work, "issue" | "signal">, capturedContext?: CentralLearningSourceContext) => {
    if (options.continuation !== undefined && options.continuation.issueId !== work.issue.issueId) {
      return { status: "unavailable" as const, reason: "hermes_continuation_issue_mismatch", sourceRefs: [] };
    }
    const checkpoint = await options.continuation?.read();
    const observedContext = capturedContext ?? await options.contextForIssue?.(work.issue.issueId);
    const context = observedContext === undefined ? undefined : structuredClone(observedContext);
    const augment = (opportunity: HermesSkillOpportunity | undefined) => opportunity === undefined || checkpoint === undefined ? opportunity
      : { ...opportunity, experience: { ...opportunity.experience, reviewContinuation: { reference: checkpoint.ref, ...checkpoint.metadata } } };
    const resolved = await resolveManagedSkillSource({ issue: work.issue, scope: options.scope,
      read: async (input, signal) => augment(await options.read(input, signal)),
      ...(options.readResearch === undefined ? {} : { readResearch: async (ref: string, signal: AbortSignal) => augment(await options.readResearch!(ref, signal)) }),
      ...(context === undefined ? {} : { context }),
      ...(options.reviewModel === undefined ? {} : { reviewModel: options.reviewModel() }) }, work.signal);

    return resolved.status !== "ready" ? resolved : { ...resolved, checkpoint,
      source: { ...resolved.source, ...(context === undefined ? {} : { sourceContext: context }),
        sourceRefs: [...resolved.source.sourceRefs, ...(checkpoint === undefined ? [] : [checkpoint.ref])] } };
  };
  const workWithSource = async (work: Work, expectedSourceRef?: string, capturedContext?: CentralLearningSourceContext): ReturnType<SkillCentralWorker> => {
    const observed = await source(work, capturedContext);
    if (observed.status !== "ready") return { kind: "failed", reason: observed.reason };
    if (expectedSourceRef !== undefined && observed.source.sourceBindingRef !== expectedSourceRef) {
      return { kind: "failed", reason: "hermes_managed_source_changed" };
    }
    return skillReviewWorkResult(await options.review(observed.opportunity, work, observed.checkpoint, observed.source.reviewOrigin));
  };

  return {
    worker: work => workWithSource(stageWork(work, { tokens: work.remaining.tokens,
      calls: Math.min(work.remaining.calls, MAX_REVIEW_CALLS), steps: Math.min(work.remaining.steps, MAX_REVIEW_CALLS) })),
    ...(options.coordination.recoverExpired === undefined ? {} : {
      recoverManaged: (issueId: string, signal: AbortSignal) => options.coordination.recoverExpired!(issueId, signal),
    }),
    async prepareManaged(issueId, signal, capturedContext) {
      if (signal.aborted) return { status: "unavailable", reason: "learning_aborted", sourceRefs: [] };

      const current = await options.coordination.inspect(issueId);
      if (!current.ok) return { status: "unavailable", reason: current.reason, sourceRefs: [] };

      const issue = current.issues[0];
      if (issue === undefined) return { status: "unavailable", reason: "learning_issue_not_found", sourceRefs: [] };

      try {
        const resolved = await source({ issue, signal }, capturedContext);
        if (resolved.status !== "ready") return resolved;
        const seen = await options.seen(resolved.opportunity, signal);
        if (typeof seen !== "boolean") throw new Error("hermes_review_invalid_preparation");
        return seen ? { status: "terminal", reason: "hermes_review_already_processed", sourceRefs: resolved.source.sourceRefs }
          : { status: "ready", source: resolved.source };
      } catch (error) {
        return { status: "unavailable", reason: skillFailureCode(error, "hermes_skill_source_unavailable"),
          sourceRefs: issue.reports.flatMap(report => report.evidenceRefs) };
      }
    },
    runManaged: (input, signal) => !reviewResources(input.stageResources, input.maxPromptChars)
      ? Promise.resolve({ ok: false, reason: "hermes_managed_stage_resources" }) : options.coordination.run({ issueId: input.issueId, signal,
      expectedGrantId: input.grantId, expectedIssueRevision: input.expectedIssueRevision,
      worker: work => work.issue.revision !== input.expectedIssueRevision || work.issue.grantId !== input.grantId
        ? Promise.resolve({ kind: "failed", reason: "hermes_managed_binding_stale" })
        : workWithSource(stageWork(work, input.stageResources, input.maxPromptChars), input.sourceBindingRef, input.sourceContext) }),
  };
}
