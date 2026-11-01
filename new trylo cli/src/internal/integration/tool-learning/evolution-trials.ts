import { createBoardReader, withBoardWriter, type FileBoardStoreOptions } from "../../adapters/learning-store/file-event-store.js";
import { canonicalJson, sha256Hex } from "../../learning/control/hash.js";
import type { BoardState } from "../../learning/control/state.js";
import { decodeToolEvolutionVerification, verificationBinds } from "../../learning/domains/tool/evolution/artifact.js";
import { parseToolEvolutionRequest } from "../../learning/domains/tool/evolution/parse.js";
import { toolTrialKey, toolTrialFeedback, type ToolTrialRecord } from "../../learning/domains/tool/evolution/trial.js";
import type { ToolEvolutionVerifier } from "../../learning/domains/tool/evolution/verification.js";
import { toolUseFeedback } from "../../learning/domains/tool/evolution/use.js";
import { candidateFromBoard, type EvolutionReadFailure } from "./evolution-reader.js";

type TrialRead = EvolutionReadFailure | { readonly ok: true; readonly records: readonly ToolTrialRecord[] };
export type ToolTrialOutcome = EvolutionReadFailure | { readonly kind: "cancelled" }
  | { readonly kind: "trial"; readonly record: ToolTrialRecord; readonly source: "executed" | "replayed" };
export type ToolTrialOptions = { readonly boardRoot: string; readonly verifier: ToolEvolutionVerifier; readonly now: () => number; readonly storeOptions?: FileBoardStoreOptions };

export async function readToolEvolutionTrials(boardRoot: string, versionId: string): Promise<TrialRead> {
  const loaded = await createBoardReader(boardRoot).load();
  return loaded.ok ? trialsFromBoard(loaded.state, versionId) : { ok: false, code: loaded.reason, message: loaded.detail };
}

export async function prepareToolImprovement(boardRoot: string, versionId: string, raw: unknown) {
  const request = parseToolEvolutionRequest(raw);
  if (!request.ok) return { ok: false as const, code: request.code, message: request.message };
  const loaded = await createBoardReader(boardRoot).load();
  if (!loaded.ok) return { ok: false as const, code: loaded.reason, message: loaded.detail };
  const candidate = candidateFromBoard(loaded.state, versionId);
  if (!candidate.ok) return candidate;
  const prior = { versionId, source: candidate.artifact.candidate.source };
  if (request.value.scope !== candidate.artifact.request.scope || (request.value.prior !== undefined
    && canonicalJson(request.value.prior) !== canonicalJson(prior))) return { ok: false as const, code: "parent_binding_mismatch", message: "improvement scope or supplied parent differs from the archived candidate" };
  const trials = trialsFromBoard(loaded.state, versionId);
  if (!trials.ok) return trials;
  const feedback = [toolTrialFeedback(trials.records), toolUseFeedback((loaded.state.toolUses ?? []).filter(item => item.versionId === versionId))]
    .filter((item): item is string => item !== undefined).join("\n");
  return { ok: true as const, request: { ...request.value, operation: "improve" as const, prior }, feedback: feedback || undefined };
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
  const records = (state.toolTrials ?? []).filter(item => item.versionId === versionId);
  if (records.some(item => item.scope !== candidate.artifact.request.scope || item.verification.candidateHash !== candidate.artifact.verification.candidateHash)) {
    return { ok: false, code: "invalid_tool_trial", message: "persisted trial does not bind this candidate" };
  }
  return { ok: true, records };
}

function conflict(): EvolutionReadFailure { return { ok: false, code: "tool_trial_conflict", message: "trial ID already binds different content; use a new requestId" }; }
