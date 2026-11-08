import { admitContentEvidence } from "../contract/gateway.js";
import { canonicalJson } from "../../learning/control/hash.js";
import { selectSkillCandidate } from "./candidate.js";
import { completeSkillTrialJob, startSkillTrialJob } from "./trial-job.js";
import { applySkillCommand, applySkillFeedback, loadSkillBoard, prepareSkillTrial, SkillBoardError, skillCandidateScope } from "./board.js";
import type { SkillCandidate, SkillLearningDependencies, SkillLearningGrant, SkillLearningResult, SkillLearningUsage, SkillOpportunity, SkillTrialResult } from "./runtime-contract.js";

/** Standalone Learning Loop entry. No provider, production tools, or permission writer. */
export function createSkillLearningSubsystem(deps: SkillLearningDependencies): {
  learn(grant: SkillLearningGrant, signal?: AbortSignal): Promise<SkillLearningResult>;
} {
  let running = false;
  return {
    async learn(grant, signal = new AbortController().signal) {
      const usage = { episodes: 0, inputBytes: 0, evaluations: 0 };

      if (running) return result("waiting", "learning_already_running", usage);

      if (deps.collection() === "disabled") return result("disabled", "collection_disabled", usage);

      if (!validGrant(grant)) return result("failed", "invalid_allowance", usage);

      if (signal.aborted) return result("cancelled", "cancelled", usage);

      running = true;

      try {
        return await learnBounded({ ...deps, board: guardedSkillBoard(deps, signal) }, grant, signal, usage);
      } catch (error) {
        // Durable stages remain resumable; never claim a write was rolled back.
        return result(signal.aborted ? "cancelled" : deps.collection() === "disabled" ? "disabled" : "failed", error instanceof SkillBoardError ? error.code : "skill_runtime_unavailable", usage);
      } finally { running = false; }
    },
  };
}

async function learnBounded(deps: SkillLearningDependencies, grant: SkillLearningGrant, signal: AbortSignal,
  usage: { episodes: number; inputBytes: number; evaluations: number }): Promise<SkillLearningResult> {
  const opportunity = await deps.opportunity(signal);
  if (deps.collection() === "disabled" || opportunity.collection === "disabled") return result("disabled", "collection_disabled", usage);

  if (!opportunity.workspaceId || !opportunity.opportunityId) return result("failed", "unbound_opportunity", usage);

  if (signal.aborted) return result("cancelled", "cancelled", usage);

  const excluded = new Set<string>(), steps: SkillLearningResult[] = [];

  for (let cycle = 0; cycle < (grant.allowance.maxCycles ?? 1); cycle += 1) {
    if (signal.aborted || deps.collection() === "disabled") return { ...result(signal.aborted ? "cancelled" : "disabled", signal.aborted ? "cancelled" : "collection_disabled", usage), steps };

    const remaining: SkillLearningGrant = { subsystem: "skill", allowance: {
      maxEpisodes: grant.allowance.maxEpisodes - usage.episodes, maxInputBytes: grant.allowance.maxInputBytes - usage.inputBytes,
      maxEvaluations: grant.allowance.maxEvaluations - usage.evaluations,
    } };
    if (remaining.allowance.maxEpisodes < 3 || remaining.allowance.maxInputBytes < 1) break;

    const step = await learnOnce(deps, remaining, signal, usage, opportunity, excluded);

    steps.push(step);

    if (["cancelled", "disabled", "failed", "unchanged"].includes(step.status) || excluded.size === 0) break;
  }

  const meaningful = steps.filter(step => step.status !== "unchanged");
  const last = meaningful[meaningful.length - 1] ?? steps[steps.length - 1] ?? result("waiting", "allowance_exhausted", usage);

  return { ...last, usage: { ...usage }, steps: steps.map(({ status, reason, proposalId, versionId }) => ({ status, reason,
    ...(proposalId === undefined ? {} : { proposalId }), ...(versionId === undefined ? {} : { versionId }) })) };
}

async function learnOnce(deps: SkillLearningDependencies, grant: SkillLearningGrant, signal: AbortSignal,
  usage: { episodes: number; inputBytes: number; evaluations: number }, opportunity: SkillOpportunity,
  excluded: Set<string>): Promise<SkillLearningResult> {
  const issuedAt = deps.now();
  const selected = selectSkillCandidate(opportunity, await loadSkillBoard(deps.board), grant, excluded);
  if (selected.experiences !== undefined) {
    const family = selected.experiences[0]?.episode.taskFamily;
    if (family !== undefined) excluded.add(canonicalJson([family.id, family.intentClass]));
    usage.episodes += selected.experiences.length;
    usage.inputBytes += selected.inputBytes ?? 0;
    await applySkillFeedback(deps.board, selected.experiences, opportunity.workspaceId, issuedAt);
  }

  if (selected.kind !== "candidate") return result(selected.kind, selected.reason, usage);

  const candidate = selected.candidate;

  if (signal.aborted) return result("cancelled", "cancelled", usage, candidate);

  await prepareSkillTrial(deps.board, candidate, issuedAt);

  if (grant.allowance.maxEvaluations === 0) return result("waiting", "evaluation_allowance_exhausted", usage, candidate);

  if (signal.aborted) return result("cancelled", "cancelled", usage, candidate);

  if (deps.collection() === "disabled") return result("disabled", "collection_disabled", usage, candidate);

  const trialJob = await startSkillTrialJob(deps.board, candidate, opportunity, issuedAt);
  if (trialJob.kind === "waiting") return result("waiting", trialJob.reason, usage, candidate);

  usage.evaluations += 1;
  let trial: SkillTrialResult;

  try {
    trial = await deps.evaluate({ content: candidate.content, versionId: candidate.versionId, scope: skillCandidateScope(candidate), signal,
      ...(candidate.baselineVersionId === undefined ? {} : { baselineVersionId: candidate.baselineVersionId }) });
  } catch {
    // The Board job remains running: the evaluator may have produced an external
    // effect before disconnecting. A new granted call can resume this exact version.
    return result(signal.aborted ? "cancelled" : deps.collection() === "disabled" ? "disabled" : "failed", "skill_runtime_unavailable", usage, candidate);
  }

  if (signal.aborted) return result("cancelled", "cancelled", usage, candidate);

  if (deps.collection() === "disabled") return result("disabled", "collection_disabled", usage, candidate);

  if (trial.kind === "waiting") {
    await completeSkillTrialJob(deps.board, trialJob.jobId, "waiting_evidence", issuedAt);
    return result("waiting", trial.reason, usage, candidate);
  }

  const admitted = await admitTrial(deps, candidate, trial, issuedAt, usage);

  await completeSkillTrialJob(deps.board, trialJob.jobId, admitted.status === "shadow" ? "succeeded" : "waiting_evidence", issuedAt);

  return admitted;
}

async function admitTrial(deps: SkillLearningDependencies, candidate: SkillCandidate,
  trial: Extract<Awaited<ReturnType<SkillLearningDependencies["evaluate"]>>, { kind: "evidence" }>,
  issuedAt: string, usage: SkillLearningUsage): Promise<SkillLearningResult> {
  const evidence = trial.evidence;
  if (evidence.proposalId !== candidate.draft.id || evidence.candidateRef !== candidate.versionId
    || evidence.replay.candidateRef !== candidate.versionId || evidence.generatorRoleId === evidence.evaluatorRoleId) {
    return result("failed", "trial_binding_mismatch", usage, candidate);
  }

  if (evidence.verdict !== "recommend_shadow" || !evidence.externalPass || !evidence.shadowRecommended) {
    await applySkillCommand(deps.board, { type: "reject", proposalId: candidate.draft.id, commandId: `${candidate.draft.id}:reject`, issuedAt, reason: evidence.verdict });
    return result("waiting", "trial_rejected", usage, candidate);
  }

  const mapped = await admitContentEvidence(deps.authority, evidence, { commandId: `${candidate.draft.id}:evidence`, issuedAt,
    evidenceId: `skill-evidence:${candidate.draft.id}`, dataVersion: candidate.content.experienceDigest,
    receiptRef: trial.receiptRef, candidateVersion: candidate.versionId, scope: skillCandidateScope(candidate),
    failureSamples: candidate.draft.negativeExamples.map(item => item.episodeId) });
  if (!mapped.ok) return result("failed", mapped.reason, usage, candidate);

  for (const command of mapped.value) await applySkillCommand(deps.board, command);

  await applySkillCommand(deps.board, { type: "enter_shadow", commandId: `${candidate.draft.id}:shadow`, issuedAt,
    proposalId: candidate.draft.id, versionId: candidate.versionId });

  return result("shadow", "independently_verified_trial", usage, candidate);
}

function validGrant(grant: SkillLearningGrant): boolean {
  return grant?.subsystem === "skill" && grant.allowance !== undefined
    && Number.isSafeInteger(grant.allowance.maxEpisodes) && grant.allowance.maxEpisodes >= 3 && grant.allowance.maxEpisodes <= 256
    && Number.isSafeInteger(grant.allowance.maxInputBytes) && grant.allowance.maxInputBytes > 0 && grant.allowance.maxInputBytes <= 1_048_576
    && Number.isSafeInteger(grant.allowance.maxEvaluations) && grant.allowance.maxEvaluations >= 0 && grant.allowance.maxEvaluations <= 16
    && (grant.allowance.maxCycles === undefined || (Number.isSafeInteger(grant.allowance.maxCycles) && grant.allowance.maxCycles >= 1 && grant.allowance.maxCycles <= 16));
}

function guardedSkillBoard(deps: SkillLearningDependencies, signal: AbortSignal): SkillLearningDependencies["board"] {
  return {
    apply(command) {
      if (signal.aborted) throw new SkillBoardError("cancelled");
      if (deps.collection() === "disabled") throw new SkillBoardError("collection_disabled");
      return deps.board.apply(command);
    },

    load: () => deps.board.load(), snapshot: generation => deps.board.snapshot(generation),
    compact: generation => deps.board.compact(generation), close: () => deps.board.close(),
  };
}

function result(status: SkillLearningResult["status"], reason: string, usage: SkillLearningUsage, candidate?: SkillCandidate): SkillLearningResult {
  return { status, reason, usage: { ...usage }, ...(candidate === undefined ? {} : { proposalId: candidate.draft.id, versionId: candidate.versionId }) };
}
