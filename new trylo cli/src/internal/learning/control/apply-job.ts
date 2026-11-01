import type {
  CompleteJobCommand,
  EnqueueJobCommand,
  FailJobCommand,
  StartJobCommand,
  RequeueJobCommand,
  TombstoneCommand,
} from "./commands.js";
import type { JobState, LearningJob } from "./contracts.js";
import type { ReduceResult } from "./result.js";
import { fail, nextSeq, succeed } from "./result.js";
import {
  findAsset,
  findJob,
  findJobByDedupe,
  findProposal,
  findTombstone,
  replaceById,
  type BoardState,
} from "./state.js";

const IN_FLIGHT: ReadonlySet<JobState> = new Set([
  "queued",
  "running",
  "waiting_approval",
  "waiting_evidence",
]);

export function applyEnqueueJob(
  state: BoardState,
  command: EnqueueJobCommand,
): ReduceResult {
  if (findJob(state, command.job.jobId)) {
    return fail(state, "duplicate_job", command.job.jobId);
  }
  const existing = findJobByDedupe(state, command.job.dedupeKey);
  if (existing !== undefined && IN_FLIGHT.has(existing.state)) {
    return fail(state, "job_dedupe_hit", existing.jobId);
  }
  const job: LearningJob = {
    ...command.job,
    state: "queued",
    attempt: 0,
    breakerOpen: false,
  };
  return jobChanged(state, command.commandId, command.issuedAt, job, [...state.jobs, job]);
}

export function applyStartJob(
  state: BoardState,
  command: StartJobCommand,
): ReduceResult {
  const job = findJob(state, command.jobId);
  if (job === undefined) {
    return fail(state, "job_not_found", command.jobId);
  }
  if (job.state !== "queued") {
    return fail(state, "illegal_transition", `${job.state}->start_job`);
  }
  if (job.breakerOpen) {
    return fail(state, "job_breaker_open", job.jobId);
  }
  const attempt = job.attempt + 1;
  if (attempt > job.maxAttempts) {
    return fail(state, "job_budget_exceeded", job.jobId);
  }
  const next: LearningJob = { ...job, state: "running", attempt };
  return replaceJob(state, command.commandId, command.issuedAt, next);
}

export function applyCompleteJob(
  state: BoardState,
  command: CompleteJobCommand,
): ReduceResult {
  const job = findJob(state, command.jobId);
  if (job === undefined) {
    return fail(state, "job_not_found", command.jobId);
  }
  if (job.state !== "running") {
    return fail(state, "illegal_transition", `${job.state}->complete_job`);
  }
  const next: LearningJob = { ...job, state: command.next };
  return replaceJob(state, command.commandId, command.issuedAt, next);
}

export function applyRequeueJob(state: BoardState, command: RequeueJobCommand): ReduceResult {
  const job = findJob(state, command.jobId);
  if (job === undefined) return fail(state, "job_not_found", command.jobId);
  if (job.state !== "waiting_evidence" || job.attempt !== command.expectedAttempt) {
    return fail(state, "illegal_transition", `${job.state}:${job.attempt}->requeue_job:${command.expectedAttempt}`);
  }
  if (job.breakerOpen || job.attempt >= job.maxAttempts) return fail(state, "job_budget_exceeded", job.jobId);
  return replaceJob(state, command.commandId, command.issuedAt, { ...job, state: "queued" });
}

export function applyFailJob(
  state: BoardState,
  command: FailJobCommand,
): ReduceResult {
  const job = findJob(state, command.jobId);
  if (job === undefined) {
    return fail(state, "job_not_found", command.jobId);
  }
  if (job.state !== "queued" && job.state !== "running") {
    return fail(state, "illegal_transition", `${job.state}->fail_job`);
  }
  const breakerOpen = job.attempt >= job.maxAttempts || command.terminal === "expired";
  const next: LearningJob = { ...job, state: command.terminal, breakerOpen };
  return replaceJob(state, command.commandId, command.issuedAt, next);
}

const TOMBSTONE_ENTITY_TYPES: ReadonlySet<string> = new Set([
  "proposal",
  "asset",
  "observation",
  "fragment",
]);

export function applyTombstone(
  state: BoardState,
  command: TombstoneCommand,
): ReduceResult {
  // entityType 来自命令（重放路径可能经 JSON 反序列化），运行期限定其取值，
  // 并按它限定作用范围：外审 P1-1 —— 不能拿一条 entityId 去同时影响
  // proposal 与 activation 两个空间。
  if (!TOMBSTONE_ENTITY_TYPES.has(command.entityType)) {
    return fail(state, "invalid_entity_type", command.entityType);
  }
  if (findTombstone(state, command.entityId)) {
    return fail(state, "tombstone_exists", command.entityId);
  }
  // 外审 R2 §3.3（原文 P1-R3）的最小 Board 侧修复：撤回只能作用于**存在且
  // 尚未终止**的目标。旧实现在目标不存在时照样写入 tombstone，于是「一条完全
  // 无关的撤回 draft」可以退休任意实体，生产搜索从可见变 0。
  //
  // Board 只拥有 proposals / assets / activations 三块实体空间；observation 与
  // fragment 由 knowledge / observation 存储拥有，Board 无法证明其存在性——
  // 不能证明存在就拒绝，而不是 fail open 地写一条退休记录。
  const target = tombstoneTarget(state, command);
  if (!target.ok) {
    return fail(state, target.reason, command.entityId);
  }
  const sequence = nextSeq(state);
  const tombstone = {
    entityId: command.entityId,
    entityType: command.entityType,
    boardSequence: sequence,
    reason: command.reason,
  };
  const { proposals, activations } = retireForTombstone(state, command, sequence);
  return succeed(state, command.commandId, [
    {
      type: "tombstone_written",
      sequence,
      commandId: command.commandId,
      occurredAt: command.issuedAt,
      tombstone,
    },
  ], { tombstones: [...state.tombstones, tombstone], proposals, activations });
}

/**
 * tombstone 的连带效果：按 entityType 限定作用范围（外审 P1-1），
 * 逐步退休 proposal 状态与对应 activation 指针
 * （§10 单函数长度纪律：`applyTombstone` 曾因此超 70 行）。
 */
function retireForTombstone(
  state: BoardState,
  command: TombstoneCommand,
  sequence: number,
): { readonly proposals: BoardState["proposals"]; readonly activations: BoardState["activations"] } {
  const isProposal = command.entityType === "proposal";
  const proposal = isProposal ? findProposal(state, command.entityId) : undefined;
  const rejected = proposal === undefined
    ? undefined
    : { ...proposal, lifecycle: "rejected" as const };
  const proposals = rejected === undefined
    ? state.proposals
    : replaceById(
        state.proposals,
        (item) => item.proposalId === rejected.proposalId,
        rejected,
      );
  const activations = !isProposal && command.entityType !== "asset"
    ? state.activations
    : state.activations.map((item) => {
        if (isProposal) {
          const asset = state.assets.find((entry) => entry.versionId === item.versionId);
          if (asset?.createdFromProposalId !== command.entityId) {
            return item;
          }
        } else if (item.versionId !== command.entityId) {
          return item;
        }
        return {
          ...item,
          pointer: "retired" as const,
          generation: item.generation + 1,
          boardSequence: sequence,
        };
      });
  return { proposals, activations };
}

type TombstoneTargetCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "tombstone_target_not_found" | "tombstone_target_retired" | "tombstone_target_out_of_scope" };

/**
 * 目标合法性门：存在 + 未终止 + 类型匹配。三个失败各自有显式 reason，
 * 便于审计区分「攻击」与「用户重复撤回」。
 */
function tombstoneTarget(
  state: BoardState,
  command: TombstoneCommand,
): TombstoneTargetCheck {
  if (command.entityType === "proposal") {
    const proposal = findProposal(state, command.entityId);
    if (proposal === undefined) {
      return { ok: false, reason: "tombstone_target_not_found" };
    }
    if (isTerminal(proposal.lifecycle)) {
      return { ok: false, reason: "tombstone_target_retired" };
    }
    return { ok: true };
  }
  if (command.entityType === "asset") {
    const asset = findAsset(state, command.entityId);
    if (asset === undefined) {
      return { ok: false, reason: "tombstone_target_not_found" };
    }
    const activation = state.activations.find((item) => item.versionId === command.entityId);
    if (activation?.pointer === "retired") {
      return { ok: false, reason: "tombstone_target_retired" };
    }
    return { ok: true };
  }
  // observation / fragment：Board 不拥有这两块空间，无法证明目标存在。
  // 这与「Board 拥有但查不到」是两件事，失败码必须区分，审计才能分辨
  // 「攻击者拿跨空间类型试探」与「用户对已删除实体重复撤回」。
  return { ok: false, reason: "tombstone_target_out_of_scope" };
}

function replaceJob(
  state: BoardState,
  commandId: string,
  occurredAt: string,
  job: LearningJob,
): ReduceResult {
  return jobChanged(
    state,
    commandId,
    occurredAt,
    job,
    replaceById(state.jobs, (item) => item.jobId === job.jobId, job),
  );
}

function jobChanged(
  state: BoardState,
  commandId: string,
  occurredAt: string,
  job: LearningJob,
  jobs: LearningJob[],
): ReduceResult {
  const sequence = nextSeq(state);
  return succeed(state, commandId, [
    {
      type: "job_changed",
      sequence,
      commandId,
      occurredAt,
      job,
    },
  ], { jobs });
}

function isTerminal(lifecycle: string): boolean {
  return (
    lifecycle === "rejected" ||
    lifecycle === "retired" ||
    lifecycle === "rolled_back"
  );
}
