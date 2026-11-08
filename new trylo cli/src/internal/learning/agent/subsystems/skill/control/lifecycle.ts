import type { BoardState } from "../../../../control/state.js";
import { learningIssueOwner } from "../../../../control/learning-issue-owner.js";
import { contentHashOf } from "../../../../control/hash.js";
import type { JsonObject } from "../../../../../protocol/envelope.js";
import type { ContentDomainFeedbackChange } from "../../../../../integration/learning-content/sources/domain-feedback.js";
import { identity } from "../../../../../validation/json-shape.js";
import { isSkillLifecycleObservation, readSkillLifecycleFacts, skillLifecycleDraft,
  type SkillLifecycleBinding, type SkillLoadObservation } from "./lifecycle-facts.js";

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

export function hasNativeSkillCommit(reply: unknown): boolean {
  return record(reply) && reply.ok === true && record(reply.result) && reply.result.success === true
    && reply.result.committed === true && reply.result.kept_pending === false;
}

/** Only the original successful native transaction can produce this draft.
 * A missing pending item, backup reason or current skill name is insufficient. */
export function skillApprovalDraft(input: { readonly board: BoardState; readonly pendingId: string;
  readonly expectedHash: string; readonly reply: unknown; readonly at: string }) {
  if (!identity(input.pendingId) || !hasNativeSkillCommit(input.reply) || !record(input.reply) || !record(input.reply.result)) return undefined;

  const native = input.reply.result;
  if (native.pendingId !== input.pendingId || native.payloadHash !== input.expectedHash) return undefined;

  const pendingRef = `hermes-pending:skills:${input.pendingId}`;
  const matches = input.board.jobs.flatMap(job => {
    if (!job.coordination?.resultRefs?.includes(pendingRef)) return [];

    const grant = input.board.centralLearningGrants?.find(item => item.grantId === job.coordination?.grantId
      && item.jobId === job.jobId && item.issueId === job.coordination.issueId && item.domain === "skill" && item.budgetId !== undefined);
    if (grant === undefined) return [];

    const issue = input.board.learningIssues?.find(item => item.issueId === grant.issueId && item.scope === grant.scope
      && learningIssueOwner(item) === "skill");

    return issue === undefined ? [] : [{ issue, grant, job }];
  });
  if (matches.length !== 1) return undefined;

  const { issue, grant, job } = matches[0]!;
  const raw = { schemaVersion: 1, kind: "native_approved", at: input.at, issueId: issue.issueId, grantId: grant.grantId,
    jobId: job.jobId, pendingRef, payloadHash: native.payloadHash, action: native.action, name: native.skillName,
    instructionHash: native.instructionHash };

  // The persisted payload guard is also the native receipt conversion boundary.
  return approvalValue(issue.scope, raw);
}

function approvalValue(scope: string, raw: unknown) {
  return isSkillLifecycleObservation(raw) && raw.kind === "native_approved" ? skillLifecycleDraft(scope, raw) : undefined;
}

export type SkillInstructionLoad = Pick<SkillLoadObservation, "at" | "name" | "instructionHash" | "renderedContentHash"
  | "sessionId" | "turnId" | "toolCallId" | "transcriptSequence" | "journalSequence">;

function readBoundLifecycle(board: BoardState, scope: string) {
  const parsed = readSkillLifecycleFacts(board.rewardV2Facts ?? [], scope);
  if (parsed.status !== "ready") return parsed;

  const validBinding = (binding: SkillLifecycleBinding) => {
    const grant = board.centralLearningGrants?.find(item => item.grantId === binding.grantId && item.scope === scope
      && item.issueId === binding.issueId && item.jobId === binding.jobId && item.domain === "skill" && item.budgetId !== undefined);
    const job = board.jobs.find(item => item.jobId === binding.jobId && item.scope === scope && item.domain === "skill"
      && item.coordination?.grantId === binding.grantId && item.coordination.issueId === binding.issueId
      && item.coordination.resultRefs?.includes(binding.pendingRef));

    return grant !== undefined && job !== undefined && board.learningIssues?.some(issue => issue.issueId === binding.issueId
      && issue.scope === scope && learningIssueOwner(issue) === "skill") === true;
  };

  return parsed.records.every(row => validBinding(row.observation)) ? parsed
    : { status: "invalid" as const, reason: "hermes_lifecycle_source_binding" };
}

export function skillInstructionLoadDrafts(board: BoardState, scope: string, loads: readonly SkillInstructionLoad[]) {
  const parsed = readBoundLifecycle(board, scope);
  if (parsed.status !== "ready") return parsed;

  const drafts = loads.flatMap(load => {
    const approved = parsed.records.filter(row =>
      row.observation.kind === "native_approved" && ["create", "edit", "patch"].includes(row.observation.action)
      && row.observation.name === load.name && row.observation.instructionHash === load.instructionHash
      && Date.parse(row.observation.at) < Date.parse(load.at)).at(-1);
    if (approved?.observation.kind !== "native_approved") return [];

    const prior = approved.observation;
    const draft = skillLifecycleDraft(scope, { schemaVersion: 1, kind: "instruction_loaded", ...load,
      approvalRef: approved.fact.id, issueId: prior.issueId, grantId: prior.grantId, jobId: prior.jobId, pendingRef: prior.pendingRef });

    return draft === undefined || board.rewardV2Facts?.some(fact => fact.id === draft.id) ? [] : [draft];
  });

  return { status: "ready" as const, drafts };
}

/** Source-bound factual follow-up for public central context. Neither approval nor
 * an instruction load supplies an economic outcome or independent task verdict. */
export function skillLifecycleProjection(board: BoardState, scope: string, issueId: string):
  { readonly sourceRef: string; readonly sourceRefs: readonly string[]; readonly records: readonly JsonObject[] }
  | undefined {
  const issue = board.learningIssues?.find(item => item.issueId === issueId && item.scope === scope && learningIssueOwner(item) === "skill");
  if (issue === undefined) return undefined;

  const parsed = readBoundLifecycle(board, scope);
  if (parsed.status !== "ready") throw new Error(parsed.reason);

  const rows = parsed.records.filter(row => row.observation.issueId === issueId);
  const records: JsonObject[] = rows.map(({ fact, observation }) => ({ ...observation, sourceRef: fact.id,
    interpretation: observation.kind === "native_approved"
      ? "Native pending approval committed this exact payload. This is not an instruction load, task success or measured benefit."
      : "A later complete normal-task skill_view loaded this exact approved raw instruction hash. Rendered text may include native template substitution. This is not verified application or task success." }));
  const sourceRefs = rows.flatMap(row => [row.fact.id, row.observation.pendingRef, row.observation.jobId, row.observation.grantId]);

  return { sourceRef: `hermes-lifecycle-projection:${contentHashOf([scope, issueId, records])}`,
    sourceRefs: [...new Set([issueId, ...sourceRefs])], records };
}

/** Format one exact original lifecycle fact from its already bound owner frame.
 * Projection prose and frame identity do not belong to the native observation. */
export function readSkillLifecycleFeedbackUnit(frame: { readonly records: readonly JsonObject[] }, change: ContentDomainFeedbackChange):
  { readonly kind: "found"; readonly recordKind: "native_approved" | "instruction_loaded";
    readonly payload: JsonObject; readonly sourceRefs: readonly string[] } | { readonly kind: "missing" } {
  if (change.domain !== "skill" || change.factRef !== change.revisionRef) return { kind: "missing" };

  for (const row of frame.records) {
    const matchesKind = row.kind === "native_approved" && change.kind === "approval"
      || row.kind === "instruction_loaded" && change.kind === "delivery";
    if (row.sourceRef !== change.factRef || row.pendingRef !== change.unitRef || row.issueId !== change.issueId
      || !matchesKind) continue;

    const { sourceRef: _sourceRef, interpretation: _interpretation, ...payload } = row;

    if (!isSkillLifecycleObservation(payload)) return { kind: "missing" };

    return { kind: "found", recordKind: payload.kind, payload,
      sourceRefs: [...new Set([change.factRef, payload.pendingRef, payload.grantId, payload.jobId,
        ...(payload.kind === "instruction_loaded" ? [payload.approvalRef] : [])])] };
  }

  return { kind: "missing" };
}
