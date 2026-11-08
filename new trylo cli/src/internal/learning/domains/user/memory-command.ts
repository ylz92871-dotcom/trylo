import type { MemoryFactKind, MemoryScope } from "./memory-fact.js";

/**
 * 显式记忆请求的结果。
 *
 * 六个分支对应六种真实结局，任何一种都不能冒充另一种：存下了才叫 `saved`，
 * 关着叫 `disabled`，存了但没资格上场叫 `saved` + `effective: false`。把
 * "已经写进账本" 与 "已经影响行为" 合成一个布尔，是让模型说出"记好了"的最短路径。
 */
export const MEMORY_REJECT_REASONS = [
  /** 来源不是用户本人（工具输出、网页、assistant 自述）。 */
  "source_not_user",
  /** 提交的命题在本轮用户原话里找不到，不能凭模型改写当作用户明令。 */
  "statement_not_grounded",
  /** 作用域不属于当前 run（别人的 user 域、别的工作区）。 */
  "scope_not_permitted",
  /** 同一 commandId 提交了不同内容。 */
  "command_conflict",
  /** 修改/撤回的版本已经不是最新。 */
  "version_conflict",
  "record_not_found",
  "invalid_arguments",
  "schema_unsupported",
] as const;

export type MemoryRejectReason = (typeof MEMORY_REJECT_REASONS)[number];

export type MemoryCommandResult =
  | {
      readonly result: "saved";
      readonly recordId: string;
      readonly version: number;
      readonly scope: MemoryScope;
      readonly factKind: MemoryFactKind;
      /** 是否已参与检索；`false` 表示存下了但还没上场。 */
      readonly effective: boolean;
    }
  | { readonly result: "already_saved"; readonly recordId: string; readonly version: number }
  | { readonly result: "pending"; readonly proposalId: string; readonly reason: string }
  | { readonly result: "disabled"; readonly setting: string }
  | { readonly result: "rejected"; readonly reason: MemoryRejectReason; readonly message: string }
  | { readonly result: "failed"; readonly reason: string; readonly retryable: boolean };

/**
 * 给模型看的回执文字。
 *
 * 回执必须在最终成功话术之前可读——模型拿不到 `saved` 就不能说"记好了"。
 * 这里给出的是**唯一**允许的措辞基准，工具返回值同时带结构化字段，便于 Desktop
 * 与测试核对同一件事。
 */
export function memoryReceiptText(result: MemoryCommandResult): string {
  switch (result.result) {
    case "saved":
      return result.effective
        ? `已保存到 Trylo 用户记忆（${result.recordId} v${result.version}），后续会话可以检索到。`
        : `已保存到 Trylo 用户记忆（${result.recordId} v${result.version}），尚未参与本轮行为。`;
    case "already_saved":
      return `这条已经保存过了（${result.recordId} v${result.version}），本次没有重复写入。`;
    case "pending":
      return `已提交，待确认（${result.proposalId}）：${result.reason}。尚未保存。`;
    case "disabled":
      return `当前未保存：${result.setting} 未开启用户学习。`;
    case "rejected":
      return `未保存：${result.message}`;
    case "failed":
      return `保存失败：${result.reason}${result.retryable ? "（可以重试）" : ""}。`;
  }
}

/** 结构化结果能否被称作"已经记住"。 */
export function isMemorySaved(result: MemoryCommandResult): boolean {
  return result.result === "saved" || result.result === "already_saved";
}
