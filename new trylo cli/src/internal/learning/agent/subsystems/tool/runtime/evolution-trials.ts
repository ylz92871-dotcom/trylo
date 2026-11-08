import { createBoardReader, withBoardWriter, type FileBoardStoreOptions } from "../../../../../adapters/learning-store/file-event-store.js";
import { canonicalJson, sha256Hex } from "../../../../control/hash.js";
import type { BoardState } from "../../../../control/state.js";
import { decodeToolEvolutionVerification, verificationBinds, type ToolEvolutionArtifact } from "../domain/evolution/artifact.js";
import { parseToolEvolutionRequest } from "../domain/evolution/parse.js";
import { toolTrialKey, toolTrialFeedback, type ToolTrialRecord } from "../domain/evolution/trial.js";
import type { ToolEvolutionVerifier } from "../domain/evolution/verification.js";
import { toolUseFeedback } from "../domain/evolution/use.js";
import { candidateFromBoard, type EvolutionReadFailure } from "./evolution-reader.js";
import { taskFeedbackForCandidate, toolTaskFeedbackContext } from "./tool-task-feedback.js";
import { approvedToolContractRevisionsFromBoard } from "./contract-revisions.js";
import { preserveOrReviseToolSamples } from "../domain/evolution/contract-revision.js";
import { toolLearningParentFromBoard, toolLearningFeedbackVersions } from "./learning-parent.js";
import type { ToolLearningPlan } from "../domain/evolution/pipeline.js";
import { toolLearningFeedbackScope } from "./feedback-input-facts.js";

type TrialRead = EvolutionReadFailure | { readonly ok: true; readonly records: readonly ToolTrialRecord[] };

export type ToolTrialOutcome = EvolutionReadFailure | { readonly kind: "cancelled" }
  | { readonly kind: "trial"; readonly record: ToolTrialRecord; readonly source: "executed" | "replayed" };

export type ToolTrialOptions = { readonly boardRoot: string; readonly verifier: ToolEvolutionVerifier; readonly now: () => number; readonly storeOptions?: FileBoardStoreOptions };

export async function readToolEvolutionTrials(boardRoot: string, versionId: string): Promise<TrialRead> {
  const loaded = await createBoardReader(boardRoot).load();
  return loaded.ok ? trialsFromBoard(loaded.state, versionId) : { ok: false, code: loaded.reason, message: loaded.detail };
}

export async function prepareToolImprovement(boardRoot: string, versionId: string, raw: unknown, plan?: ToolLearningPlan) {
  const request = parseToolEvolutionRequest(raw);
  if (!request.ok) return { ok: false as const, code: request.code, message: request.message };

  const loaded = await createBoardReader(boardRoot).load();
  if (!loaded.ok) return { ok: false as const, code: loaded.reason, message: loaded.detail };

  const historical = toolLearningParentFromBoard(loaded.state, versionId);
  if (!historical.ok) return historical;

  if (historical.parent.kind !== "generated" || historical.parent.versionId !== versionId) return { ok: false as const, code: "parent_binding_mismatch", message: "pure improvement requires the exact generated learning parent" };

  const artifact = historical.parent.artifact;
  const prior = { versionId, source: artifact.candidate.source };
  if (request.value.scope !== artifact.request.scope || (request.value.prior !== undefined
    && canonicalJson(request.value.prior) !== canonicalJson(prior))) return { ok: false as const, code: "parent_binding_mismatch", message: "improvement scope or supplied parent differs from the archived candidate" };

  const revisions = approvedToolContractRevisionsFromBoard(loaded.state, versionId, request.value.scope, request.value.contractRevisionRefs ?? []);
  if (!revisions.ok) return revisions;

  const contract = preserveOrReviseToolSamples({ parentVersionId: versionId, scope: request.value.scope,
    parentSamples: artifact.request.evidence, proposedSamples: request.value.evidence, revisions: revisions.revisions });
  if (!contract.ok) return contract;

  const trials = trialRecordsForCandidate(loaded.state, versionId, artifact);
  if (!trials.ok) return trials;

  const scoped = plan === undefined ? undefined : toolLearningFeedbackScope(loaded.state, plan, versionId);
  if (scoped !== undefined && !scoped.ok) return scoped;

  const historicalFeedback = scoped === undefined ? taskFeedbackForCandidate(loaded.state, versionId) : undefined;
  if (historicalFeedback !== undefined && !historicalFeedback.ok) return historicalFeedback;

  const useVersions = scoped === undefined ? toolLearningFeedbackVersions(loaded.state, versionId) : [];
  const feedback = [toolTrialFeedback(trials.records), toolUseFeedback(scoped?.uses ?? (loaded.state.toolUses ?? []).filter(item => useVersions.includes(item.versionId))),
    toolTaskFeedbackContext(scoped?.entries.map(entry => entry.feedback) ?? (historicalFeedback?.ok ? historicalFeedback.records : [])),
    ...(scoped?.historyScope === "unknown" ? ["Historical feedback workspace is unknown; no unbound task assessments were supplied."] : [])]
    .filter((item): item is string => item !== undefined).join("\n");
  const framed = plan === undefined && feedback.length > 0
    ? "Manual historical diagnostics have no current workspace binding and are not a current external oracle. Preserve the caller's frozen task contract.\n" + feedback : feedback;

  return { ok: true as const, request: { ...request.value, operation: "improve" as const, prior }, feedback: framed || undefined };
}

/** Read facts before starting a process; retries cannot turn one trial ID into multiple facts. */
export async function runToolEvolutionTrial(options: ToolTrialOptions, versionId: string, raw: unknown, signal: AbortSignal): Promise<ToolTrialOutcome> {
  if (signal.aborted) return { kind: "cancelled" };

  const request = parseToolEvolutionRequest(raw);
  if (!request.ok) return { ok: false, code: request.code, message: request.message };

  const loaded = await createBoardReader(options.boardRoot).load();
  if (!loaded.ok) return { ok: false, code: loaded.reason, message: loaded.detail };

  const candidate = candidateFromBoard(loaded.state, versionId);
  if (!candidate.ok) return candidate;

  if (candidate.artifact.request.scope !== request.value.scope) return { ok: false, code: "trial_scope_mismatch", message: "trial scope differs from candidate scope" };

  const history = trialsFromBoard(loaded.state, versionId);
  if (!history.ok) return history;

  const requestHash = sha256Hex(canonicalJson(request.value));
  const previous = history.records.find(item => item.trialId === request.value.requestId);
  if (previous !== undefined) return previous.requestHash === requestHash
    ? { kind: "trial", record: previous, source: "replayed" } : conflict();

  try {
    const report = await options.verifier.verify(candidate.artifact.candidate, request.value, signal);
    if (signal.aborted || report.verdict === "cancelled") return { kind: "cancelled" };

    if (report.verdict === "unavailable") return { ok: false, code: "verification_unavailable", message: "trial execution did not run; no tool-failure fact was recorded" };

    const verification = decodeToolEvolutionVerification(report);
    if (verification === undefined || !verificationBinds(candidate.artifact.candidate, request.value, verification)) return { ok: false, code: "verification_binding_mismatch", message: "trial report does not cover these exact bytes and samples" };

    const record: ToolTrialRecord = { schemaVersion: 1, trialId: request.value.requestId, versionId, scope: request.value.scope,
      requestHash, verification, occurredAt: new Date(options.now()).toISOString() };

    return await persistTrial(options, record, signal);
  } catch (error) {
    return signal.aborted ? { kind: "cancelled" } : { ok: false, code: "trial_unavailable", message: error instanceof Error ? error.message : String(error) };
  }
}

async function persistTrial(options: ToolTrialOptions, record: ToolTrialRecord, signal: AbortSignal): Promise<ToolTrialOutcome> {
  const saved = await withBoardWriter(options.boardRoot, async store => {
    const loaded = await store.load();
    if (!loaded.ok) return { ok: false as const, code: loaded.reason, message: loaded.detail };

    if (signal.aborted) return { kind: "cancelled" as const };

    const history = trialsFromBoard(loaded.state, record.versionId);
    if (!history.ok) return history;

    const previous = history.records.find(item => item.trialId === record.trialId);
    if (previous !== undefined) return previous.requestHash === record.requestHash && canonicalJson(previous.verification) === canonicalJson(record.verification)
      ? { kind: "trial" as const, record: previous, source: "replayed" as const } : conflict();

    const applied = await store.apply({ type: "record_tool_trial", commandId: `tool-trial:${toolTrialKey(record)}`, issuedAt: record.occurredAt, record });

    return applied.ok ? { kind: "trial" as const, record, source: "executed" as const }
      : { ok: false as const, code: applied.reason, message: applied.detail };
  }, options.storeOptions);
  return "reason" in saved ? { ok: false, code: saved.reason, message: saved.detail } : saved;
}

function trialsFromBoard(state: BoardState, versionId: string): TrialRead {
  const candidate = candidateFromBoard(state, versionId);
  if (!candidate.ok) return candidate;
  return trialRecordsForCandidate(state, versionId, candidate.artifact);
}

function trialRecordsForCandidate(state: BoardState, versionId: string, candidate: Pick<ToolEvolutionArtifact, "request" | "verification">): TrialRead {
  const records = (state.toolTrials ?? []).filter(item => item.versionId === versionId);
  if (records.some(item => item.scope !== candidate.request.scope || item.verification.candidateHash !== candidate.verification.candidateHash)) {
    return { ok: false, code: "invalid_tool_trial", message: "persisted trial does not bind this candidate" };
  }
  return { ok: true, records };
}

function conflict(): EvolutionReadFailure { return { ok: false, code: "tool_trial_conflict", message: "trial ID already binds different content; use a new requestId" }; }
