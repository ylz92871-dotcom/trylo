import type { BoardCommand } from "../../../../control/commands.js";
import type { BoardState } from "../../../../control/state.js";
import { shortId } from "../../../../domains/shared/hash.js";
import type { VariantRecord } from "../domain/contracts.js";
import type { FeedbackInput, UseInput } from "../port.js";
import { methodUsageOf } from "../../../../control/method-usage.js";
import { experienceSourceOf } from "../domain/experience-source.js";
import { archived, projectMaturity, scopesOf } from "../domain/experience-state.js";

/**
 * M1 上场/反馈的纯构造与纯投影（无 IO）。
 *
 * 从 `board-writer.ts` 拆出：写口适配器只剩「读档检查 + 发命令」的编排，
 * 而命令形状与去重口径住在这里。体积预算（`loop/method-line-budget.test.ts`
 * 对 `board-writer.ts` 的 400 行上限）是拆分的直接原因，不是审美。
 */

export type FieldedSeen = {
  readonly turns: ReadonlySet<string>;
  /**
   * 最近一次上场在持久上场日志里的 **1-based 序号**（越大越新）。
   *
   * 单位是「日志次序」，不是 beat、也不是 turnId：beat 每个 turn 都从 1 重数，
   * 拿它当最近使用会让「turn-A beat=2 之后发生 turn-B beat=1」错判成 turn-A 更新
   * （E0M1 外部复核 P2-2）。`state.fieldings` 按 reducer 追加次序排列，等价于持久
   * 事件 sequence，所以最后出现的那一条的下标就是跨 turn 单调的最近使用序。
   */
  readonly lastSeq: number;
};

/**
 * 上场投影：`versionId -> { turns, lastSeq }`。
 *
 * 同一 `(turnId, versionId)` 只算一次上场（D-M1），同一 turn 内多拍的
 * `requestId` 明细保留在原记录里，不在这里展开。`lastSeq` 取该版本最后一条
 * 上场记录的日志序号——遍历是日志次序，所以「后写覆盖先写」自然得到最近一条。
 */
export function fieldedByVersion(state: BoardState): ReadonlyMap<string, FieldedSeen> {
  return methodUsageOf(state);
}

/**
 * 把上场投影折进变体档：有上场记录的版本 `uses` = 去重 turn 数，
 * `lastUsedSeq` = 最近一次上场的日志序号（越大越新）；无记录的版本原样保持
 * （旧档 unknown/0，不伪造活跃）。
 */
export function withUsesProjected(
  archive: ReadonlyArray<VariantRecord>,
  state: BoardState,
): ReadonlyArray<VariantRecord> {
  const fielded = methodUsageOf(state);
  const retention = new Map((state.methodRetentions ?? []).map(item => [item.versionId, item]));
  const experience = experienceSourceOf(state);
  const maturity = projectMaturity(experience);

  return archive.map((variant) => {
    const seen = fielded.get(variant.versionId);
    const lifecycle = retention.get(variant.versionId);
    const last = seen?.lastUsedAt;

    return {
      ...variant,
      layer: scopesOf(experience, variant.versionId).some(scope => maturity(scope.hypothesis) !== undefined)
        ? "stable" : lifecycle?.layer === "stable" ? "middle" : lifecycle?.layer ?? "working",
      retention: lifecycle?.retention ?? "retained",
      ledger: { ...variant.ledger, ...(archived(experience, variant.versionId) ? { state: "archived" as const } : {}),
        uses: seen?.turns.size ?? 0, lastUsedSeq: seen?.lastSeq ?? 0,
        fieldedCount: seen?.turns.size ?? 0, helpedCount: seen?.helpedTurns.size ?? 0,
        ...(last === undefined ? {} : { lastUsedAt: last }) },
    };
  });
}

export function useCommandOf(input: UseInput): BoardCommand {
  return {
    type: "record_method_fielding",
    commandId: shortId("method-use", [input.writeId, input.exposureId]),
    issuedAt: input.observedAt,
    exposureId: input.exposureId,
    versionId: input.versionId,
    proposalId: input.proposalId,
    turnId: input.turnId,
    beat: input.beat,
    requestId: input.requestId,
    scope: input.scope,
    ...(input.binding === undefined ? {} : { binding: input.binding }),
  };
}

export function feedbackCommandOf(input: FeedbackInput): BoardCommand {
  return {
    type: "record_method_feedback",
    commandId: shortId("method-feedback", [input.writeId, input.versionId, input.turnId, String(input.helped)]),
    issuedAt: input.observedAt,
    versionId: input.versionId,
    turnId: input.turnId,
    helped: input.helped,
    ...(input.exposureId === undefined ? {} : { exposureId: input.exposureId }),
    ...(input.providerAttemptId === undefined ? {} : { providerAttemptId: input.providerAttemptId }),
    ...(input.sourceEventId === undefined ? {} : { sourceEventId: input.sourceEventId }),
    ...(input.observation === undefined ? {} : { observation: input.observation }),
  };
}
