import { createBoardReader, withBoardWriter } from "../../../../../adapters/learning-store/file-event-store.js";
import type { BoardCommand } from "../../../../control/commands.js";
import type { JobState, LearningJob } from "../../../../control/contracts.js";
import { contentHashOf } from "../../../../control/hash.js";
import type { BoardState } from "../../../../control/state.js";
import type { BoardStore } from "../../../../control/store-port.js";
import type { WorkflowLearningResult } from "../domain/trace-contracts.js";
import { parseWorkflowLearningArtifact, record, text, workflowFailure } from "../domain/trace-parse.js";
import { workflowMatches } from "../domain/family.js";
import type { WorkflowObservedTurn } from "./model-port.js";
import {
  jobInteger, parseWorkflowAutomaticInput, parseWorkflowJobAllowance, parseWorkflowJobOutcome, parseWorkflowJobUsage, workflowTerminalRetryId, WORKFLOW_JOB_MAX_ATTEMPTS,
  type WorkflowAutomaticInput, type WorkflowJobAllowance, type WorkflowJobClaim, type WorkflowJobOutcome, type WorkflowJobUsage,
} from "./automatic-job-contracts.js";

export type { WorkflowAutomaticInput, WorkflowJobAllowance, WorkflowJobClaim, WorkflowJobOutcome, WorkflowJobUsage } from "./automatic-job-contracts.js";
export { workflowTerminalRetryId } from "./automatic-job-contracts.js";

import { admitWorkflowJobAttempt } from "./automatic-job-admission.js";

type Coordinates = { readonly boardRoot: string; readonly issuedAt: string };

type InputAsset = { readonly type: "workflow_learning_input"; readonly schemaVersion: 1; readonly attempt: number; readonly input: WorkflowAutomaticInput };

type SettledState = "succeeded" | "failed" | "cancelled" | "expired" | "waiting_evidence";

type ResultAsset = {
  readonly type: "workflow_learning_result"; readonly schemaVersion: 1; readonly jobId: string; readonly attempt: number;
  readonly inputVersionId: string; readonly inputHash: string; readonly nextState: SettledState;
  readonly outcome: WorkflowJobOutcome | { readonly kind: "unknown"; readonly code: string };
  readonly usage: WorkflowJobUsage | { readonly state: "unknown" };
};

export type WorkflowPendingJob = {
  readonly jobId: string; readonly state: JobState; readonly attempt: number;
  readonly inputVersionId: string; readonly input: WorkflowAutomaticInput;
};

type Finished = { readonly jobId: string; readonly state: SettledState; readonly resultVersionId: string };

export type WorkflowLearningJobView = {
  readonly job: LearningJob; readonly input: WorkflowAutomaticInput; readonly inputVersionId: string;
  readonly latestOutcome?: ResultAsset["outcome"]; readonly usage?: ResultAsset["usage"]; readonly resultVersionId?: string;
};

const inputId = (jobId: string, attempt: number) => `wfli_${contentHashOf([jobId, attempt]).slice(0, 32)}`;
const resultId = (jobId: string, attempt: number) => `wflr_${contentHashOf([jobId, attempt]).slice(0, 32)}`;
const isAutomaticJob = (job: LearningJob) => job.domain === "workflow" && job.observationId === inputId(job.jobId, 1);
const ownedJob = (state: BoardState, jobId: string) => state.jobs.find(job => job.jobId === jobId && isAutomaticJob(job));

async function write<T>(root: string, run: (store: BoardStore, state: BoardState) => Promise<WorkflowLearningResult<T>>): Promise<WorkflowLearningResult<T>> {
  const result = await withBoardWriter(root, async store => {
    const loaded = await store.load();
    return loaded.ok ? run(store, loaded.state) : workflowFailure(loaded.reason, loaded.detail);
  });
  return "reason" in result ? workflowFailure(result.reason, result.detail) : result;
}

async function apply(store: BoardStore, command: BoardCommand): Promise<WorkflowLearningResult<null>> {
  const result = await store.apply(command);
  return result.ok ? { ok: true, value: null } : workflowFailure(result.reason, result.detail);
}

/** Immutable inputs/results live in the existing Board, never another queue. */
async function saveAsset(store: BoardStore, state: BoardState, versionId: string, scope: string, content: InputAsset | ResultAsset, issuedAt: string): Promise<WorkflowLearningResult<null>> {
  const existing = state.assets.find(asset => asset.versionId === versionId);
  if (existing !== undefined) return existing.kind === "workflow" && existing.scope === scope && existing.contentHash === contentHashOf(content)
    && contentHashOf(existing.content) === existing.contentHash ? { ok: true, value: null }
    : workflowFailure("job_payload_conflict", versionId);

  const proposalId = `proposal_${versionId}`;
  const proposal = {
    proposalId, domain: "workflow" as const, scope, assetKind: "workflow" as const, candidateRef: versionId,
    hypothesis: `durable workflow work; no authority; payload=${contentHashOf(content)}`,
    observationRefs: [content.type === "workflow_learning_input" ? content.input.turnId : content.inputVersionId],
    risk: "low" as const, requiredVerifiers: [], requestedAuthorities: [], source: "inferred" as const,
  };
  const previousProposal = state.proposals.find(item => item.proposalId === proposalId);
  if (previousProposal !== undefined) {
    const { lifecycle: _lifecycle, ...previous } = previousProposal;
    if (contentHashOf(previous) !== contentHashOf(proposal)) return workflowFailure("job_payload_conflict", "an incomplete prior write owns a different payload");
  }

  const commands: BoardCommand[] = [
    { type: "submit_proposal", commandId: `${versionId}:submit`, issuedAt, proposal },
    { type: "commit_asset", commandId: `${versionId}:commit`, issuedAt, proposalId, versionId, content, schemaVersion: 1 },
  ];

  for (const command of commands) {
    const applied = await apply(store, command);
    if (!applied.ok) return applied;
  }

  return { ok: true, value: null };
}

function readInput(state: BoardState, jobId: string, attempt: number): WorkflowLearningResult<{ readonly content: InputAsset; readonly hash: string }> {
  const id = inputId(jobId, attempt), asset = state.assets.find(item => item.versionId === id);
  if (state.tombstones.some(item => item.entityId === id && item.entityType === "asset")) return workflowFailure("job_input_withdrawn", id);

  if (asset === undefined || asset.kind !== "workflow" || !record(asset.content) || asset.content.type !== "workflow_learning_input"
    || asset.content.schemaVersion !== 1 || asset.content.attempt !== attempt) return workflowFailure("job_input_unavailable", id);

  const parsed = parseWorkflowAutomaticInput(asset.content.input);
  if (!parsed.ok) return parsed;

  const content: InputAsset = { type: "workflow_learning_input", schemaVersion: 1, attempt, input: parsed.value };
  const job = state.jobs.find(item => item.jobId === jobId);
  const matchesJob = job === undefined || (isAutomaticJob(job) && job.scope === parsed.value.scope && job.maxAttempts === WORKFLOW_JOB_MAX_ATTEMPTS);

  return matchesJob && parsed.value.jobId === jobId && asset.scope === parsed.value.scope && asset.contentHash === contentHashOf(content)
    ? { ok: true, value: { content, hash: asset.contentHash } } : workflowFailure("job_input_corrupt", id);
}

function pending(state: BoardState, job: LearningJob): WorkflowLearningResult<WorkflowPendingJob> {
  const attempt = job.state === "queued" ? job.attempt + 1 : job.attempt;
  const input = readInput(state, job.jobId, attempt);
  return input.ok ? { ok: true, value: { jobId: job.jobId, state: job.state, attempt: job.attempt,
    inputVersionId: inputId(job.jobId, attempt), input: input.value.content.input } } : input;
}

function freshGrant(state: BoardState, input: InputAsset): WorkflowLearningResult<null> {
  for (const asset of state.assets) {
    if (!record(asset.content) || asset.content.type !== "workflow_learning_input") continue;

    const previous = parseWorkflowAutomaticInput(asset.content.input);
    if (!previous.ok) return previous;

    if (previous.value.allowance.grantId !== input.input.allowance.grantId) continue;

    if (asset.versionId !== inputId(input.input.jobId, input.attempt) || asset.contentHash !== contentHashOf(input)) {
      return workflowFailure("job_grant_reused", "one grant cannot fund a different input or attempt");
    }
  }
  return { ok: true, value: null };
}

function admitInput(state: BoardState, input: WorkflowAutomaticInput, attempt: number): WorkflowLearningResult<null> {
  return admitWorkflowJobAttempt(input, attempt, {
    job: id => ownedJob(state, id),
    input(id, ordinal) {
      const read = readInput(state, id, ordinal);
      return read.ok ? { ok: true, value: read.value.content.input } : read;
    },
    receipt(id, ordinal) {
      const job = ownedJob(state, id);
      if (job === undefined) return workflowFailure("job_not_found", id);
      const read = readInput(state, id, ordinal);
      return read.ok ? existingResult(state, { ...job, attempt: ordinal }, read.value) : read;
    },
    grant: (value, ordinal) => freshGrant(state, { type: "workflow_learning_input", schemaVersion: 1, attempt: ordinal, input: value }),
  });
}

async function enqueueInput(store: BoardStore, state: BoardState, input: WorkflowAutomaticInput, issuedAt: string): Promise<WorkflowLearningResult<WorkflowPendingJob>> {
    const content: InputAsset = { type: "workflow_learning_input", schemaVersion: 1, attempt: 1, input };
    const existing = state.jobs.find(job => job.jobId === input.jobId);
    if (existing !== undefined) {
      const original = readInput(state, input.jobId, 1);
      if (existing.domain !== "workflow" || !original.ok || contentHashOf(original.value.content) !== contentHashOf(content)) {
        return workflowFailure("job_payload_conflict", input.jobId);
      }
      const admitted = admitInput(state, input, 1);
      return admitted.ok ? deferredOrPending(store, existing, issuedAt) : admitted;
    }

    const admitted = admitInput(state, input, 1);
    if (!admitted.ok) return admitted;

    const stored = await saveAsset(store, state, inputId(input.jobId, 1), input.scope, content, issuedAt);
    if (!stored.ok) return stored;

    const job = { jobId: input.jobId, observationId: inputId(input.jobId, 1), domain: "workflow" as const,
      scope: input.scope, maxAttempts: WORKFLOW_JOB_MAX_ATTEMPTS, dedupeKey: `workflow-job:${input.jobId}` };
    const queued = await apply(store, { type: "enqueue_job", commandId: `workflow-job:${input.jobId}:enqueue`, issuedAt, job });

    return queued.ok ? deferredOrPending(store, { ...job, state: "queued", attempt: 0, breakerOpen: false }, issuedAt) : queued;
}

export async function enqueueWorkflowLearningJob(options: Coordinates & { readonly input: unknown }): Promise<WorkflowLearningResult<WorkflowPendingJob>> {
  const parsed = parseWorkflowAutomaticInput(options.input);
  return parsed.ok ? write(options.boardRoot, (store, state) => enqueueInput(store, state, parsed.value, options.issuedAt)) : parsed;
}

export async function readPendingWorkflowLearningJobs(options: { readonly boardRoot: string; readonly scope: string; readonly limit: number }): Promise<WorkflowLearningResult<readonly WorkflowPendingJob[]>> {
  if (!text(options.scope) || !jobInteger(options.limit) || options.limit < 1 || options.limit > 128) return workflowFailure("invalid_job_query", "exact scope and a 1..128 limit are required");

  const loaded = await createBoardReader(options.boardRoot).load();
  if (!loaded.ok) return workflowFailure(loaded.reason, loaded.detail);

  const selected = loaded.state.jobs.filter(job => isAutomaticJob(job) && job.scope === options.scope
    && ["queued", "running", "waiting_evidence"].includes(job.state))
    .sort((left, right) => Number(left.state !== "queued") - Number(right.state !== "queued")).slice(0, options.limit);
  const result: WorkflowPendingJob[] = [];

  for (const job of selected) {
    const item = pending(loaded.state, job);
    if (!item.ok) return item;
    result.push(item.value);
  }

  return { ok: true, value: result };
}

/** Completed classification/segmentation can be reused without spending its grant again. */
export async function readWorkflowLearningJob(options: { readonly boardRoot: string; readonly jobId: string }): Promise<WorkflowLearningResult<WorkflowLearningJobView>> {
  const loaded = await createBoardReader(options.boardRoot).load();
  if (!loaded.ok) return workflowFailure(loaded.reason, loaded.detail);
  return workflowLearningJobFromState(loaded.state, options.jobId);
}

/** Shared read validation for queries that must see one consistent Board snapshot. */
export function workflowLearningJobFromState(state: BoardState, jobId: string): WorkflowLearningResult<WorkflowLearningJobView> {
  const job = ownedJob(state, jobId);
  if (job === undefined) return workflowFailure("job_not_found", jobId);

  const selected = pending(state, job);
  if (!selected.ok) return selected;

  const admitted = admitInput(state, selected.value.input, job.state === "queued" ? job.attempt + 1 : job.attempt);
  if (!admitted.ok) return admitted;

  const current = { job: { ...job }, input: selected.value.input, inputVersionId: selected.value.inputVersionId };

  if (job.attempt === 0) return { ok: true, value: current };

  const previous = readInput(state, job.jobId, job.attempt);
  if (!previous.ok) return previous;

  const result = existingResult(state, job, previous.value);
  if (!result.ok) return result;

  return { ok: true, value: result.value === null ? current : { ...current, latestOutcome: result.value.outcome,
    usage: result.value.usage, resultVersionId: resultId(job.jobId, job.attempt) } };
}

/** A resumed turn with new receipts is a new snapshot, even when its turn id is unchanged. */
export async function readLearnedWorkflowJobForTurn(options: {
  readonly boardRoot: string; readonly scope: string; readonly sessionId: string; readonly turnId: string; readonly observed: WorkflowObservedTurn;
}): Promise<WorkflowLearningResult<WorkflowLearningJobView | null>> {
  const loaded = await createBoardReader(options.boardRoot).load();
  if (!loaded.ok) return workflowFailure(loaded.reason, loaded.detail);

  for (const job of [...loaded.state.jobs].reverse()) {
    if (!isAutomaticJob(job) || job.state !== "succeeded" || job.scope !== options.scope) continue;
    const current = workflowLearningJobFromState(loaded.state, job.jobId);
    if (!current.ok) return current;
    const value = current.value.input;
    if (value.purpose === "classify" || value.observed === undefined || value.sessionId !== options.sessionId || value.turnId !== options.turnId
      || contentHashOf(value.observed) !== contentHashOf(options.observed)) continue;
    if (current.value.latestOutcome?.kind === "learned") return current;
  }

  return { ok: true, value: null };
}

/** A returned claim is a durable reservation of the entire grant, not a retry hint. */
export async function claimWorkflowLearningJob(options: Coordinates & { readonly jobId: string }): Promise<WorkflowLearningResult<WorkflowJobClaim>> {
  return write(options.boardRoot, async (store, state) => {
    const job = ownedJob(state, options.jobId);
    if (job === undefined) return workflowFailure("job_not_found", options.jobId);

    if (job.state !== "queued") return workflowFailure("job_not_queued", "running or interrupted grants are never implicitly reissued");

    const attempt = job.attempt + 1, stored = readInput(state, job.jobId, attempt);
    if (!stored.ok) return stored;

    const admitted = admitInput(state, stored.value.content.input, attempt);
    if (!admitted.ok) return admitted;

    if (stored.value.content.input.allowance.maxCalls === 0) {
      const deferred = await deferredOrPending(store, job, options.issuedAt);
      return deferred.ok ? workflowFailure("job_awaiting_allowance", "execution facts were saved without issuing a model claim") : deferred;
    }

    const started = await apply(store, { type: "start_job", commandId: `workflow-job:${job.jobId}:start:${attempt}`, issuedAt: options.issuedAt, jobId: job.jobId });

    return started.ok ? { ok: true, value: { jobId: job.jobId, attempt, inputVersionId: inputId(job.jobId, attempt),
      inputHash: stored.value.hash, input: stored.value.content.input } } : started;
  });
}

function resultState(outcome: WorkflowJobOutcome, usage: WorkflowJobUsage, input: WorkflowAutomaticInput): SettledState {
  if (outcome.kind === "budget_exhausted" && outcome.code === "awaiting_allowance" && input.allowance.maxCalls === 0
    && input.allowance.maxTokens === 0 && usage.calls === 0 && usage.tokens === 0) return "waiting_evidence";
  return outcome.kind === "failed" ? "failed" : outcome.kind === "cancelled" ? "cancelled"
    : outcome.kind === "budget_exhausted" ? "expired" : "succeeded";
}

function exceedsAllowance(usage: WorkflowJobUsage, allowance: WorkflowJobAllowance): boolean {
  return usage.calls > allowance.maxCalls || usage.tokens > allowance.maxTokens;
}

function learnedVersionExists(state: BoardState, versionId: string, input: WorkflowAutomaticInput): boolean {
  const asset = state.assets.find(item => item.versionId === versionId && item.kind === "workflow" && item.scope === input.scope);
  if (input.purpose === "classify" || asset === undefined || !record(asset.content) || asset.content.type !== "workflow_learning"
    || contentHashOf(asset.content) !== asset.contentHash) return false;
  if (input.parentVersionId !== undefined && (asset.parentVersionId !== input.parentVersionId || asset.content.parentVersionId !== input.parentVersionId)) return false;
  const artifact = parseWorkflowLearningArtifact(asset.content);
  return artifact.ok && contentHashOf(artifact.value) === asset.contentHash && workflowMatches(artifact.value, input.task);
}

function validateClaim(state: BoardState, claim: WorkflowJobClaim): WorkflowLearningResult<WorkflowAutomaticInput> {
  if (!text(claim.jobId) || !jobInteger(claim.attempt) || claim.attempt < 1 || claim.attempt > WORKFLOW_JOB_MAX_ATTEMPTS
    || claim.inputVersionId !== inputId(claim.jobId, claim.attempt)) return workflowFailure("invalid_job_claim", "invalid reservation coordinates");
  const input = readInput(state, claim.jobId, claim.attempt);
  if (input.ok) {
    const admitted = admitInput(state, input.value.content.input, claim.attempt);
    if (!admitted.ok) return admitted;
  }
  return input.ok && input.value.content.input.allowance.maxCalls > 0 && claim.inputHash === input.value.hash && contentHashOf(claim.input) === contentHashOf(input.value.content.input)
    ? { ok: true, value: input.value.content.input } : workflowFailure("invalid_job_claim", "claim differs from its immutable reserved input");
}

function existingResult(state: BoardState, job: LearningJob, input: { readonly content: InputAsset; readonly hash: string }): WorkflowLearningResult<ResultAsset | null> {
  const id = resultId(job.jobId, job.attempt), asset = state.assets.find(item => item.versionId === id);
  if (asset === undefined) return { ok: true, value: null };

  const raw = asset.content;
  if (asset.kind !== "workflow" || asset.scope !== job.scope || !record(raw) || raw.type !== "workflow_learning_result"
    || raw.schemaVersion !== 1 || raw.jobId !== job.jobId || raw.attempt !== job.attempt
    || raw.inputVersionId !== inputId(job.jobId, job.attempt) || raw.inputHash !== input.hash || !record(raw.outcome) || !record(raw.usage)) {
    return workflowFailure("job_result_corrupt", id);
  }

  let outcome: ResultAsset["outcome"], usage: ResultAsset["usage"], nextState: SettledState;
  if (raw.outcome.kind === "unknown" && raw.outcome.code === "interrupted_after_reservation" && raw.usage.state === "unknown") {
    outcome = { kind: "unknown", code: "interrupted_after_reservation" };
    usage = { state: "unknown" };
    nextState = "waiting_evidence";
  } else {
    const parsed = parseWorkflowJobOutcome(raw.outcome, input.content.input);
    const parsedUsage = parseWorkflowJobUsage(raw.usage);
    if (!parsed.ok || !parsedUsage.ok) return workflowFailure("job_result_corrupt", id);
    outcome = parsed.value;
    usage = parsedUsage.value;
    nextState = resultState(outcome, usage, input.content.input);
    if (exceedsAllowance(usage, input.content.input.allowance) && outcome.kind !== "budget_exhausted") return workflowFailure("job_result_corrupt", id);
    if (outcome.kind === "learned" && !learnedVersionExists(state, outcome.versionId, input.content.input)) return workflowFailure("job_result_corrupt", id);
  }

  const content: ResultAsset = { type: "workflow_learning_result", schemaVersion: 1, jobId: job.jobId,
    attempt: job.attempt, inputVersionId: inputId(job.jobId, job.attempt), inputHash: input.hash, outcome, usage, nextState };

  return raw.nextState === nextState && contentHashOf(content) === asset.contentHash && contentHashOf(raw) === asset.contentHash
    ? { ok: true, value: content } : workflowFailure("job_result_corrupt", id);
}

async function deferredOrPending(store: BoardStore, job: LearningJob, issuedAt: string): Promise<WorkflowLearningResult<WorkflowPendingJob>> {
  let loaded = await store.load();
  if (!loaded.ok) return workflowFailure(loaded.reason, loaded.detail);

  const view = pending(loaded.state, job);
  if (!view.ok) return view;

  if (view.value.input.allowance.maxCalls !== 0 || !["queued", "running"].includes(job.state)) return view;

  if (job.state === "queued") {
    const started = await apply(store, { type: "start_job", commandId: `workflow-job:${job.jobId}:start:${job.attempt + 1}`, issuedAt, jobId: job.jobId });
    if (!started.ok) return started;
    job = { ...job, state: "running", attempt: job.attempt + 1 };
    loaded = await store.load();
    if (!loaded.ok) return workflowFailure(loaded.reason, loaded.detail);
  }

  const stored = readInput(loaded.state, job.jobId, job.attempt);
  if (!stored.ok) return stored;

  const receipt: ResultAsset = { type: "workflow_learning_result", schemaVersion: 1, jobId: job.jobId, attempt: job.attempt,
    inputVersionId: inputId(job.jobId, job.attempt), inputHash: stored.value.hash, nextState: "waiting_evidence",
    outcome: { kind: "budget_exhausted", code: "awaiting_allowance" }, usage: { calls: 0, tokens: 0 } };
  const saved = await saveAsset(store, loaded.state, resultId(job.jobId, job.attempt), job.scope, receipt, issuedAt);
  if (!saved.ok) return saved;

  const settled = await settle(store, job, receipt, issuedAt);

  return settled.ok ? { ok: true, value: { ...view.value, state: "waiting_evidence", attempt: job.attempt } } : settled;
}

async function settle(store: BoardStore, job: LearningJob, receipt: ResultAsset, issuedAt: string): Promise<WorkflowLearningResult<Finished>> {
  if (job.attempt !== receipt.attempt) return workflowFailure("stale_job_claim", "a later attempt already owns this job");

  if (job.state === receipt.nextState) return { ok: true, value: { jobId: job.jobId, state: receipt.nextState, resultVersionId: resultId(job.jobId, receipt.attempt) } };

  if (job.state !== "running") return workflowFailure("job_not_running", job.state);

  const base = { commandId: `workflow-job:${job.jobId}:finish:${receipt.attempt}:${receipt.nextState}`, issuedAt, jobId: job.jobId };
  const command: BoardCommand = receipt.nextState === "succeeded" || receipt.nextState === "waiting_evidence"
    ? { ...base, type: "complete_job", next: receipt.nextState } : { ...base, type: "fail_job", terminal: receipt.nextState };
  const applied = await apply(store, command);

  return applied.ok ? { ok: true, value: { jobId: job.jobId, state: receipt.nextState, resultVersionId: resultId(job.jobId, receipt.attempt) } } : applied;
}

export async function finishWorkflowLearningJob(options: Coordinates & { readonly claim: WorkflowJobClaim; readonly outcome: WorkflowJobOutcome; readonly usage: WorkflowJobUsage }): Promise<WorkflowLearningResult<Finished>> {
  return write(options.boardRoot, async (store, state) => {
    const input = validateClaim(state, options.claim);
    if (!input.ok) return input;

    const job = ownedJob(state, options.claim.jobId);
    if (job === undefined) return workflowFailure("job_not_found", options.claim.jobId);

    const parsed = parseWorkflowJobOutcome(options.outcome, input.value);
    if (!parsed.ok) return parsed;

    const parsedUsage = parseWorkflowJobUsage(options.usage);
    if (!parsedUsage.ok) return parsedUsage;

    const usage = parsedUsage.value;
    const outcome: WorkflowJobOutcome = exceedsAllowance(usage, input.value.allowance)
      ? { kind: "budget_exhausted", code: "allowance_exceeded" } : parsed.value;
    if (outcome.kind === "learned" && !learnedVersionExists(state, outcome.versionId, input.value)) {
      return workflowFailure("job_result_unavailable", "a real learned asset must already exist in this Board scope and task family");
    }

    const receipt: ResultAsset = { type: "workflow_learning_result", schemaVersion: 1, jobId: job.jobId,
      attempt: options.claim.attempt, inputVersionId: options.claim.inputVersionId, inputHash: options.claim.inputHash,
      outcome, usage, nextState: resultState(outcome, usage, input.value) };
    if (job.attempt !== receipt.attempt) return workflowFailure("stale_job_claim", "a later attempt already owns this job");

    const saved = await saveAsset(store, state, resultId(job.jobId, receipt.attempt), input.value.scope, receipt, options.issuedAt);

    return saved.ok ? settle(store, job, receipt, options.issuedAt) : saved;
  });
}

export async function recoverWorkflowLearningJob(options: Coordinates & { readonly jobId: string; readonly expectedAttempt: number }): Promise<WorkflowLearningResult<Finished>> {
  return write(options.boardRoot, async (store, state) => {
    const job = ownedJob(state, options.jobId);
    if (job === undefined) return workflowFailure("job_not_found", options.jobId);

    if (job.attempt !== options.expectedAttempt || job.attempt < 1) return workflowFailure("stale_job_claim", "restart recovery must identify the observed attempt");

    const stored = readInput(state, job.jobId, job.attempt);
    if (!stored.ok) return stored;

    if (stored.value.content.input.allowance.maxCalls === 0 && job.state === "running") {
      const deferred = await deferredOrPending(store, job, options.issuedAt);
      return deferred.ok ? { ok: true, value: { jobId: job.jobId, state: "waiting_evidence", resultVersionId: resultId(job.jobId, job.attempt) } } : deferred;
    }

    const known = existingResult(state, job, stored.value);
    if (!known.ok) return known;

    if (known.value !== null) return settle(store, job, known.value, options.issuedAt);

    const receipt: ResultAsset = { type: "workflow_learning_result", schemaVersion: 1, jobId: job.jobId, attempt: job.attempt,
      inputVersionId: inputId(job.jobId, job.attempt), inputHash: stored.value.hash,
      outcome: { kind: "unknown", code: "interrupted_after_reservation" }, usage: { state: "unknown" }, nextState: "waiting_evidence" };
    // A known persisted result is settled above. Only a genuinely unknown
    // delivery keeps the consumed reservation waiting for explicit new funding.
    const saved = await saveAsset(store, state, resultId(job.jobId, job.attempt), stored.value.content.input.scope, receipt, options.issuedAt);

    return saved.ok ? settle(store, job, receipt, options.issuedAt) : saved;
  });
}

export async function retryWorkflowLearningJob(options: Coordinates & { readonly jobId: string; readonly allowance: WorkflowJobAllowance }): Promise<WorkflowLearningResult<WorkflowPendingJob>> {
  const allowance = parseWorkflowJobAllowance(options.allowance);
  if (!allowance.ok) return allowance;

  return write(options.boardRoot, async (store, state) => {
    const job = ownedJob(state, options.jobId);
    if (job === undefined) return workflowFailure("job_not_found", options.jobId);

    if (["succeeded", "failed", "cancelled", "expired"].includes(job.state)) {
      const previous = readInput(state, job.jobId, job.attempt);
      if (!previous.ok) return previous;
      const input = { ...previous.value.content.input, jobId: workflowTerminalRetryId(job.jobId, job.attempt, allowance.value.grantId),
        allowance: allowance.value, retryOf: { jobId: job.jobId, attempt: job.attempt } };
      return enqueueInput(store, state, input, options.issuedAt);
    }

    if (job.state === "queued" && job.attempt > 0) {
      const queued = readInput(state, job.jobId, job.attempt + 1);
      return queued.ok && contentHashOf(queued.value.content.input.allowance) === contentHashOf(allowance.value)
        ? pending(state, job) : workflowFailure("job_payload_conflict", "a queued retry already has a different grant");
    }

    if (job.state !== "waiting_evidence") return workflowFailure("job_not_waiting", "only explicitly recovered unknown work accepts a fresh grant");

    if (job.attempt >= job.maxAttempts) return workflowFailure("job_budget_exceeded", "fresh grant retry limit reached");

    const previous = readInput(state, job.jobId, job.attempt);
    if (!previous.ok) return previous;

    const input = { ...previous.value.content.input, allowance: allowance.value };
    const content: InputAsset = { type: "workflow_learning_input", schemaVersion: 1, attempt: job.attempt + 1, input };
    const admitted = admitInput(state, input, content.attempt);
    if (!admitted.ok) return admitted;

    const saved = await saveAsset(store, state, inputId(job.jobId, content.attempt), job.scope, content, options.issuedAt);
    if (!saved.ok) return saved;

    const queued = await apply(store, { type: "requeue_job", commandId: `workflow-job:${job.jobId}:retry:${content.attempt}`,
      issuedAt: options.issuedAt, jobId: job.jobId, expectedAttempt: job.attempt });

    return queued.ok ? { ok: true, value: { jobId: job.jobId, state: "queued", attempt: job.attempt,
      inputVersionId: inputId(job.jobId, content.attempt), input } } : queued;
  });
}
