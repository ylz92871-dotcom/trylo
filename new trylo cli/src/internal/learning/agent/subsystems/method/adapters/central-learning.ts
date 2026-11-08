import { createBoardReader } from "../../../../../adapters/learning-store/file-event-store.js";
import type { CentralLearningAllowance, CentralLearningGrantAllowance } from "../../../../control/coordination-contract.js";
import { centralLearningSpent } from "../../../../control/coordination-contract.js";
import { isCentralLearningAllowance, isCentralLearningGrantAllowance } from "../../../../control/coordination-parse.js";
import { contentHashOf } from "../../../../control/hash.js";
import { pendingExperienceReview } from "../orchestration/experience-review.js";
import type { ExperienceRuntimeOptions } from "../orchestration/experience-runtime.js";
import { createExperienceStore, experienceViewOf } from "./experience-store.js";
import { createMethodBoardWriter } from "./board-writer.js";
import { correctExperience } from "./experience-correction.js";
import { reviseExperience } from "./experience-revision.js";
import { createMethodFocusedLearning } from "./focused-learning.js";
import { methodFundingIdentity } from "./funding-identity.js";
import { methodCentralCondition, methodCentralPolicyFamilyRef, methodCentralStageIdentity, methodFocusedTarget } from "./central-source.js";
import { prepareExperienceReviewEnvelope } from "./review-envelope.js";
import { EXPERIENCE_MODEL_LIMITS } from "./experience-budget.js";
import { observeMethodCentralStage } from "./central-observation.js";
import { nominateMethodExperienceSource } from "./experience-funding.js";
import { scopesOf } from "../domain/experience-state.js";
import { shortId } from "../../../../domains/shared/hash.js";
import { recoverExpiredMethodLearning } from "./expired-recovery.js";
import { readCentralStageContext } from "../../../../../integration/central-learning/source-context.js";

type Options = Parameters<typeof createMethodFocusedLearning>[0] & { readonly authorized: () => boolean };

/** Preparation performs provider-free expired-owner maintenance before reading
 * the source. The host re-reads its Board basis after these original recovery writes.
 */
export function createMethodCentralLearning(options: Options) {
  const store = createExperienceStore(options.boardRoot, options.now), archive = createMethodBoardWriter(options.boardRoot);
  const runtime: ExperienceRuntimeOptions = { store, emit: options.emit,
    correct: (id, outcome, reason, application) => correctExperience(options.boardRoot, archive, options.now, id, outcome, reason, application),
    revise: (versionId, hint) => reviseExperience(archive, options.now, versionId, hint) };
  const worker = createMethodFocusedLearning(options);
  const recover = (signal: AbortSignal, issueId?: string) => options.authorized()
    ? recoverExpiredMethodLearning({ ...options, runtime }, signal, issueId)
    : Promise.resolve({ ok: false as const, reason: "method_learning_authorization_required" });

  return {
    recover,
    async nominate(signal: AbortSignal): Promise<readonly string[]> {
      if (signal.aborted || !options.authorized()) return [];

      const recovered = await recover(signal);
      if (!recovered.ok) throw new Error(`method_nomination:${recovered.reason}`);

      const loaded = await createBoardReader(options.boardRoot).load();
      if (!loaded.ok) throw new Error(`method_nomination:${loaded.reason}`);

      const view = experienceViewOf(loaded.state), issueIds: string[] = [];

      for (const scope of scopesOf(view)) {
        if (signal.aborted) break;

        const request = pendingExperienceReview(runtime, view, { versionId: scope.versionId, scopeId: scope.hypothesis.scopeId });
        if (request === undefined) continue;

        const nominated = await nominateMethodExperienceSource({ boardRoot: options.boardRoot, workspaceId: options.workspaceId,
          centralScope: options.scope, turnId: options.turnId, now: options.now, request, enabled: () => !signal.aborted && options.authorized() });
        if (!nominated.ok || !("issueId" in nominated)) throw new Error(`method_nomination:${nominated.ok ? "source_missing" : nominated.reason}`);

        issueIds.push(nominated.issueId);
      }

      return [...new Set(issueIds)];
    },
    async prepare(input: { readonly issueId: string; readonly authorizedAllowance: CentralLearningGrantAllowance;
      readonly operationAllowance?: CentralLearningAllowance }, signal: AbortSignal) {
      const unavailable = (reason: string) => ({ status: "unavailable" as const, reason, sourceRefs: [input.issueId] });
      const waiting = (reason: string) => ({ status: "waiting" as const, reason, sourceRefs: [input.issueId] });
      const terminal = (reason: string) => ({ status: "terminal" as const, reason, sourceRefs: [input.issueId] });

      if (signal.aborted) return unavailable("learning_aborted");

      if (!options.authorized()) return unavailable("method_learning_authorization_required");

      if (!isCentralLearningGrantAllowance(input.authorizedAllowance)
        || !isCentralLearningAllowance(input.operationAllowance ?? input.authorizedAllowance)) return unavailable("method_authorized_allowance_invalid");

      const operation = input.operationAllowance ?? input.authorizedAllowance;
      const recovered = await recover(signal, input.issueId);
      if (!recovered.ok) return unavailable(recovered.reason);

      const loaded = await createBoardReader(options.boardRoot).load();
      if (!loaded.ok) return unavailable(loaded.reason);

      const issue = loaded.state.learningIssues?.find(item => item.issueId === input.issueId && item.scope === options.scope);
      const target = issue === undefined ? undefined : methodFocusedTarget(issue);
      if (issue === undefined || target === undefined) return unavailable("method_focus_source_unavailable");

      if (issue.decision.kind !== "focused_learning") return unavailable("learning_issue_not_focused");

      const selected = methodFundingIdentity(loaded.state.centralLearningGrants ?? [], options.workspaceId, options.scope, target);
      if (!selected.ok) return unavailable(selected.reason);

      if (selected.issueId !== issue.issueId || selected.scope !== options.scope) return unavailable("method_legacy_grant_uses_original_owner");

      const grant = loaded.state.centralLearningGrants?.find(item => item.grantId === selected.grantId);
      const job = loaded.state.jobs.find(item => item.jobId === grant?.jobId);

      if (grant !== undefined && grant.budgetId === undefined) return unavailable("method_original_grant_is_independent");

      if (grant?.status === "closed") return terminal("method_original_lifetime_grant_closed");

      if (grant?.claim !== undefined || grant?.reservations.some(item => item.state === "reserved") || job?.state === "running") {
        return waiting("method_original_worker_in_flight");
      }

      const material = await readCentralStageContext(options.contextForIssue, issue.issueId);
      if (material.status !== "ready") return unavailable(material.reason);

      const centralSourceContext = material.context;
      const sourceRuntime = centralSourceContext === undefined ? runtime : { ...runtime, centralSourceContext };
      const request = pendingExperienceReview(sourceRuntime, experienceViewOf(loaded.state), target);
      if (request === undefined) return waiting("method_new_qualified_snapshot_required");

      if (grant?.reservations.some(item => item.reservationId === shortId("method-review", [request.snapshotId, options.model]))) {
        return waiting("method_snapshot_already_attempted");
      }

      const spent = grant === undefined ? { tokens: 0, calls: 0, steps: 0 } : centralLearningSpent(grant);
      const authorized = input.authorizedAllowance;
      const available = { tokens: Math.min(authorized.maxTokens - spent.tokens, operation.maxTokens),
        calls: Math.min(authorized.maxCalls - spent.calls, operation.maxCalls), steps: Math.min(authorized.maxSteps - spent.steps, operation.maxSteps) };
      const maxPromptChars = Math.min(grant?.allowance.maxPromptChars ?? authorized.maxPromptChars,
        authorized.maxPromptChars, operation.maxPromptChars, EXPERIENCE_MODEL_LIMITS.promptChars);
      const envelope = prepareExperienceReviewEnvelope(request, available, maxPromptChars);
      if (!envelope.ok) return unavailable(envelope.reason);

      const stage = methodCentralStageIdentity(request, options.model, options.modelRef);
      const policyFamilyRef = methodCentralPolicyFamilyRef(options.model, options.modelRef);
      const condition = methodCentralCondition(request);
      const offer = { offerId: `method-offer:${contentHashOf({ stage: stage.stageRef, tokens: envelope.maxTokens, maxPromptChars })}`,
        owner: { plane: "agent" as const, domain: "prompt" as const }, policyRef: stage.policyRef,
        reserve: { tokens: envelope.maxTokens, calls: 1, steps: 1 }, maxPromptChars };
      const report = issue.reports.find(item => "subsystem" in item.source && item.source.subsystem === "method")!;

      if (signal.aborted) return unavailable("learning_aborted");

      return { status: "ready" as const, stageRef: stage.stageRef, policyRef: stage.policyRef, offer, authorizedAllowance: authorized,
        ...(centralSourceContext === undefined ? {} : { sourceContext: centralSourceContext }),
        policyFamily: { ref: policyFamilyRef, sourceRef: policyFamilyRef, response: "shared_or_exact_treatment" as const },
        ...(condition === undefined ? {} : { condition }),
        source: { issueId: issue.issueId, grantId: selected.grantId, sourceBindingRef: stage.sourceBindingRef,
          domainStage: { stageRef: stage.stageRef, policyRef: stage.policyRef,
            kind: grant === undefined || grant.reservations.length === 0 ? "initial" as const : "continuation" as const,
            sourceReportId: report.reportId, readiness: { kind: "ready" as const, evidenceRefs: [request.snapshotId] } } } };
    },
    dispatch: (input: Parameters<typeof worker.dispatchFunded>[0], signal: AbortSignal) => !options.authorized()
      ? Promise.resolve({ ok: false as const, reason: "method_learning_authorization_required" }) : worker.dispatchFunded(input, signal),
    observe: (input: Parameters<typeof worker.dispatchFunded>[0], signal: AbortSignal) => observeMethodCentralStage(options, input, signal),
  };
}
