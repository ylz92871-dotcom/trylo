import type {
  RecordMethodFeedbackCommand,
  RecordMethodFieldingCommand,
} from "./commands.js";
import type { MethodFielding } from "./contracts.js";
import type { ReduceResult } from "./result.js";
import { fail, nextSeq, succeed } from "./result.js";
import type { BoardState } from "./state.js";
import { isMethodObservation } from "../agent/subsystems/method/domain/inference.js";
import { experienceSourceOf, validObservationBinding, validObservationRevision } from "../agent/subsystems/method/domain/experience-source.js";
import { isExposureBinding, validCompilationExposure } from "../agent/subsystems/method/domain/exposure-binding.js";

/**
 * 方法上场/反馈记账（M1，D-M1；归因/唯一性收紧见外审 P1-3）。
 *
 * 纯 reducer，做形状守卫、**关系守卫**与追加。三件事的归属：
 *
 * - 「反馈必须精确对应一次真实上场，且一次上场只有一条判决」由**这里**承担
 *   （外审 P1-3）：reducer 是每条路径——方法写口、直接命令、日志重放——唯一
 *   的 canonical 入口，且它总在 Board 写锁内运行，看到的是当下的 `state.fieldings`
 *   /`state.feedbacks`。把它放在写口侧的锁外预检里，既会被并发写穿越（TOCTOU），
 *   又会被直接命令/重放绕过。
 * - 「同 turn 同 version 去重计数、request 明细保留」由投影
 *   （`variantsOf` 按 `(turnId, versionId)` 去重）承担，这里每条合法
 *   exposure 原样追加；`commandId` 幂等仍由 `reduce` 入口保证。
 */
export function applyRecordMethodFielding(
  state: BoardState,
  command: RecordMethodFieldingCommand,
): ReduceResult {
  if (!isNonEmpty(command.exposureId) || !isNonEmpty(command.versionId)) {
    return fail(state, "invalid_fielding", command.exposureId || command.versionId || "empty");
  }

  if (!isNonEmpty(command.turnId) || !isNonEmpty(command.requestId) || !isNonEmpty(command.scope)) {
    return fail(state, "invalid_fielding", command.exposureId);
  }

  if (!Number.isInteger(command.beat) || command.beat <= 0) {
    return fail(state, "invalid_fielding", command.exposureId);
  }

  if (command.binding !== undefined && (!isExposureBinding(command.binding) || command.binding.context.taskId !== command.turnId)) {
    return fail(state, "invalid_fielding", "invalid_method_exposure_binding");
  }

  // Even an exposure invalidated during transmission remains an actual send.
  // Require its immutable compilation identity, not current default eligibility.
  if (!validCompilationExposure(state.methodExperienceFacts ?? [], command, state.sequence + 1)) {
    return fail(state, "invalid_fielding", "unknown_method_compilation");
  }

  const sequence = nextSeq(state);
  const fielding: MethodFielding = {
    useSequence: sequence,
    exposureId: command.exposureId,
    versionId: command.versionId,
    proposalId: command.proposalId,
    turnId: command.turnId,
    beat: command.beat,
    requestId: command.requestId,
    scope: command.scope,
    recordedAt: command.issuedAt,
    ...(command.binding === undefined ? {} : { binding: command.binding }),
  };

  return succeed(state, command.commandId, [
    {
      type: "method_fielding_recorded",
      sequence,
      commandId: command.commandId,
      occurredAt: command.issuedAt,
      fielding,
    },
  ], { fieldings: [...state.fieldings, fielding] });
}

export function applyRecordMethodFeedback(
  state: BoardState,
  command: RecordMethodFeedbackCommand,
): ReduceResult {
  if (!isNonEmpty(command.versionId) || !isNonEmpty(command.turnId)) {
    return fail(state, "invalid_feedback", command.versionId || command.turnId || "empty");
  }

  if (typeof command.helped !== "boolean") {
    return fail(state, "invalid_feedback", command.versionId);
  }

  // 关系守卫（外审 P1-3），全部读 canonical `state`，因此天然在写锁内、对每条入口
  // 一致。精确重放走不到这里——`reduce` 先按 `commandId` 去重。旧日志重放仍绿：状态
  // 机保证一条上场先于它的反馈落盘，所以反馈重放时它对回的那次展示已经在账上。
  const attributed = attributeFeedback(state.fieldings, command);
  if (attributed.kind === "unattributable") {
    // 孤儿：没有任何真实上场可对应（版本没上场过、attempt 对不上、反馈迟到/伪造）。
    // 保持 unknown，绝不落 helped 的 true/false。
    return fail(state, "feedback_unattributable", `${command.versionId}@${command.turnId}`);
  }

  if (attributed.kind === "ambiguous") {
    // 同一 (versionId, turnId) 有多次不同 exposure，而命令没带 exposureId 去指认其中
    // 一次：无法确定归给哪一次展示，拒绝而不是随手取第一条。
    return fail(state, "feedback_ambiguous", `${command.versionId}@${command.turnId}`);
  }

  const exposureId = attributed.exposureId;
  const observation = command.observation;
  if (observation !== undefined) {
    if (!isMethodObservation(observation) || observation.versionId !== command.versionId ||
      observation.taskId !== command.turnId ||
      !validObservationRevision(experienceSourceOf(state).observations, observation) ||
      !validObservationBinding(state, exposureId, observation)) {
      return fail(state, "invalid_feedback", "invalid_method_observation_revision");
    }
  }

  if (observation === undefined && state.feedbacks.some((feedback) => feedback.exposureId === exposureId)) {
    // 一次上场只承载一条判决。第二次对同一 exposure 的反馈——无论 helped 相同还是
    // 相反——都是冲突：与其让同一答案的两行分叉，不如拒掉后来者。
    return fail(state, "feedback_conflict", exposureId);
  }

  const sequence = nextSeq(state);
  const feedback = {
    feedbackSequence: sequence,
    versionId: command.versionId,
    turnId: command.turnId,
    helped: command.helped,
    // 归因后总带上 exposureId，于是账上每条反馈都可追溯到一次真实展示——即便命令
    // 本身没带（直接命令/无 exposure 反馈），也在这里被解析出来落盘。
    exposureId,
    ...(command.providerAttemptId === undefined ? {} : { providerAttemptId: command.providerAttemptId }),
    ...(command.sourceEventId === undefined ? {} : { sourceEventId: command.sourceEventId }),
    recordedAt: command.issuedAt,
    ...(observation === undefined ? {} : { observation }),
  };

  return succeed(state, command.commandId, [
    {
      type: "method_feedback_recorded",
      sequence,
      commandId: command.commandId,
      occurredAt: command.issuedAt,
      feedback,
    },
  ], { feedbacks: [...state.feedbacks, feedback] });
}

/** 一条反馈命令对一次真实上场的归因结果。 */
type FeedbackAttribution =
  | { readonly kind: "resolved"; readonly exposureId: string }
  | { readonly kind: "unattributable" }
  | { readonly kind: "ambiguous" };

/**
 * 把反馈对回一次已记录的上场（外审 P1-3；原写口侧 `attributeFeedback` 的收紧版）。
 *
 * - 命令带 `exposureId`：要求存在一条 `(exposureId, versionId, turnId)` 三者全等的
 *   上场——任一不符都不是同一次展示，判为孤儿；
 * - 命令不带 `exposureId`：按 `(versionId, turnId)` 找候选。0 条是孤儿；恰好 1 条
 *   （或多条但 exposureId 全同，即同一次展示的重放）解析出那一个 exposureId；**多条
 *   不同 exposure** 是 ambiguous——这正是原 `.find()` 取首个候选所掩盖的情形。
 */
function attributeFeedback(
  fieldings: ReadonlyArray<MethodFielding>,
  command: RecordMethodFeedbackCommand,
): FeedbackAttribution {
  if (command.exposureId !== undefined) {
    const match = fieldings.find(
      (fielding) =>
        fielding.exposureId === command.exposureId &&
        fielding.versionId === command.versionId &&
        fielding.turnId === command.turnId,
    );
    return match === undefined
      ? { kind: "unattributable" }
      : { kind: "resolved", exposureId: match.exposureId };
  }

  const candidates = fieldings.filter(
    (fielding) => fielding.versionId === command.versionId && fielding.turnId === command.turnId,
  );
  if (candidates.length === 0) {
    return { kind: "unattributable" };
  }

  const distinct = new Set(candidates.map((candidate) => candidate.exposureId));
  if (distinct.size > 1) {
    return { kind: "ambiguous" };
  }

  return { kind: "resolved", exposureId: candidates[0]!.exposureId };
}

function isNonEmpty(value: string): boolean {
  return value.length > 0;
}
