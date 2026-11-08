import { contentHashOf } from "../../../../control/hash.js";
import type { CollaborationCentralWorker } from "../control/contracts.js";
import { publishCollaborationArtifact, type CollaborationArtifactOptions } from "../artifacts/publish.js";
import type { CollaborationDecisionPort, CollaborationPlan, CollaborationResourcePort, CollaborationExperiencePublicationPorts, CollaborationResearchRecoveryPort } from "./contracts.js";
import { LEARNING_RESPONSE_FAILURE } from "./contracts.js";
import { preflightCollaborationProposal, type ProposalValidationFeedback } from "./proposal-preflight.js";
import { recordCollaborationNoChange } from "./no-change-receipt.js";

export type CollaborationWorkerOptions = CollaborationArtifactOptions & CollaborationExperiencePublicationPorts & {
  readonly model: CollaborationDecisionPort; readonly resources: CollaborationResourcePort;
  readonly context: (issueId: string) => Promise<unknown>;
  readonly recoverResearch?: CollaborationResearchRecoveryPort;
  /** Authorized dependency construction runs inside this same claim and budget. */
  readonly prepareDependencies?: (input: Parameters<CollaborationCentralWorker["run"]>[0]) => Promise<
    { readonly ok: true; readonly resultRefs: readonly string[] } | { readonly ok: false; readonly reason: string }>;
};

/** One bounded, centrally funded loop. It can propose coordination, never schedule business members or approve creation. */
export function createCollaborationWorker(options: CollaborationWorkerOptions): CollaborationCentralWorker {
  return { async run(input) {
    const admitted = await input.funding.inspect();
    if (!admitted.ok || !admitted.active || input.signal.aborted || input.issue.decision.kind !== "focused_learning") {
      return { kind: "cancelled", reason: "learning_inactive" };
    }

    let recovered: Awaited<ReturnType<CollaborationResearchRecoveryPort>>;

    try {
      recovered = options.recoverResearch === undefined ? { ok: true, observations: [], sourceRefs: [] }
        : await options.recoverResearch({ issueId: input.issue.issueId, jobId: input.jobId, grantId: input.grantId });
    } catch { return { kind: "failed", reason: "learning_research_recovery_unavailable" }; }

    if (!recovered.ok) return { kind: "failed", reason: recovered.reason };

    const stillActive = await input.funding.inspect();
    if (!stillActive.ok || !stillActive.active || input.signal.aborted) return { kind: "cancelled", reason: "learning_inactive" };

    const prepared = await options.prepareDependencies?.(input);
    if (prepared && !prepared.ok) return { kind: "failed", reason: prepared.reason };

    if (prepared?.resultRefs.length) {
      const budget = await input.funding.inspect();
      if (!budget.ok) return { kind: "failed", reason: budget.reason };
      if (budget.remaining.calls === 0 || budget.remaining.steps === 0 || budget.remaining.tokens === 0) {
        return { kind: "completed", resultRefs: prepared.resultRefs };
      }
    }

    const observations: unknown[] = [...recovered.observations];
    // Proposals may cite only evidence already known to this funded claim.
    const readyDependencyRefs = input.dependencies.flatMap(dependency => dependency.state.kind === "ready"
      ? [dependency.dependencyId, dependency.state.resultRef] : []);
    const knownRefs = new Set([...input.issue.reports.flatMap(r => [r.reportId, ...r.evidenceRefs]),
      ...recovered.sourceRefs, ...readyDependencyRefs, ...(prepared?.resultRefs ?? [])]);
    const context = await options.context(input.issue.issueId);

    if (prepared?.resultRefs.length) observations.push({ authorizedDependencies: prepared.resultRefs });

    const active = async () => {
      const result = await input.funding.inspect();
      return result.ok && result.active && !input.signal.aborted;
    };
    const repair = async (feedback: ProposalValidationFeedback) => {
      const budget = await input.funding.inspect();
      if (!budget.ok) return { kind: "stop" as const, result: { kind: "failed" as const, reason: budget.reason } };

      if (!budget.active || input.signal.aborted) return { kind: "stop" as const, result: { kind: "cancelled" as const, reason: "learning_inactive" } };

      if (budget.remaining.calls < 1 || budget.remaining.steps < 1 || budget.remaining.tokens < 1) {
        return { kind: "stop" as const, result: { kind: "failed" as const, reason: feedback.reason } };
      }

      observations.push({ validationFeedback: feedback });
      return { kind: "retry" as const };
    };
    let confirmedQuery = false;

    for (let step = 0; step < Math.min(24, input.allowance.maxSteps * 3 + 3); step++) {
      if (!await active()) return { kind: "cancelled", reason: "learning_inactive" };

      confirmedQuery = false;
      const decision = await options.model.decide({ issue: input.issue, material: { context, observations,
        ...(input.centralSourceContext === undefined ? {} : { centralContent: input.centralSourceContext }) }, step,
        knownSourceRefs: [...knownRefs],
        jobId: input.jobId, claimId: input.claimId, funding: input.funding, maxPromptChars: input.allowance.maxPromptChars, signal: input.signal });
      if (!decision.ok) {
        if (decision.reason === "learning_budget_exhausted" || decision.reason === "learning_operation_exhausted") {
          return { kind: "yielded", reason: "collaboration_operation_budget_exhausted" };
        }

        if (decision.reason !== LEARNING_RESPONSE_FAILURE.action && decision.reason !== LEARNING_RESPONSE_FAILURE.json) {
          return { kind: "failed", reason: decision.reason };
        }

        const repaired = await repair({ reason: decision.reason, fields: ["response"], instruction: "按原schema重新生成" });
        if (repaired.kind === "stop") return repaired.result;

        continue;
      }

      if (decision.action.kind === "query") {
        const requestId = `collaboration-resource:${contentHashOf([input.claimId, step, decision.action])}`;
        const result = await options.resources.query({ issue: input.issue, jobId: input.jobId, grantId: input.grantId, requestId,
          owner: decision.action.owner, query: decision.action.query, signal: input.signal });

        observations.push({ requestId, ...decision.action, result });

        if (result.ok) for (const ref of result.sourceRefs) knownRefs.add(ref);

        confirmedQuery = result.ok;
        const budget = await input.funding.inspect();
        if (!budget.ok) return { kind: "failed", reason: budget.reason };

        if (confirmedQuery && (budget.remaining.tokens === 0 || budget.remaining.calls === 0 || budget.remaining.steps === 0)) {
          return { kind: "yielded", reason: "collaboration_operation_budget_exhausted" };
        }

        continue;
      }

      const action = decision.action;
      const admittedProposal = await preflightCollaborationProposal(options, { issueId: input.issue.issueId, action, knownRefs, active });
      if (admittedProposal.kind === "invalid") {
        const repaired = await repair(admittedProposal.feedback);
        if (repaired.kind === "stop") return repaired.result;
        continue;
      }

      if (admittedProposal.kind !== "ready") return admittedProposal;

      if (action.kind === "no_change") {
        if (!await active()) return { kind: "cancelled", reason: "learning_inactive" };
        const recorded = await recordCollaborationNoChange(options.board, options.scope, options.now(), {
          schema: "collaboration-no-change/v1", issueId: input.issue.issueId, jobId: input.jobId,
          grantId: input.grantId, claimId: input.claimId, reason: action.reason, sourceRefs: action.sourceRefs });
        return recorded.ok ? { kind: "completed", resultRefs: [recorded.receiptId] } : { kind: "failed", reason: recorded.reason };
      }

      const versionIds: string[] = [];

      for (const experience of admittedProposal.experiences) {
        if (!await active()) return { kind: "cancelled", reason: "learning_inactive" };
        // Publication errors may follow a committed IO operation. Never reinterpret them as a safe model-content retry.
        const published = await options.publishExperience(experience);
        if (!published.ok) return { kind: "failed", reason: published.reason };
        versionIds.push(published.versionId);
      }

      const plan: CollaborationPlan = { schema: "collaboration-plan/v1", issueId: input.issue.issueId,
        focusRevision: input.issue.decision.revision, familyId: action.familyId, title: action.title, summary: action.summary,
        sourceRefs: action.sourceRefs, adjustments: action.adjustments, experienceVersionIds: versionIds, needs: action.needs,
        ...(action.evaluation === undefined ? {} : { evaluation: action.evaluation }) };
      const published = await publishCollaborationArtifact({ ...options, canPublish: active }, {
        issueId: plan.issueId, familyId: plan.familyId, title: plan.title, hypothesis: plan.summary, sourceRefs: plan.sourceRefs,
        content: plan, schemaVersion: 3, kind: "plan" });
      if (!published.ok) return { kind: "failed", reason: published.reason };

      if (plan.needs.length === 0) return { kind: "completed", resultRefs: [published.versionId, ...versionIds] };

      return { kind: "waiting_dependency", dependencies: plan.needs.map((need, index) => ({
        dependencyId: `collaboration-dependency:${contentHashOf([input.jobId, published.versionId, index])}`,
        owner: need.owner, correlationRef: `${published.versionId}#need:${index}`,
        state: { kind: "waiting", reason: "personal_agent_creation_consent_required" } })) };
    }

    return confirmedQuery ? { kind: "yielded", reason: "collaboration_operation_step_limit" } : { kind: "failed", reason: "learning_step_limit" };
  } };
}
