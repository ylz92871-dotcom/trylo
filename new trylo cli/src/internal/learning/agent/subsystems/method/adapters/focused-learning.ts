import { createBoardReader, withBoardWriter } from "../../../../../adapters/learning-store/file-event-store.js";
import type { ProviderPort } from "../../../../../ports/provider.js";
import type { CoordinationAction } from "../../../../control/coordination-contract.js";
import { centralLearningRemaining } from "../../../../control/coordination-contract.js";
import { contentHashOf } from "../../../../control/hash.js";
import type { FocusedLearningPort as PersonalAgentFocusedLearning } from "../../../../control/focused-learning-port.js";
import { createExperienceStore, experienceViewOf } from "./experience-store.js";
import { createExperienceModel } from "./experience-model.js";
import { createExperienceFunding } from "./experience-funding.js";
import { createMethodBoardWriter } from "./board-writer.js";
import { correctExperience } from "./experience-correction.js";
import { reviseExperience } from "./experience-revision.js";
import { pendingExperienceReview, reviewExperiences } from "../orchestration/experience-review.js";
import type { ExperienceRuntimeOptions } from "../orchestration/experience-runtime.js";
import { methodFundingIdentity } from "./funding-identity.js";
import { methodCentralStageIdentity, methodFocusedTarget as methodTarget, type ManagedMethodReview } from "./central-source.js";
import { shortId } from "../../../../domains/shared/hash.js";
import type { CentralLearningContextReader } from "../../../../control/source-context.js";
import { recoverExpiredMethodLearning } from "./expired-recovery.js";
import { readCentralStageContext } from "../../../../../integration/central-learning/source-context.js";
import { readPreparedCentralStageContext } from "../../../../../integration/central-learning/prepared-context.js";

type FocusIntent = { readonly kind: "resume" }
  | { readonly kind: "focus"; readonly input: Parameters<PersonalAgentFocusedLearning["focus"]>[0] }
  | { readonly kind: "managed"; readonly binding: ManagedMethodReview };

/** Consume an existing method scope's purse. PA focus never creates another lifetime allowance. */
export function createMethodFocusedLearning(options: {
  readonly boardRoot: string; readonly scope: string; readonly workspaceId: string; readonly turnId: string;
  readonly provider: ProviderPort; readonly model: string; readonly now: () => string;
  /** Host configuration identity only; provider requests retain the original model string. */
  readonly modelRef?: string;
  readonly emit: ExperienceRuntimeOptions["emit"];
  readonly claimReview?: () => boolean;
  readonly contextForIssue?: CentralLearningContextReader;
}): PersonalAgentFocusedLearning & { dispatchFunded(input: ManagedMethodReview, signal: AbortSignal): ReturnType<PersonalAgentFocusedLearning["resume"]> } {
  const store = createExperienceStore(options.boardRoot, options.now), archive = createMethodBoardWriter(options.boardRoot);
  const base: ExperienceRuntimeOptions = { store, emit: options.emit,
    correct: (id, outcome, reason, application) => correctExperience(options.boardRoot, archive, options.now, id, outcome, reason, application),
    revise: (versionId, hint) => reviseExperience(archive, options.now, versionId, hint) };
  const send = async (action: CoordinationAction) => withBoardWriter(options.boardRoot, board => board.apply({
    type: "coordinate_learning", commandId: `method-focus:${contentHashOf(action)}`, issuedAt: options.now(), action }));
  const run = async (intent: FocusIntent, signal: AbortSignal) => {
    const input = intent.kind === "focus" ? intent.input : undefined;
    const managed = intent.kind === "managed" ? intent.binding : undefined;
    const selectedIssueId = input?.issueId ?? managed?.issueId;

    if (signal.aborted) return failure("learning_aborted");

    const recovered = await recoverExpiredMethodLearning({ ...options, runtime: base }, signal, selectedIssueId);
    if (!recovered.ok) return failure(recovered.reason);

    const loaded = await createBoardReader(options.boardRoot).load();
    if (!loaded.ok) return failure(loaded.reason);

    const view = experienceViewOf(loaded.state);
    const issue = loaded.state.learningIssues?.find(item => (item.scope === options.scope || item.scope === options.workspaceId) && methodTarget(item) !== undefined
      && (selectedIssueId === undefined ? item.decision.kind === "focused_learning" && loaded.state.jobs.some(job => job.jobId === item.jobId && job.state === "queued")
        && pendingExperienceReview(base, view, methodTarget(item)!) !== undefined : item.issueId === selectedIssueId));
    if (issue === undefined) return selectedIssueId === undefined ? idle() : failure("method_focus_source_unavailable");

    if (input !== undefined && input.expectedRevision !== issue.revision) return failure("learning_issue_conflict");

    if (managed !== undefined && managed.expectedIssueRevision !== issue.revision) return failure("learning_issue_conflict");

    const material = managed === undefined ? await readCentralStageContext(options.contextForIssue, issue.issueId)
      : await readPreparedCentralStageContext({ boardRoot: options.boardRoot, scope: options.scope, input: managed,
        ...(options.contextForIssue === undefined ? {} : { reader: options.contextForIssue }) });
    if (material.status !== "ready") return failure(material.reason);

    const centralSourceContext = material.context;
    const runtime = centralSourceContext === undefined ? base : { ...base, centralSourceContext };
    const target = methodTarget(issue)!;
    const identity = methodFundingIdentity(loaded.state.centralLearningGrants ?? [], options.workspaceId, options.scope, target);
    if (!identity.ok) return failure(identity.reason);

    if (issue.issueId !== identity.issueId || issue.scope !== identity.scope) return failure("method_focus_source_unavailable");

    const grant = loaded.state.centralLearningGrants?.find(item => item.grantId === issue.grantId && item.domain === "prompt"
      && item.grantId === identity.grantId && item.issueId === issue.issueId && item.jobId === issue.jobId
      && item.scope === identity.scope && item.status === "open");
    if (grant === undefined) return failure("method_focus_existing_allowance_required");

    const request = pendingExperienceReview(runtime, view, target);
    if (managed === undefined && request !== undefined && grant.reservations.some(item =>
      item.reservationId === shortId("method-review", [request.snapshotId, options.model]))) {
      return { ok: true as const, status: "waiting_dependency" as const, issueId: issue.issueId, grantId: grant.grantId, jobId: grant.jobId };
    }

    if (managed !== undefined) {
      if (request === undefined) return failure("method_managed_stage_no_longer_ready");

      if (grant.reservations.some(item => item.reservationId === shortId("method-review", [request.snapshotId, options.model]))) {
        return failure("method_managed_stage_already_attempted");
      }

      const stage = methodCentralStageIdentity(request, options.model, options.modelRef);
      if (grant.budgetId === undefined || grant.grantId !== managed.grantId || issue.decision.kind !== "focused_learning"
        || grant.focusRevision !== issue.decision.revision || managed.stageRef !== stage.stageRef
        || managed.policyRef !== stage.policyRef || managed.sourceBindingRef !== stage.sourceBindingRef
        || managed.offer.owner.plane !== "agent" || managed.offer.owner.domain !== "prompt"
        || managed.offer.policyRef !== stage.policyRef || managed.offer.reserve.calls !== 1 || managed.offer.reserve.steps !== 1) {
        return failure("method_managed_stage_binding");
      }
    }

    const job = loaded.state.jobs.find(item => item.jobId === grant.jobId);
    if (job?.state === "running") return { ok: true as const, status: "busy" as const, issueId: issue.issueId, jobId: job.jobId };

    if (job?.state !== "queued") return idle();

    if (request === undefined) return idle();

    const remaining = centralLearningRemaining(grant);
    if (remaining.calls < 1 || remaining.steps < 1 || remaining.tokens < 512) return failure("method_review_budget_exhausted");

    if (options.claimReview?.() === false) return idle();

    if (input !== undefined) {
      const decided = await send({ kind: "decide", ...input, decision: "focused_learning" });
      if (!decided.ok) return failure(decided.reason);
    }

    const claimId = `method-pa-claim:${contentHashOf([grant.grantId, options.turnId, job.attempt + 1])}`;
    const claim: CoordinationAction = { kind: "claim", jobId: job.jobId, expectedAttempt: job.attempt, claimId,
      ownerId: `method:${options.turnId}`, expiresAt: new Date(Date.parse(options.now()) + 120000).toISOString(),
      ...(managed === undefined ? {} : { expectedIssueRevision: managed.expectedIssueRevision }) };
    const claimed = managed === undefined ? await send(claim) : await withBoardWriter(options.boardRoot, async board => {
      const current = await board.load();
      if (!current.ok) return failure(current.reason);

      const contextAtClaim = managed.sourceContext === undefined ? await options.contextForIssue?.(issue.issueId) : centralSourceContext;
      const runtimeAtClaim = contextAtClaim === undefined ? base : { ...base, centralSourceContext: contextAtClaim };
      const requestAtClaim = pendingExperienceReview(runtimeAtClaim, experienceViewOf(current.state), target);

      if (signal.aborted) return failure("learning_aborted");

      if (requestAtClaim === undefined || methodCentralStageIdentity(requestAtClaim, options.model, options.modelRef).stageRef !== managed.stageRef) {
        return failure("method_managed_stage_no_longer_ready");
      }

      return board.apply({ type: "coordinate_learning", commandId: `method-focus:${contentHashOf(claim)}`,
        issuedAt: options.now(), action: claim });
    });
    if (!claimed.ok) return failure(claimed.reason);

    const model = createExperienceModel({ provider: options.provider, model: options.model, turnId: options.turnId,
      fundingFor: request => createExperienceFunding({ boardRoot: options.boardRoot, workspaceId: options.workspaceId,
        centralScope: options.scope, turnId: options.turnId, now: options.now, request, enabled: () => !signal.aborted,
        binding: { grantId: grant.grantId, claimId, ...(managed === undefined ? {} : { envelope: {
          schemaVersion: 2 as const, unit: "total_model_tokens" as const, maxTokens: managed.offer.reserve.tokens,
          maxCalls: managed.offer.reserve.calls, maxSteps: managed.offer.reserve.steps, maxPromptChars: managed.offer.maxPromptChars } }) } }) });

    try {
      await reviewExperiences({ ...runtime, model }, view, signal, target);
      const after = await store.load();
      const reviewed = after.facts.some(fact => fact.kind === "review" && fact.sequence > view.sequence
        && fact.versionId === target.versionId && fact.scopeId === target.scopeId);
      const resultRefs = after.facts.filter(fact => fact.sequence > view.sequence && fact.versionId === target.versionId).map(fact => fact.factId);
      const result = { kind: "yielded" as const, reason: signal.aborted ? "learning_aborted"
        : reviewed ? "method_focused_review_settled" : "method_focused_review_deferred" };
      const finished = await send({ kind: "finish", jobId: job.jobId, claimId, result });

      return finished.ok ? { ok: true as const, workAttempted: true as const,
        status: signal.aborted ? "cancelled" as const : reviewed ? "completed" as const : "idle" as const,
        issueId: issue.issueId, grantId: grant.grantId, jobId: job.jobId,
        ...(reviewed ? { result: { kind: "completed" as const, resultRefs } } : {}) } : attemptedFailure(finished.reason);
    } catch {
      // Model failures consume their exact reservation, not the other future
      // reviews in this lifetime purse. Unknown usage and snapshot dedupe stay
      // in the central grant. A proven overrun may already have closed it.
      const after = await createBoardReader(options.boardRoot).load();
      if (!after.ok) return attemptedFailure(after.reason);

      if (after.state.centralLearningGrants?.find(item => item.grantId === grant.grantId)?.status === "closed") {
        return attemptedFailure("method_focused_review_failed");
      }

      const finished = await send({ kind: "finish", jobId: job.jobId, claimId,
        result: { kind: "yielded", reason: "method_focused_review_failed" } });

      return attemptedFailure(finished.ok ? "method_focused_review_failed" : finished.reason);
    }
  };

  return { focus: (input, signal) => run({ kind: "focus", input }, signal), resume: signal => run({ kind: "resume" }, signal),
    dispatchFunded: (binding, signal) => run({ kind: "managed", binding }, signal) };
}

const failure = (reason: string) => ({ ok: false as const, reason });
const attemptedFailure = (reason: string) => ({ ...failure(reason), workAttempted: true as const });
const idle = () => ({ ok: true as const, status: "idle" as const });
