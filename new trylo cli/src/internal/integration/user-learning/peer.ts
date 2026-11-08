import { shortId } from "../../learning/domains/shared/hash.js";
import { fingerprintScopeV2 } from "../../learning/domains/user/scope-v2.js";
import type { LedgerPort, UserLearningRecord } from "../../learning/domains/user/scheduler-ports.js";
import type { UserLearningProgress, UserLearningSignal, UserPeerProgress } from "../../learning/domains/user/learning-cycle-contract.js";
import { buildSemanticUserVersion } from "../../learning/domains/user/semantic-version.js";
import { userSourcePrefix } from "./learned-policy.js";
import { runUserSemanticModel, type UserSemanticModelDeps } from "./semantic-model.js";
import { projectUserOperationBudget, userOperationCallIdentity } from "./operation-budget.js";
import { userModelFailure } from "./model-failure.js";
import { isAcknowledgedUserLocalTimeout, userLocalTimeoutCheckpoint } from "./local-timeout-recovery.js";

export type UserLearningPeerDeps = UserSemanticModelDeps & { readonly ledger: LedgerPort; readonly userId: string;
  readonly workspaceId: string; readonly fundingOwnerId: string; readonly now: () => number };

export function createUserLearningPeer(deps: UserLearningPeerDeps) {
  const scopeFingerprint = fingerprintScopeV2({ userId: deps.userId, workspaceId: deps.workspaceId });
  const questionRef = shortId("user-question", [scopeFingerprint]);
  const ledgerRef = shortId("user-ledger", [scopeFingerprint]);

  function source() {
    if (!deps.enabled()) return { ok: false as const, reason: "collect_disabled" };

    const read = deps.ledger.read();
    if (!read.ok || read.unreadable > 0) return { ok: false as const, reason: read.ok ? "user_ledger_unreadable" : read.reason };

    const allEvidence = read.records.filter(item => item.record === "evidence")
      .map(item => item.evidence).filter(item => item.source.workspaceId === deps.workspaceId);
    // This is a local semantic update, not an instruction to rewrite all stored knowledge.
    // Old policy provenance remains in its immutable version and is carried forward below.
    const versions = read.records.filter(item => item.record === "learning_version").map(item => item.version)
      .filter(item => item.scopeFingerprint === scopeFingerprint);
    const progress = read.records.filter(item => item.record === "learning_progress").map(item => item.progress)
      .filter(item => item.questionRef === questionRef).at(-1);
    const hasScopeHistory = versions.length > 0 || progress !== undefined || read.records.some(item =>
      item.record === "policy_feedback" ? item.feedback.scopeFingerprint === scopeFingerprint
        : item.record === "policy_fielding" && item.fielding.scopeFingerprint === scopeFingerprint);
    const consumed = new Set(progress?.consumedEvidenceIds ?? []);
    const pending = allEvidence.filter(item => !consumed.has(item.id));
    const evidence = pending.length === 0 ? allEvidence.slice(-32) : pending.slice(0, 32);

    return { ok: true as const, records: read.records, evidence, pendingCount: pending.length, previous: versions.at(-1), progress, hasScopeHistory,
      sourcePrefixRef: userSourcePrefix(read.records, deps.workspaceId) };
  }

  function output(state: UserPeerProgress["state"], reason: string, prefix: string, progress?: UserLearningProgress,
    boundary: Pick<UserPeerProgress, "outcome" | "waitFor" | "waitRefs"> = {}): UserPeerProgress {
    const waitFor = boundary.waitFor ?? (state === "waiting" && progress?.state === "clarification" ? "user_clarification"
      : state === "waiting" && progress?.state === "no_result" ? "source_change"
        : progress?.state === "unknown" ? "recovery" : undefined);
    const outcome = boundary.outcome ?? (progress?.state === "unknown" ? "unknown" : undefined);
    const waitRefs = boundary.waitRefs ?? (progress?.state === "unknown" ? progress.committedReservationIds : undefined);

    return { owner: "user_learning", questionRef, sourcePrefixRef: prefix, state, reason,
      versionRefs: progress?.versionId === undefined ? [] : [progress.versionId],
      ...(progress === undefined ? {} : { progressRef: shortId("user-progress", [questionRef, prefix, String(progress.step)]) }),
      ...(waitFor === undefined ? {} : { waitFor }),
      ...(outcome === undefined ? {} : { outcome }),
      ...(waitRefs === undefined ? {} : { waitRefs }),
      ...(progress?.clarification === undefined ? {} : { clarificationRef: shortId("user-clarification", [questionRef, prefix, String(progress.step)]) }) };
  }

  function inspect() {
    const current = source();
    return current.ok ? { ok: true as const, ledgerRef, questionRef, sourcePrefixRef: current.sourcePrefixRef,
      hasScopeHistory: current.hasScopeHistory,
      hasEvidence: current.evidence.length > 0, policyRefs: current.previous === undefined ? [] : [current.previous.versionId],
      needsLearning: current.evidence.length > 0 && (current.progress === undefined
        || current.progress.sourcePrefixRef !== current.sourcePrefixRef || current.progress.state === "continue" || current.progress.state === "unknown"),
      progress: current.progress === undefined ? undefined : output(current.progress.state === "continue" ? "progress"
        : current.progress.state === "completed" ? "result" : "waiting", current.progress.state, current.sourcePrefixRef, current.progress) } : current;
  }

  async function advance(input: UserLearningSignal, signal: AbortSignal): Promise<UserPeerProgress> {
    let current = source();
    if (!current.ok) return output("unavailable", current.reason, input.sourcePrefixRef);

    if (input.questionRef !== questionRef || input.sourcePrefixRef !== current.sourcePrefixRef) return output("unavailable", "user_source_prefix_stale", current.sourcePrefixRef);

    if (!Number.isSafeInteger(input.maxCalls) || input.maxCalls < 1 || input.maxCalls > 32
      || !Number.isSafeInteger(input.maxTokensPerCall) || input.maxTokensPerCall < 256) return output("unavailable", "user_allowance_invalid", current.sourcePrefixRef);

    if (current.evidence.length === 0) return output("waiting", "user_evidence_missing", current.sourcePrefixRef, undefined, { waitFor: "source_change" });

    if (input.reconsiderVersionRef !== undefined && input.reconsiderVersionRef !== current.previous?.versionId) {
      return output("unavailable", "user_reconsider_version_stale", current.sourcePrefixRef, current.progress);
    }

    if (input.reconsiderVersionRef === undefined && current.progress?.sourcePrefixRef === current.sourcePrefixRef && current.progress.state !== "continue") {
      const funded = current.progress.state === "unknown" ? await deps.funding.inspect() : undefined;
      if (!funded?.ok || !isAcknowledgedUserLocalTimeout(current.progress, funded.projection.budget.accounting ?? [], deps.fundingOwnerId)) {
        return output(current.progress.state === "completed" ? "result" : "waiting", current.progress.state, current.sourcePrefixRef, current.progress);
      }
    }

    const maxTotalTokens = input.maxTotalTokens ?? input.maxTokensPerCall * input.maxCalls;
    const operationRef = input.operationRef ?? shortId("user-operation", [questionRef, input.sourcePrefixRef, input.purpose]);

    if (!Number.isSafeInteger(maxTotalTokens) || maxTotalTokens < 256) return output("unavailable", "user_allowance_invalid", current.sourcePrefixRef);

    for (let call = 0; call < input.maxCalls; call += 1) {
      if (signal.aborted || !deps.enabled()) return output("waiting", "collect_disabled_or_cancelled", current.sourcePrefixRef, current.progress);

      const step = (current.progress?.step ?? 0) + 1;
      const identity = userOperationCallIdentity({ operationRef, questionRef, sourcePrefixRef: current.sourcePrefixRef,
        step, nextAction: current.progress?.nextAction ?? input.purpose });
      const funded = await deps.funding.inspect();
      if (!funded.ok) return output("waiting", funded.reason, current.sourcePrefixRef, current.progress, userModelFailure(funded.reason));

      if (funded.projection.status === "held") return output("waiting", "learning_budget_held", current.sourcePrefixRef, current.progress,
        { waitFor: "budget", waitRefs: [funded.projection.budget.budgetId] });

      const budget = projectUserOperationBudget({ reservations: funded.projection.budget.accounting ?? [], ownerId: deps.fundingOwnerId,
        operationRef, maxTotalTokens, maxCalls: input.maxCalls, logicalCall: identity });
      if (budget.hasLogicalCallReservation) return output("waiting", "user_learning_request_already_reserved", current.sourcePrefixRef, current.progress,
        userModelFailure("user_learning_request_already_reserved", [identity.reservationId]));

      if (budget.remaining.calls < 1 || budget.remaining.tokens < 256) return output("progress", "user_learning_allowance_boundary", current.sourcePrefixRef, current.progress,
        { waitFor: "budget", waitRefs: [funded.projection.budget.budgetId, operationRef] });

      const sourceRecords = current.records;
      const response = await runUserSemanticModel(deps, { reservationId: identity.reservationId, expectedSequence: funded.boardSequence, purpose: input.purpose, evidence: current.evidence,
        ...(input.reconsiderVersionRef === undefined ? {} : { reconsiderVersionRef: input.reconsiderVersionRef }),
        feedback: sourceRecords.filter(item => item.record === "policy_feedback")
          .filter(item => item.feedback.scopeFingerprint === scopeFingerprint).slice(-32).map(item => ({ ...item,
            sourceEvidence: sourceRecords.find(record => record.record === "evidence"
              && record.evidence.source.workspaceId === deps.workspaceId && record.evidence.id === item.feedback.sourceEvidenceId) })),
        ...(current.previous === undefined ? {} : { previous: current.previous }),
        ...(current.progress === undefined ? {} : { progress: current.progress }), maxTokens: Math.min(input.maxTokensPerCall, budget.remaining.tokens),
        ...(input.maxPromptChars === undefined ? {} : { maxPromptChars: input.maxPromptChars }) }, signal);
      if (!response.ok) return (response.reason === "content_model_timeout" ? await recoverLocalTimeout(input) : undefined)
        ?? output("waiting", response.reason, current.sourcePrefixRef, current.progress, response);

      // A model result may only commit against the source prefix it actually observed.
      const beforeCommit = source();
      if (!beforeCommit.ok) return output("unavailable", beforeCommit.reason, current.sourcePrefixRef);

      if (beforeCommit.sourcePrefixRef !== current.sourcePrefixRef) {
        return output("progress", "user_source_changed_before_commit", beforeCommit.sourcePrefixRef, beforeCommit.progress);
      }

      const at = deps.now();
      const materialRemaining = current.pendingCount > current.evidence.length;
      const semanticDraft = materialRemaining && (response.draft.progress.state === "completed" || response.draft.progress.state === "no_result") ? { ...response.draft,
        progress: { ...response.draft.progress, state: "continue" as const, nextAction: "读取未消费的原用户事件页，比较其条件和反例" } } : response.draft;
      const version = buildSemanticUserVersion({ draft: semanticDraft, evidence: current.evidence, userId: deps.userId,
        scopeFingerprint, questionRef, sourcePrefixRef: current.sourcePrefixRef,
        ...(current.previous === undefined ? {} : { previous: current.previous }), now: at });
      const repeated = current.progress?.sourcePrefixRef === current.sourcePrefixRef
        && response.draft.progress.nextAction === current.progress.nextAction && response.draft.progress.understanding === current.progress.understanding;
      const { clarification, ...semanticProgress } = semanticDraft.progress;
      const progress: UserLearningProgress = { schemaVersion: 1, questionRef, sourcePrefixRef: current.sourcePrefixRef, scopeFingerprint, step,
        workRef: operationRef, ...semanticProgress,
        state: repeated && !materialRemaining && semanticDraft.progress.state === "continue" ? "no_result" : semanticDraft.progress.state,
        consumedEvidenceIds: [...new Set([...(current.progress?.consumedEvidenceIds ?? []), ...current.evidence.map(item => item.id)])],
        committedReservationIds: [...(current.progress?.workRef === operationRef ? current.progress.committedReservationIds ?? [] : []), identity.reservationId],
        ...(clarification === null ? {} : { clarification }),
        versionId: version.versionId, at };
      const records: UserLearningRecord[] = [
        ...(current.previous?.versionId === version.versionId ? [] : [{ record: "learning_version" as const, version }]),
        { record: "learning_progress", progress }];
      const written = deps.ledger.append(records);
      if (!written.ok) return output("unavailable", written.reason, current.sourcePrefixRef);

      const loaded = source();
      if (!loaded.ok || loaded.progress?.step !== step || loaded.progress.versionId !== version.versionId) return output("unavailable", "user_learning_readback_failed", current.sourcePrefixRef);

      if (loaded.sourcePrefixRef !== input.sourcePrefixRef) return output("progress", "user_source_changed_at_handoff", loaded.sourcePrefixRef, progress);

      if (progress.state !== "continue") return output(progress.state === "completed" ? "result" : "waiting", progress.state, current.sourcePrefixRef, progress);

      current = loaded;
    }

    return output("progress", "user_learning_allowance_boundary", current.sourcePrefixRef, current.progress,
      { waitFor: "budget", waitRefs: [operationRef] });
  }

  async function recoverLocalTimeout(input: UserLearningSignal): Promise<UserPeerProgress | undefined> {
    const current = source();
    if (!current.ok || input.questionRef !== questionRef || input.sourcePrefixRef !== current.sourcePrefixRef) return undefined;

    const operationRef = input.operationRef ?? shortId("user-operation", [questionRef, input.sourcePrefixRef, input.purpose]);
    const funded = await deps.funding.inspect();
    if (!funded.ok) return undefined;

    const reservations = funded.projection.budget.accounting ?? [];
    if (current.progress?.workRef === operationRef && isAcknowledgedUserLocalTimeout(current.progress, reservations, deps.fundingOwnerId)) {
      return output("waiting", "content_model_timeout", current.sourcePrefixRef, current.progress);
    }

    const progress = userLocalTimeoutCheckpoint({ signal: input, operationRef, scopeFingerprint, reservations,
      ownerId: deps.fundingOwnerId, at: deps.now(), ...(current.progress === undefined ? {} : { progress: current.progress }) });
    if (progress === undefined) return undefined;

    const beforeCommit = source();
    if (!beforeCommit.ok || beforeCommit.sourcePrefixRef !== current.sourcePrefixRef
      || beforeCommit.progress?.step !== current.progress?.step) return undefined;

    const written = deps.ledger.append([{ record: "learning_progress", progress }]);
    if (!written.ok) return output("unavailable", written.reason, current.sourcePrefixRef);

    const loaded = source();
    if (!loaded.ok || loaded.progress?.step !== progress.step || loaded.progress.workRef !== operationRef
      || loaded.progress.committedReservationIds?.at(-1) !== progress.committedReservationIds?.at(-1)) {
      return output("unavailable", "user_learning_readback_failed", current.sourcePrefixRef);
    }

    return output("waiting", "content_model_timeout", current.sourcePrefixRef, loaded.progress);
  }

  return { inspect, advance, recoverLocalTimeout, async funding() { return deps.funding.inspect(); },

    acceptResearch(input: { readonly intentRef: string; readonly goal: string; readonly knowledge: readonly string[];
      readonly residual: readonly string[]; readonly operationRef: string; readonly purpose: string; readonly sourceRefs: readonly string[] }) {
      const state = inspect();
      if (!state.ok) return { status: "unavailable" as const, reason: state.reason };

      if (input.intentRef.length === 0 || input.sourceRefs.length === 0) return { status: "unavailable" as const, reason: "user_research_provenance_missing" };

      return { status: state.hasEvidence ? "accepted" as const : "waiting" as const,
        reason: state.hasEvidence ? "accepted_for_authentic_user_evidence_assessment" : "user_evidence_missing",
        ledgerRef, questionRef, sourcePrefixRef: state.sourcePrefixRef,
        // A central purpose guides the comparison; it never becomes User Evidence.
        purpose: JSON.stringify({ intentRef: input.intentRef, goal: input.goal, priorPublicKnowledge: input.knowledge,
          residual: input.residual, operationRef: input.operationRef, operationPurpose: input.purpose, centralSourceRefs: input.sourceRefs,
          authority: "Research purpose only. Infer user opinion exclusively from the original User evidence, or wait/ask." }) };
    },

    async operationStatus(input: UserLearningSignal): Promise<"unsent" | "unknown" | "stale" | "unavailable"> {
      const current = source();
      if (!current.ok) return "unavailable";

      const operationRef = input.operationRef ?? shortId("user-operation", [questionRef, input.sourcePrefixRef, input.purpose]);
      const identity = userOperationCallIdentity({ operationRef, questionRef, sourcePrefixRef: current.sourcePrefixRef,
        step: (current.progress?.step ?? 0) + 1, nextAction: current.progress?.nextAction ?? input.purpose });
      const funded = await deps.funding.inspect();
      if (!funded.ok) return "unavailable";

      const budget = projectUserOperationBudget({ reservations: funded.projection.budget.accounting ?? [], ownerId: deps.fundingOwnerId,
        operationRef, maxTotalTokens: input.maxTotalTokens ?? input.maxTokensPerCall * input.maxCalls, maxCalls: input.maxCalls, logicalCall: identity });
      const committed = new Set(current.records.filter(item => item.record === "learning_progress")
        .map(item => item.progress).filter(progress => progress.workRef === operationRef).flatMap(progress => progress.committedReservationIds ?? []));
      const uncommitted = (funded.projection.budget.accounting ?? []).some(item => item.owner.kind === "user_learning"
        && item.owner.ownerId === deps.fundingOwnerId && item.reservationId.startsWith(identity.namespace) && !committed.has(item.reservationId));
      if (uncommitted || !budget.hasOperationReservation && budget.hasLogicalCallReservation) return "unknown";

      if (input.questionRef !== questionRef || input.sourcePrefixRef !== current.sourcePrefixRef || budget.hasOperationReservation) return "stale";

      return "unsent";
    },

    async recoverBoundary(input: UserLearningSignal): Promise<UserPeerProgress | undefined> {
      const current = source();
      if (!current.ok) return undefined;

      const operationRef = input.operationRef ?? shortId("user-operation", [questionRef, input.sourcePrefixRef, input.purpose]);
      const progress = current.records.filter(item => item.record === "learning_progress").map(item => item.progress)
        .filter(item => item.workRef === operationRef).at(-1);
      if (progress?.state !== "continue") return undefined;

      const funded = await deps.funding.inspect();
      if (!funded.ok) return undefined;

      const budget = projectUserOperationBudget({ reservations: funded.projection.budget.accounting ?? [], ownerId: deps.fundingOwnerId,
        operationRef, maxTotalTokens: input.maxTotalTokens ?? input.maxTokensPerCall * input.maxCalls, maxCalls: input.maxCalls });
      if (funded.projection.status !== "held" && budget.remaining.calls >= 1 && budget.remaining.tokens >= 256) return undefined;

      return output("progress", "user_learning_allowance_boundary", current.sourcePrefixRef, progress,
        { waitFor: "budget", waitRefs: [funded.projection.budget.budgetId, operationRef] });
    },

    readClarification(ref: string): string | undefined {
      const current = source();
      if (!current.ok || current.progress === undefined) return undefined;
      const progress = output("waiting", current.progress.state, current.sourcePrefixRef, current.progress);
      return progress.clarificationRef === ref ? current.progress.clarification : undefined;
    },

    recover(workRef: string): UserPeerProgress | undefined {
      const current = source();
      if (!current.ok) return undefined;

      const progress = current.records.filter(item => item.record === "learning_progress")
        .map(item => item.progress).filter(progress => progress.workRef === workRef).at(-1);
      if (progress === undefined) return undefined;

      return output(progress.state === "continue" ? "progress" : progress.state === "completed" ? "result" : "waiting",
        progress.state, progress.sourcePrefixRef, progress);
    } };
}

export type UserLearningPeer = ReturnType<typeof createUserLearningPeer>;
