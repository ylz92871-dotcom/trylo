import { createBoardReader } from "../../../../../adapters/learning-store/file-event-store.js";
import { contentHashOf } from "../../../../control/hash.js";
import type { BoardState } from "../../../../control/state.js";
import { npmInstallId } from "../../../../../tooling/contract/npm-install.js";
import { decodeNpmToolInterface, type NpmToolInterface } from "../domain/evolution/npm-production-plan.js";
import { decodeNpmLearningContract, decodeNpmSourceRead, type NpmSourceRead } from "../domain/evolution/npm-learning.js";
import type { ToolEvolutionRequest } from "../domain/evolution/contracts.js";
import { isJsonValue, jsonBytes, keysAre, recordOf, textOf } from "../domain/evolution/parse.js";
import type { NpmAdaptationInput } from "./npm-adaptation-types.js";
import { assetAvailable, pipelineFailure } from "./pipeline-assets.js";
import { saveNpmLearningArtifact } from "./npm-adaptation-artifacts.js";
import { decodeNpmSourceCheck, type NpmSourceCheck } from "./npm-source-check.js";

type NotRun = { readonly kind: "not_run"; readonly reason: "execution_authorization_required" };

export type NpmLearningAttempt = { readonly versionId: string; readonly interface: NpmToolInterface; readonly check: NpmSourceCheck | NotRun };

export type NpmLearningSourceRead = { readonly versionId: string; readonly request: NpmSourceRead; readonly sourceFingerprint: string };

type Coordinates = Pick<NpmAdaptationInput, "boardRoot" | "plan" | "admission">;

/** A restart restores the last actual construction attempt, not just its old parent or a status label. */
export async function readNpmLearningProgress(input: NpmAdaptationInput, contractId: string, checks: ToolEvolutionRequest) {
  const loaded = await createBoardReader(input.boardRoot).load();
  if (!loaded.ok) return pipelineFailure(loaded.reason, loaded.detail);

  const frozen = loaded.state.assets.find(asset => asset.versionId === contractId);
  const contract = frozen === undefined ? undefined : decodeNpmLearningContract(frozen.content);
  if (frozen === undefined || !available(loaded.state, frozen, input.plan.scope) || contract === undefined
    || contract.subjectId !== input.admission.jobId || contract.installationId !== npmInstallId(input.installation)
    || contentHashOf(contract.checks) !== contentHashOf(checks)) return pipelineFailure("npm_progress_contract_mismatch", contractId);

  let lastAttempt: NpmLearningAttempt | undefined;

  for (const asset of [...loaded.state.assets].reverse()) {
    const raw = asset.content;
    if (!recordOf(raw) || raw.type !== "tool_npm_learning_attempt" || raw.subjectId !== input.admission.jobId || raw.contractId !== contractId) continue;

    if (!available(loaded.state, asset, input.plan.scope) || !isJsonValue(raw) || jsonBytes(raw) > 768 * 1024
      || !keysAre(raw, ["type", "schemaVersion", "subjectId", "contractId", "interface", "check"])
      || raw.schemaVersion !== 1 || asset.versionId !== `npm-attempt_v1_${contentHashOf(raw)}`) return pipelineFailure("invalid_npm_learning_attempt", asset.versionId);

    const selected = decodeNpmToolInterface(raw.interface), check = decodeAttemptCheck(raw.check, checks);
    if (selected === undefined || check === undefined) return pipelineFailure("invalid_npm_learning_attempt", asset.versionId);

    lastAttempt = { versionId: asset.versionId, interface: selected, check };
    break;
  }

  const reads = sourceReads(loaded.state, input, contractId);

  return reads.ok ? { ok: true as const, reads: reads.reads, ...(lastAttempt === undefined ? {} : { lastAttempt }) } : reads;
}

/** Contract design can restore source coordinates before its final oracle has been committed. */
export async function readNpmLearningSourceReads(input: Coordinates, contractId: string) {
  const loaded = await createBoardReader(input.boardRoot).load();
  return loaded.ok ? sourceReads(loaded.state, input, contractId) : pipelineFailure(loaded.reason, loaded.detail);
}

/** Persist only how to reproduce an inspected view; raw package docs and private task data stay out. */
export async function saveNpmLearningSourceRead(input: NpmAdaptationInput,
  read: { readonly contractId: string; readonly request: NpmSourceRead; readonly sourceFingerprint: string }) {
  const request = decodeNpmSourceRead(read.request);
  if (request === undefined || !textOf(read.contractId, 160) || !digest(read.sourceFingerprint)) return pipelineFailure("invalid_npm_source_read_record", "Expected exact source coordinates and their bounded content fingerprint");
  const content = { type: "tool_npm_learning_source_read", schemaVersion: 1, subjectId: input.admission.jobId,
    contractId: read.contractId, request: { ...request, offset: request.offset ?? 0 }, sourceFingerprint: read.sourceFingerprint };
  return saveNpmLearningArtifact({ ...input, scope: input.plan.scope, versionId: `npm-source-read_v1_${contentHashOf(content)}`,
    content, issuedAt: new Date(input.now()).toISOString() });
}

function sourceReads(state: BoardState, input: Coordinates, contractId: string) {
  const reads: NpmLearningSourceRead[] = [];

  for (const asset of state.assets) {
    const raw = asset.content;
    if (!recordOf(raw) || raw.type !== "tool_npm_learning_source_read" || raw.subjectId !== input.admission.jobId || raw.contractId !== contractId) continue;

    const request = decodeNpmSourceRead(raw.request);
    if (!available(state, asset, input.plan.scope) || !isJsonValue(raw) || jsonBytes(raw) > 8192
      || !keysAre(raw, ["type", "schemaVersion", "subjectId", "contractId", "request", "sourceFingerprint"])
      || raw.schemaVersion !== 1 || request === undefined || !digest(raw.sourceFingerprint)
      || asset.versionId !== `npm-source-read_v1_${contentHashOf(raw)}`) return pipelineFailure("invalid_npm_source_read_record", asset.versionId);

    reads.push({ versionId: asset.versionId, request, sourceFingerprint: raw.sourceFingerprint });

    if (reads.length > 64) return pipelineFailure("npm_source_read_history_limit", "Inspect the bounded source history before further automatic research");
  }

  return { ok: true as const, reads };
}

function decodeAttemptCheck(raw: unknown, checks: ToolEvolutionRequest): NpmSourceCheck | NotRun | undefined {
  if (recordOf(raw) && keysAre(raw, ["kind", "reason"]) && raw.kind === "not_run" && raw.reason === "execution_authorization_required") {
    return { kind: "not_run", reason: "execution_authorization_required" };
  }
  return decodeNpmSourceCheck(raw, { checks });
}

function available(state: BoardState, asset: BoardState["assets"][number], scope: string): boolean {
  const proposal = state.proposals.find(row => row.proposalId === asset.createdFromProposalId);
  return asset.kind === "workflow" && asset.source === "inferred" && asset.scope === scope && assetAvailable(state, asset)
    && proposal?.proposalId === `proposal:${asset.versionId}` && proposal.domain === "tool" && proposal.source === asset.source
    && proposal.candidateRef === asset.versionId && proposal.risk === "low" && proposal.requiredVerifiers.length === 0 && proposal.requestedAuthorities.length === 0;
}

function digest(raw: unknown): raw is string { return typeof raw === "string" && /^[a-f0-9]{64}$/.test(raw); }
