import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createNdjsonSessionStore, recoverSessionRecordView } from "../../../../../adapters/session-store/ndjson.js";
import type { BoardStore } from "../../../../control/store-port.js";
import { contentHashOf } from "../../../../control/hash.js";
import type { JsonObject } from "../../../../../protocol/envelope.js";
import type { Transcript } from "../../../../../protocol/transcript.js";
import type { SessionRecord } from "../../../../../ports/session.js";
import { isSuccessfulStreamFinish } from "../../../../../loop/stream-verdict.js";

/** Explicit host recovery binding. It grants neither spending nor permission.
 * Historical journals did not record grant IDs, so the host must supply and
 * retain the verified original job/journal association rather than infer one. */
export type SkillReviewContinuationInput = {
  readonly issueId: string;
  readonly jobId: string;
  readonly grantId: string;
  readonly journalPath: string;
  readonly journalSha256: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly bindingEvidence: { readonly path: string; readonly sha256: string };
  /** Source-qualified later receipts; never synthesized as old tool results. */
  readonly facts: readonly { readonly path: string; readonly sha256: string; readonly text: string }[];
};

export type SkillReviewCheckpoint = {
  readonly ref: string;
  readonly metadata: JsonObject;
  readonly transcript: Transcript;
};

const failure = (reason: string): never => { throw new Error(reason); };
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Select only an accepted stream prefix. Parsed/rejected suffix calls and
 * private reasoning cannot become provider history or executable recovery. */
export function skillAcceptedReviewCheckpoint(records: readonly SessionRecord[], sessionId: string, turnId: string) {
  const own = records.filter(record => record.sessionId === sessionId && record.turnId === turnId);
  const terminal = own.filter(record => record.type === "terminal").at(-1);
  const boundary = own.filter(record => {
    const envelope = record.payload.envelope;
    return record.type === "envelope" && object(envelope) && envelope.kind === "stream_end"
      && envelope.sessionId === sessionId && envelope.turnId === turnId && object(envelope.payload)
      && typeof envelope.payload.reason === "string" && isSuccessfulStreamFinish(envelope.payload.reason);
  }).at(-1);
  if (terminal?.payload.reason !== "failed" || boundary === undefined || boundary.sequence >= terminal.sequence) {
    return failure("hermes_continuation_accepted_checkpoint_missing");
  }

  const complete = recoverSessionRecordView({ records, tornTail: false });
  if (!complete.ok || complete.session.sessionId !== sessionId || complete.session.pendingEffects.length > 0) {
    return failure("hermes_continuation_effect_reconciliation_required");
  }

  const prefix = own.filter(record => record.sequence <= boundary.sequence);
  const itemSequences = new Set(prefix.filter(record => record.type === "transcript_item").map(record => record.payload.sequence));
  const calls = complete.session.transcript.filter(item => itemSequences.has(item.sequence) && item.kind === "tool_call");
  if (calls.length !== prefix.filter(record => record.type === "transcript_item" && record.payload.kind === "tool_call").length) {
    return failure("hermes_continuation_checkpoint_tool_unconfirmed");
  }
  const acceptedEffects = new Set<string>();
  let acceptedThroughSequence = boundary.sequence;
  for (const item of calls) {
    if (item.kind !== "tool_call") continue;
    const results = own.filter(record => record.type === "transcript_item" && record.payload.kind === "tool_result"
      && record.payload.toolCallId === item.toolCallId && record.payload.name === item.name);
    const commits = own.filter(record => record.type === "effect_committed" && record.payload.key === `tool:${item.toolCallId}`);
    const issued = own.filter(record => record.type === "effect_issued" && record.payload.key === `tool:${item.toolCallId}`);
    const result = results[0], commit = commits[0];
    if (results.length !== 1 || commits.length !== 1 || issued.length !== 1 || result?.payload.outcome !== "succeeded" || commit?.payload.outcome !== "succeeded"
      || result.sequence >= terminal.sequence || commit.sequence >= terminal.sequence) return failure("hermes_continuation_checkpoint_tool_unconfirmed");
    itemSequences.add(result.payload.sequence);
    acceptedEffects.add(`tool:${item.toolCallId}`);
    // Some canonical hosts persist the accepted tools after stream_end. Include
    // only these exact confirmed receipts, never intervening response content.
    acceptedThroughSequence = Math.max(acceptedThroughSequence, result.sequence, commit.sequence);
  }
  // begin() supplies the current official prompt and original source again.
  // The historical prompt is neither a new user message nor another source.
  const transcript = complete.session.transcript.filter(item => itemSequences.has(item.sequence)
    && item.kind !== "assistant_reasoning" && item.kind !== "user" && item.kind !== "system");

  const suffixCalls = own.filter(record => record.sequence > boundary.sequence && record.type === "transcript_item"
    && record.payload.kind === "tool_call").map(record => record.payload.toolCallId).filter((id): id is string => typeof id === "string");
  // The continuation may not silently ignore an effect issued after its prefix.
  if (own.some(record => record.sequence > boundary.sequence && record.type === "effect_issued"
    && (typeof record.payload.key !== "string" || !acceptedEffects.has(record.payload.key) || record.sequence > acceptedThroughSequence))) {
    return failure("hermes_continuation_suffix_effect_requires_owner_reconciliation");
  }
  return { transcript, acceptedThroughSequence, excludedSuffixCallIds: suffixCalls };
}

/** Read-only preparation. The original failed job and every bill stay intact;
 * a successor must separately pass the normal focus/fund/claim writer. */
export async function readSkillReviewContinuation(options: {
  readonly board: Pick<BoardStore, "load">;
  readonly scope: string;
  readonly input: SkillReviewContinuationInput;
}): Promise<SkillReviewCheckpoint> {
  const input = options.input, loaded = await options.board.load();
  if (!loaded.ok) return failure(loaded.reason);
  const grant = loaded.state.centralLearningGrants?.find(item => item.grantId === input.grantId);
  const job = loaded.state.jobs.find(item => item.jobId === input.jobId);
  if (!/^[a-f0-9]{64}$/.test(input.journalSha256)
    || grant?.domain !== "skill" || grant.scope !== options.scope || grant.issueId !== input.issueId || grant.jobId !== input.jobId
    || grant.status !== "closed"
    || !(grant.closedReason === "hermes_review_reconciliation_required"
      || grant.closedReason === "hermes_review_tool_failed" && grant.reservations.every(item => item.usage?.kind === "reported"))
    || job?.domain !== "skill" || job.scope !== options.scope || job.state !== "failed"
    || job.coordination?.issueId !== input.issueId || job.coordination.grantId !== input.grantId
    || grant.reservations.some(item => item.state !== "settled")) return failure("hermes_continuation_original_binding");

  const bindingBytes = await readFile(input.bindingEvidence.path);
  if (!/^[a-f0-9]{64}$/.test(input.bindingEvidence.sha256) || digest(bindingBytes) !== input.bindingEvidence.sha256) {
    return failure("hermes_continuation_binding_changed");
  }
  const binding: unknown = JSON.parse(bindingBytes.toString("utf8"));
  if (binding === null || typeof binding !== "object" || !("sourceIssueId" in binding) || binding.sourceIssueId !== input.issueId
    || !("jobId" in binding) || binding.jobId !== input.jobId || !("grantId" in binding) || binding.grantId !== input.grantId
    || !("journalPath" in binding) || binding.journalPath !== input.journalPath
    || !("journalSha256" in binding) || binding.journalSha256 !== input.journalSha256
    || !("sessionId" in binding) || binding.sessionId !== input.sessionId) return failure("hermes_continuation_binding_mismatch");

  const bytes = await readFile(input.journalPath);
  if (digest(bytes) !== input.journalSha256) return failure("hermes_continuation_journal_changed");
  const store = createNdjsonSessionStore({ path: input.journalPath });
  const journal = await store.readRecords();
  if (!journal.ok || journal.view.tornTail || digest(await readFile(input.journalPath)) !== input.journalSha256) {
    return failure("hermes_continuation_journal_unavailable");
  }
  const checkpoint = skillAcceptedReviewCheckpoint(journal.view.records, input.sessionId, input.turnId);
  const facts = [];
  for (const fact of input.facts) {
    if (!/^[a-f0-9]{64}$/.test(fact.sha256) || !fact.text.trim() || digest(await readFile(fact.path)) !== fact.sha256) {
      return failure("hermes_continuation_fact_changed");
    }
    facts.push({ path: fact.path, sha256: fact.sha256, text: fact.text });
  }
  const metadata = { schemaVersion: 1, issueId: input.issueId, originalJobId: input.jobId, originalGrantId: input.grantId,
    originalJournalSha256: input.journalSha256, originalSessionId: input.sessionId, originalTurnId: input.turnId,
    bindingEvidence: { ...input.bindingEvidence }, acceptedThroughSequence: checkpoint.acceptedThroughSequence,
    originalPromptReplacedByCurrentNativePrompt: true,
    excludedSuffixCallIds: checkpoint.excludedSuffixCallIds, originalFailure: grant.closedReason,
    originalReservations: grant.reservations.map(item => ({ reservationId: item.reservationId, maxTokens: item.maxTokens,
      usage: item.usage === undefined ? null : { ...item.usage } })), laterFacts: facts,
    instruction: "Continue only unfinished review work. Reuse the accepted observations as historical context. Excluded calls were not accepted and must not be replayed. Later facts are separately attributed receipts, never old tool results. Do not repeat completed staging, approvals, business or feedback. Re-read a current skill only if needed for a new change. Preserve unknown charges and the original failure. Completion of this successor does not rewrite the old job or establish independent skill quality." };
  return { ref: `hermes-review-continuation:${contentHashOf(metadata)}`, metadata, transcript: checkpoint.transcript };
}
